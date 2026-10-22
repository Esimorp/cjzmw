import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import type { NextFunction, Request, Response, Router } from 'express'
import {
  buildTimedSegments,
  buildUnmatchedToken,
  expandRawAsrItems,
  mapSegmentTokens,
  normalizeRawAsrItems,
  parseSrtCaptions,
  parseTranscriptSegments,
} from './src/subtitle-timing.ts'
import type { ParsedCaption } from './src/subtitle-timing.ts'
import type { RawAsrItem, SubtitleSegment, SubtitleToken } from './src/subtitle-types.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const RUNTIME_DIR = process.env.QWEN_ASR_DIR
  ? path.resolve(process.env.QWEN_ASR_DIR)
  : path.join(__dirname, 'lib', 'qwen')
/** Project virtualenv interpreter — the worker runs the source package. */
const VENV_PYTHON = process.env.QWEN_PYTHON
  ? path.resolve(process.env.QWEN_PYTHON)
  : path.join(__dirname, '.venv', 'Scripts', 'python.exe')
/** Tracked worker script (never the frozen transcribe.exe). */
const WORKER_SCRIPT = path.join(__dirname, 'python', 'qwen_worker.py')

/** Upper bounds for the alignment snapshot posted by the client. */
const ALIGN_MAX_SEGMENTS = 400
const ALIGN_MAX_TOKENS = 4000
/** JSON body limit for the align snapshot endpoint. */
const ALIGN_BODY_LIMIT = '512kb'

/** One CPU inference at a time; a second request is queued (bounded). */
const MAX_QUEUED_JOBS = 4
/** Hard ceiling for a single transcription, enforced with a killed process tree. */
const JOB_TIMEOUT_MS = 30 * 60 * 1000
/** How long a finished job stays queryable before it is dropped. */
const COMPLETED_JOB_TTL_MS = 30 * 60 * 1000
const MAX_LOG_TAIL_LINES = 40
const MAX_LOG_LINE_LENGTH = 400
/** Bounded wait for an in-flight job to unwind during shutdown/cleanup. */
const SHUTDOWN_JOB_GRACE_MS = 5000
const SHUTDOWN_POLL_MS = 50

type AsrJobStatus = 'queued' | 'running' | 'completed' | 'failed'
/** A job is either a transcription or a force alignment over supplied text. */
type JobKind = 'asr' | 'align'

interface JobLog {
  stream: 'stdout' | 'stderr'
  line: string
}

interface AsrJobRecord {
  id: string
  videoId: string
  kind: JobKind
  status: AsrJobStatus
  createdAt: number
  startedAt?: number
  finishedAt?: number
  dir?: string
  log: JobLog[]
  /** Exact client snapshot for alignment jobs; never resegmented. */
  align?: AlignRequestSnapshot
  error?: { code: string; message: string }
  result?: AsrJobResult
  controller?: AbortController
  /** Currently running child process of this job (tracked for tree kills). */
  current?: { child?: ChildProcess }
}

export interface AsrJobResult {
  kind: JobKind
  text: string
  srt: string
  raw: RawAsrItem[]
  segments: SubtitleSegment[]
  durationMs: number
}
/** A job as exposed over HTTP — never contains filesystem paths. */
interface AsrJobResponse {
  id: string
  videoId: string
  kind: JobKind
  status: AsrJobStatus
  queuedAt: string
  startedAt?: string
  finishedAt?: string
  /** 1-based position while the job is waiting behind another inference. */
  queuePosition?: number
  error?: { code: string; message: string }
  log?: JobLog[]
  result?: AsrJobResult
}

interface AsrServiceDependencies {
  /** Resolve the registered media file of a video id, or `undefined`. */
  resolveVideoFile: (videoId: string) => string | undefined
  /** True while the video is referenced by a running or queued ASR job. */
  isVideoBusy: (videoId: string) => boolean
}

export interface AsrService {
  router: Router
  /**
   * True while a queued or running job references the video id. The media
   * router pins such videos so a running job never loses its input file.
   */
  hasActiveJobForVideo: (videoId: string) => boolean
  /** Cancel queued/running jobs and remove the job work directory. */
  cleanup: () => Promise<void>
  /** Stop queued/running jobs without touching files (used on shutdown). */
  stop: () => Promise<void>
}

/** Errors carrying a localized message that is safe to send to the client. */
class AsrError extends Error {
  readonly code: string
  readonly status: number

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'AsrError'
    this.code = code
    this.status = status
  }
}

/** Parse the worker's UTF-8 result JSON; malformed output is a hard failure. */
export function parseWorkerResult(json: string): {
  raw: RawAsrItem[]
  transcript?: string
  srt?: string
} {
  if (json.trim() === '') {
    throw new AsrError(500, 'WORKER_NO_RESULT', '识别工作进程没有输出结果。')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new AsrError(500, 'WORKER_NO_RESULT', '识别工作进程输出格式无效。')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new AsrError(500, 'WORKER_NO_RESULT', '识别工作进程输出格式无效。')
  }
  const body = parsed as { raw?: unknown; transcript?: unknown; srt?: unknown }
  const raw = Array.isArray(body.raw) ? (body.raw as RawAsrItem[]) : []
  return {
    raw,
    transcript: typeof body.transcript === 'string' ? body.transcript : undefined,
    srt: typeof body.srt === 'string' ? body.srt : undefined,
  }
}

/** One token of the client's subtitle snapshot, kept verbatim. */
interface AlignTokenSnapshot {
  id: string
  text: string
}

/** One segment of the client's subtitle snapshot, kept verbatim. */
interface AlignSegmentSnapshot {
  id: string
  tokens: AlignTokenSnapshot[]
}

/** Validated alignment request: the exact strings and ids to map back onto. */
interface AlignRequestSnapshot {
  segments: AlignSegmentSnapshot[]
  text: string
  tokenCount: number
}

/**
 * Validate the alignment snapshot posted by the client.
 *
 * Ids must be unique and the text must be non-empty. The snapshot is kept
 * verbatim so the response can be mapped back onto the exact same token
 * strings and ids — the server never resegments or rewrites the text.
 */
export function validateAlignSnapshot(body: unknown): AlignRequestSnapshot {
  if (!body || typeof body !== 'object') {
    throw new AsrError(400, 'ALIGN_INVALID', '对齐请求格式无效。')
  }
  const segments = (body as { segments?: unknown }).segments
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new AsrError(400, 'EMPTY_SUBTITLES', '没有可对齐的字幕，请先导入或识别字幕。')
  }
  if (segments.length > ALIGN_MAX_SEGMENTS) {
    throw new AsrError(400, 'ALIGN_TOO_MANY_SEGMENTS', `字幕段数超过上限 ${ALIGN_MAX_SEGMENTS}。`)
  }

  const seenSegmentIds = new Set<string>()
  const seenTokenIds = new Set<string>()
  const lines: string[] = []
  const tokens: string[] = []
  const outSegments: AlignSegmentSnapshot[] = []

  for (const rawSegment of segments) {
    if (!rawSegment || typeof rawSegment !== 'object') {
      throw new AsrError(400, 'ALIGN_INVALID', '对齐请求格式无效。')
    }
    const segment = rawSegment as { id?: unknown; tokens?: unknown }
    if (typeof segment.id !== 'string' || segment.id === '') {
      throw new AsrError(400, 'ALIGN_INVALID', '对齐请求格式无效。')
    }
    if (!Array.isArray(segment.tokens)) {
      throw new AsrError(400, 'ALIGN_INVALID', '对齐请求格式无效。')
    }
    if (seenSegmentIds.has(segment.id)) {
      throw new AsrError(400, 'ALIGN_DUPLICATE_ID', '对齐请求包含重复的字幕段标识。')
    }
    seenSegmentIds.add(segment.id)

    const outTokens: AlignTokenSnapshot[] = []
    const texts: string[] = []
    for (const rawToken of segment.tokens) {
      if (!rawToken || typeof rawToken !== 'object') {
        throw new AsrError(400, 'ALIGN_INVALID', '对齐请求格式无效。')
      }
      const token = rawToken as { id?: unknown; text?: unknown }
      if (typeof token.id !== 'string' || token.id === '') {
        throw new AsrError(400, 'ALIGN_INVALID', '对齐请求格式无效。')
      }
      if (typeof token.text !== 'string') {
        throw new AsrError(400, 'ALIGN_INVALID', '对齐请求格式无效。')
      }
      if (seenTokenIds.has(token.id)) {
        throw new AsrError(400, 'ALIGN_DUPLICATE_ID', '对齐请求包含重复的字幕标识。')
      }
      seenTokenIds.add(token.id)
      if (token.text.trim() === '') continue
      outTokens.push({ id: token.id, text: token.text })
      texts.push(token.text)
      tokens.push(token.text)
    }

    if (outTokens.length === 0) continue
    outSegments.push({ id: segment.id, tokens: outTokens })
    lines.push(texts.join(' '))
  }

  if (outSegments.length === 0 || tokens.length === 0) {
    throw new AsrError(400, 'EMPTY_SUBTITLES', '没有可对齐的字幕，请先导入或识别字幕。')
  }
  if (tokens.length > ALIGN_MAX_TOKENS) {
    throw new AsrError(400, 'ALIGN_TOO_MANY_TOKENS', `字幕词数超过上限 ${ALIGN_MAX_TOKENS}。`)
  }

  const text = lines.join('\n')
  const meaningful = tokens.join('').replace(/\s+/gu, '')
  if (!/[\p{L}\p{N}]/u.test(meaningful)) {
    throw new AsrError(400, 'EMPTY_SUBTITLES', '字幕没有可对齐的文字内容。')
  }

  return { segments: outSegments, text, tokenCount: tokens.length }
}

/**
 * Map raw aligner items onto the client's exact tokens.
 *
 * The aligner emits one item per character (plus zero-duration punctuation
 * gap items). Tokens are consumed in order from a forward pointer so repeated
 * text never reuses an earlier item, and no token text is ever rewritten.
 * A token whose characters cannot all be matched stays unmatched (`null`).
 */
export function mapAlignSnapshot(
  snapshot: AlignRequestSnapshot,
  raw: readonly RawAsrItem[],
  segmentPrefix = 'align',
): SubtitleSegment[] {
  const chars = expandRawAsrItems(normalizeRawAsrItems(raw))
  let pointer = 0
  let segmentIndex = 0

  return snapshot.segments.map((segment) => {
    segmentIndex += 1
    let tokenIndex = 0
    const tokens: SubtitleToken[] = segment.tokens.map((token) => {
      tokenIndex += 1
      const tokenPrefix = `${segmentPrefix}-${segmentIndex}-t${tokenIndex}`
      const result = mapSegmentTokens(chars, [{ text: token.text }], {
        tokenIdPrefix: tokenPrefix,
        startIndex: pointer,
      })
      pointer = result.nextIndex
      const mapped = result.tokens[0]
      if (!mapped) return buildUnmatchedToken(token.id, token.text)
      return {
        ...mapped,
        id: token.id,
        text: token.text,
      }
    })

    const out: SubtitleSegment = { id: segment.id, tokens }
    const first = tokens.find((token) => token.start !== null)
    const last = [...tokens].reverse().find((token) => token.end !== null)
    if (first && first.start !== null) out.start = first.start
    if (last && last.end !== null) out.end = last.end
    return out
  })
}

/** Abort signal used to unwind a cancelled or timed-out child process. */
function createAbortError(): Error {
  const error = new Error('Aborted')
  error.name = 'AbortError'
  return error
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || (error as { code?: string }).code === 'ABORT_ERR')
  )
}

/** Append a bounded log line to a job, dropping the oldest entries. */
export function appendBoundedLog(job: { log: JobLog[] }, stream: JobLog['stream'], chunk: string): void {
  const lines = chunk.split(/\r\n|\r|\n/)
  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    if (line === '') continue
    job.log.push({
      stream,
      line: line.length > MAX_LOG_LINE_LENGTH ? `${line.slice(0, MAX_LOG_LINE_LENGTH)}…` : line,
    })
  }
  while (job.log.length > MAX_LOG_TAIL_LINES) job.log.shift()
}

/**
 * Last structured worker failure, e.g. `{"code":"ALIGN_AUDIO_TOO_LONG",...}`.
 * The worker writes exactly one such JSON line to stderr before exiting.
 */
export function readWorkerError(
  job: { log: JobLog[] },
): { code: string; message: string } | null {
  for (let index = job.log.length - 1; index >= 0; index -= 1) {
    const entry = job.log[index]
    if (entry.stream !== 'stderr' || !entry.line.startsWith('{')) continue
    try {
      const parsed = JSON.parse(entry.line) as { code?: unknown; message?: unknown }
      if (
        typeof parsed.code === 'string' &&
        typeof parsed.message === 'string' &&
        parsed.message.trim() !== ''
      ) {
        return { code: parsed.code, message: parsed.message }
      }
    } catch {
      // Not the structured error line; keep looking further up.
    }
  }
  return null
}

/** Last stderr line, appended to a crash report so native aborts stay visible. */
export function lastStderrHint(job: { log: JobLog[] }): string {
  for (let index = job.log.length - 1; index >= 0; index -= 1) {
    const entry = job.log[index]
    if (entry.stream === 'stderr' && entry.line.trim() !== '') {
      return ` ${entry.line.trim()}`
    }
  }
  return ''
}

/**
 * Terminate a tracked process and its children.
 *
 * On Windows the transcription runtime spawns helper worker processes, so the
 * whole tree has to be killed. `taskkill` is spawned with `windowsHide` and no
 * shell; the POSIX branch only ever signals the tracked pid group.
 */
export function killProcessTree(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      // Without an error listener a missing taskkill (or an already-exited
      // child) would surface as an unhandled 'error' event.
      killer.on('error', (error) => {
        console.error('Failed to kill ASR process tree:', error)
      })
      killer.unref()
    } catch (error) {
      console.error('Failed to kill ASR process tree:', error)
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      console.error('Failed to kill ASR process:', error)
    }
  }
}

export async function createAsrService(deps: AsrServiceDependencies): Promise<AsrService> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cjzmw-asr-'))
  const jobs = new Map<string, AsrJobRecord>()
  const queue: AsrJobRecord[] = []
  let active: AsrJobRecord | null = null
  // Resolves when the in-flight job has fully unwound (its process closed and
  // its directory no longer needed). Shutdown awaits this before deleting.
  let activeDone: Promise<void> = Promise.resolve()
  let closing = false

  /**
   * True while the video is referenced by a job whose process may still be
   * reading the file. `active` is checked separately because a cancelled job is
   * removed from the map immediately, yet its child process may still hold the
   * file open until `runJob` reaches its `finally` block.
   */
  function hasActiveJobForVideo(videoId: string): boolean {
    if (active && active.videoId === videoId) return true
    for (const job of jobs.values()) {
      if (job.videoId !== videoId) continue
      if (job.status === 'queued' || job.status === 'running') return true
    }
    return false
  }

  function findJob(id: string): AsrJobRecord | undefined {
    return jobs.get(id)
  }
  function removeJob(job: AsrJobRecord): void {
    jobs.delete(job.id)
    const index = queue.indexOf(job)
    if (index >= 0) queue.splice(index, 1)
  }

  /** Drop finished jobs that are older than the response TTL. */
  function purgeExpired(): void {
    const now = Date.now()
    for (const job of jobs.values()) {
      if (job.status !== 'completed' && job.status !== 'failed') continue
      if (now - (job.finishedAt ?? job.createdAt) < COMPLETED_JOB_TTL_MS) continue
      removeJob(job)
    }
  }

  /** Retire a finished job's work directory once nobody can read it anymore. */
  function scheduleJobExpiry(job: AsrJobRecord): void {
    const timer = setTimeout(() => {
      if (jobs.get(job.id) !== job) return
      jobs.delete(job.id)
      void removeDir(job.dir)
    }, COMPLETED_JOB_TTL_MS)
    timer.unref()
  }

  async function removeDir(dir: string | undefined): Promise<void> {
    if (!dir) return
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (error) {
      console.error('Failed to remove ASR job directory:', error)
    }
  }

  function toResponse(job: AsrJobRecord): AsrJobResponse {
    const response: AsrJobResponse = {
      id: job.id,
      videoId: job.videoId,
      kind: job.kind,
      status: job.status,
      queuedAt: new Date(job.createdAt).toISOString(),
    }
    if (job.startedAt !== undefined) response.startedAt = new Date(job.startedAt).toISOString()
    if (job.finishedAt !== undefined) {
      response.finishedAt = new Date(job.finishedAt).toISOString()
    }
    if (job.status === 'queued') {
      const position = queue.indexOf(job)
      if (position >= 0) response.queuePosition = position + 1
    }
    if (job.error) response.error = job.error
    if (job.log.length > 0) response.log = job.log
    if (job.status === 'completed' && job.result) response.result = job.result
    return response
  }

  async function runFfmpeg(
    input: string,
    output: string,
    signal: AbortSignal,
    current: { child?: ChildProcess },
  ): Promise<void> {
    const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
    const args = [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-y',
      '-i',
      input,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      output,
    ]
    await runProcess({
      command: ffmpeg,
      args,
      cwd: path.dirname(output),
      signal,
      onLine: () => undefined,
      notFoundMessage: '服务器上未安装 FFmpeg，无法提取音频。',
      notFoundCode: 'FFMPEG_UNAVAILABLE',
      current,
    })
  }

  interface RunProcessOptions {
    command: string
    args: string[]
    cwd: string
    signal: AbortSignal
    env?: NodeJS.ProcessEnv
    onLine: (stream: JobLog['stream'], chunk: string) => void
    notFoundMessage: string
    notFoundCode: string
    /** Registered so cancelling a job can kill the tracked process tree. */
    current?: { child?: ChildProcess }
  }

  function runProcess(options: RunProcessOptions): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let child: ChildProcess
      try {
        child = spawn(options.command, options.args, {
          cwd: options.cwd,
          windowsHide: true,
          shell: false,
          env: options.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        if (options.current !== undefined) options.current.child = child
      } catch (error) {
        const spawnError = error as NodeJS.ErrnoException
        if (spawnError.code === 'ENOENT') {
          reject(new AsrError(503, options.notFoundCode, options.notFoundMessage))
          return
        }
        reject(error)
        return
      }

      const onAbort = () => {
        if (child.pid !== undefined) killProcessTree(child.pid)
      }
      options.signal.addEventListener('abort', onAbort, { once: true })

      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        options.signal.removeEventListener('abort', onAbort)
        child.stdout?.removeAllListeners()
        child.stderr?.removeAllListeners()
        child.removeAllListeners()
        if (error) reject(error)
        else resolve()
      }

      child.stdout?.on('data', (chunk: Buffer | string) => options.onLine('stdout', chunk.toString()))
      child.stderr?.on('data', (chunk: Buffer | string) => options.onLine('stderr', chunk.toString()))

      child.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          finish(new AsrError(503, options.notFoundCode, options.notFoundMessage))
          return
        }
        finish(error)
      })

      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (options.signal.aborted) {
          finish(createAbortError())
          return
        }
        if (code === 0) {
          finish()
          return
        }
        finish(
          new AsrError(
            500,
            'ASR_RUNTIME_FAILED',
            `语音识别进程异常退出（代码 ${code ?? signal ?? '未知'}）。`,
          ),
        )
      })
    })
  }

  async function readOptionalText(filePath: string): Promise<string> {
    try {
      return await fs.readFile(filePath, 'utf-8')
    } catch {
      return ''
    }
  }

  async function runJob(job: AsrJobRecord): Promise<void> {
    if (closing) {
      job.status = 'failed'
      job.error = { code: 'SERVER_SHUTDOWN', message: '服务器正在关闭，语音识别任务已取消。' }
      job.finishedAt = Date.now()
      return
    }

    const videoFile = deps.resolveVideoFile(job.videoId)
    if (!videoFile) {
      job.status = 'failed'
      job.error = { code: 'VIDEO_NOT_FOUND', message: '视频已不存在，无法进行语音识别。' }
      job.finishedAt = Date.now()
      scheduleJobExpiry(job)
      return
    }

    const jobDir = path.join(workDir, job.id)
    job.dir = jobDir
    const controller = new AbortController()
    job.controller = controller
    const current: { child?: ChildProcess } = {}
    job.current = current

    const timeout = setTimeout(() => {
      controller.abort()
      const pid = current.child?.pid
      if (pid !== undefined) killProcessTree(pid)
    }, JOB_TIMEOUT_MS)
    timeout.unref()

    const startedAt = Date.now()
    job.status = 'running'
    job.startedAt = startedAt

    try {
      await fs.mkdir(jobDir, { recursive: true })
      const inputWav = path.join(jobDir, 'input.wav')
      await runFfmpeg(videoFile, inputWav, controller.signal, current)

      const logLine = (stream: JobLog['stream'], chunk: string) => appendBoundedLog(job, stream, chunk)
      const requestPath = path.join(jobDir, 'request.json')
      const resultPath = path.join(jobDir, 'result.json')

      const requestPayload =
        job.kind === 'align'
          ? {
              language: 'Chinese',
              text: job.align?.text ?? '',
            }
          : { language: 'Chinese', temperature: 0 }
      await fs.writeFile(requestPath, JSON.stringify(requestPayload), 'utf-8')

      await runProcess({
        command: VENV_PYTHON,
        args: [
          WORKER_SCRIPT,
          '--mode',
          job.kind,
          '--input',
          inputWav,
          '--request',
          requestPath,
          '--output',
          resultPath,
          '--runtime-dir',
          RUNTIME_DIR,
        ],
        cwd: __dirname,
        signal: controller.signal,
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          PYTHONNOUSERSITE: '1',
          PYTHONDONTWRITEBYTECODE: '1',
          VK_ICD_FILENAMES: 'none',
          GGML_VULKAN: '0',
        },
        onLine: logLine,
        notFoundMessage: '服务器上未安装语音识别运行时（缺少项目虚拟环境 Python）。',
        notFoundCode: 'ASR_RUNTIME_UNAVAILABLE',
        current,
      })

      const resultRaw = await readOptionalText(resultPath)
      const payload = parseWorkerResult(resultRaw)
      const raw = normalizeRawAsrItems(payload.raw)

      if (job.kind === 'align') {
        const snapshot = job.align
        if (!snapshot) throw new AsrError(500, 'ALIGN_FAILED', '强制对齐请求已丢失。')
        if (raw.length === 0) {
          throw new AsrError(500, 'ALIGN_EMPTY_RESULT', '强制对齐没有返回可用结果。')
        }
        const segments = mapAlignSnapshot(snapshot, raw)
        job.status = 'completed'
        job.finishedAt = Date.now()
        job.result = {
          kind: 'align',
          text: snapshot.text,
          srt: '',
          raw,
          segments,
          durationMs: job.finishedAt - startedAt,
        }
        scheduleJobExpiry(job)
        return
      }

      const text = typeof payload.transcript === 'string' ? payload.transcript : ''
      const srt = typeof payload.srt === 'string' ? payload.srt : ''
      const parsedSrt = parseSrtCaptions(srt)
      const captions: ParsedCaption[] =
        parsedSrt.length > 0 ? parsedSrt : parseTranscriptSegments(text)
      if (raw.length === 0 && captions.length === 0) {
        throw new AsrError(500, 'ASR_EMPTY_RESULT', '语音识别没有返回可用结果。')
      }

      const segments = buildTimedSegments(captions, raw)
      job.status = 'completed'
      job.finishedAt = Date.now()
      job.result = {
        kind: 'asr',
        text: text.trim(),
        srt: srt.trim(),
        raw,
        segments,
        durationMs: job.finishedAt - startedAt,
      }
      scheduleJobExpiry(job)
    } catch (error) {
      job.status = 'failed'
      job.finishedAt = Date.now()
      const label = job.kind === 'align' ? '强制对齐' : '语音识别'
      if (isAbortError(error)) {
        job.error = {
          code: job.kind === 'align' ? 'ALIGN_CANCELLED' : 'ASR_CANCELLED',
          message: `${label}任务已取消或超时。`,
        }
      } else if (error instanceof AsrError) {
        if (error.code === 'ASR_RUNTIME_FAILED') {
          // A non-zero worker exit: prefer its structured error, otherwise show
          // the exit code together with the native failure line (e.g. a
          // llama.cpp GGML_ASSERT) so the crash is diagnosable.
          job.error = readWorkerError(job) ?? {
            code: error.code,
            message: `${error.message}${lastStderrHint(job)}`,
          }
        } else {
          job.error = { code: error.code, message: error.message }
        }
      } else {
        console.error(`${label} job failed:`, error)
        job.error = {
          code: job.kind === 'align' ? 'ALIGN_FAILED' : 'ASR_FAILED',
          message: `${label}失败，请稍后重试。`,
        }
      }
      scheduleJobExpiry(job)
    } finally {
      clearTimeout(timeout)
      job.controller = undefined
      job.current = undefined
    }
  }

  async function drainQueue(): Promise<void> {
    while (!closing && active === null && queue.length > 0) {
      const job = queue.shift()
      if (!job) return
      active = job
      // Publish the unwind promise so shutdown can wait for this exact job.
      const done = (async () => {
        try {
          await runJob(job)
        } finally {
          active = null
        }
      })()
      activeDone = done.catch(() => undefined)
      await activeDone
    }
  }

  const router = express.Router()

  /**
   * Shared queue admission for both job kinds. Returns the created job or
   * writes the localized error response and returns `undefined`.
   */
  function enqueueJob(
    req: Request,
    res: Response,
    kind: JobKind,
    align?: AlignRequestSnapshot,
  ): AsrJobRecord | undefined {
    purgeExpired()
    const videoId = typeof req.params.id === 'string' ? req.params.id : ''
    if (videoId === '' || !deps.resolveVideoFile(videoId)) {
      res.status(404).json({ error: '未找到该视频。', code: 'NOT_FOUND' })
      return undefined
    }
    const busyLabel = kind === 'align' ? '强制对齐' : '语音识别'
    if (hasActiveJobForVideo(videoId)) {
      res.status(409).json({
        error: `该视频已有正在进行的${busyLabel}任务。`,
        code: 'ASR_BUSY',
      })
      return undefined
    }
    if (queue.length >= MAX_QUEUED_JOBS) {
      res.status(409).json({
        error: '语音识别队列已满，请稍后重试。',
        code: 'ASR_QUEUE_FULL',
      })
      return undefined
    }
    if (closing) {
      res.status(503).json({ error: '服务器正在关闭。', code: 'SERVER_SHUTDOWN' })
      return undefined
    }

    const job: AsrJobRecord = {
      id: randomUUID(),
      videoId,
      kind,
      status: 'queued',
      createdAt: Date.now(),
      log: [],
    }
    if (align) job.align = align
    jobs.set(job.id, job)
    queue.push(job)
    res.status(202).json({ id: job.id, kind, status: job.status })
    void drainQueue()
    return job
  }

  router.post('/videos/:id/asr', (req: Request, res: Response) => {
    enqueueJob(req, res, 'asr')
  })

  router.post('/videos/:id/align', (req: Request, res: Response, next: NextFunction) => {
    express.json({ limit: ALIGN_BODY_LIMIT, strict: true })(req, res, (error?: unknown) => {
      if (error) {
        next(error)
        return
      }
      try {
        const snapshot = validateAlignSnapshot(req.body)
        enqueueJob(req, res, 'align', snapshot)
      } catch (validationError) {
        next(validationError)
      }
    })
  })

  router.get('/asr/jobs/:id', (req: Request, res: Response) => {
    const id = typeof req.params.id === 'string' ? req.params.id : ''
    const job = id ? findJob(id) : undefined
    if (!job) {
      res.status(404).json({ error: '未找到该语音识别任务。', code: 'NOT_FOUND' })
      return
    }
    res.json(toResponse(job))
  })

  router.delete('/asr/jobs/:id', async (req: Request, res: Response) => {
    const id = typeof req.params.id === 'string' ? req.params.id : ''
    const job = id ? findJob(id) : undefined
    if (!job) {
      res.status(404).json({ error: '未找到该语音识别任务。', code: 'NOT_FOUND' })
      return
    }

    if (job.status === 'completed' || job.status === 'failed') {
      removeJob(job)
      await removeDir(job.dir)
      res.status(204).end()
      return
    }

    job.controller?.abort()
    const pid = job.current?.child?.pid
    if (pid !== undefined) killProcessTree(pid)
    removeJob(job)
    if (job.status === 'running') {
      const label = job.kind === 'align' ? '强制对齐' : '语音识别'
      job.status = 'failed'
      job.error = {
        code: job.kind === 'align' ? 'ALIGN_CANCELLED' : 'ASR_CANCELLED',
        message: `${label}任务已取消。`,
      }
      job.finishedAt = Date.now()
    }
    res.status(204).end()
  })

  router.use('/asr', (_req: Request, res: Response) => {
    res.status(404).json({ error: '未找到该请求的接口。', code: 'NOT_FOUND' })
  })

  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      res.destroy()
      return
    }
    if (error instanceof AsrError) {
      res.status(error.status).json({ error: error.message, code: error.code })
      return
    }
    // express.json() rejects oversized or malformed bodies with a status.
    const bodyError = error as { status?: number; type?: string }
    if (bodyError && typeof bodyError.status === 'number' && bodyError.status >= 400 && bodyError.status < 500) {
      const tooLarge = bodyError.type === 'entity.too.large'
      res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? '对齐请求内容过大。' : '对齐请求格式无效。',
        code: tooLarge ? 'ALIGN_BODY_TOO_LARGE' : 'ALIGN_INVALID',
      })
      return
    }
    console.error('ASR request failed:', error)
    res.status(500).json({ error: '语音识别服务发生内部错误。', code: 'INTERNAL_ERROR' })
  })

  async function stop(): Promise<void> {
    closing = true
    // Drop queued jobs so nothing new starts.
    for (const queued of queue) {
      if (queued.status === 'queued') {
        queued.status = 'failed'
        queued.error = { code: 'SERVER_SHUTDOWN', message: '服务器正在关闭，语音识别任务已取消。' }
        queued.finishedAt = Date.now()
      }
    }
    queue.length = 0

    if (active) {
      active.controller?.abort()
      const pid = active.current?.child?.pid
      if (pid !== undefined) killProcessTree(pid)
    }

    // Wait (bounded) for the in-flight job to unwind before the caller deletes
    // directories, so no child process is still holding a file open.
    const deadline = Date.now() + SHUTDOWN_JOB_GRACE_MS
    let settled = active === null
    void activeDone.then(() => {
      settled = true
    })
    while (!settled && Date.now() < deadline) {
      await delay(SHUTDOWN_POLL_MS)
    }
  }

  async function cleanup(): Promise<void> {
    await stop()
    jobs.clear()
    await removeDir(workDir)
  }

  return { router, hasActiveJobForVideo, cleanup, stop }
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}
