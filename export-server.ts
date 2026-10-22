import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import type { NextFunction, Request, Response, Router } from 'express'
import { bundle } from '@remotion/bundler'
import {
  ensureBrowser,
  makeCancelSignal,
  renderMedia,
  selectComposition,
  type ChromeMode,
  type LogLevel,
} from '@remotion/renderer'
import {
  sanitizeStyleName,
  sanitizeSubtitleTokenStyle,
  type SubtitleTokenStyle,
} from './src/subtitle-token-style.ts'
import type { SubtitleSegment } from './src/subtitle-types.ts'
import type { VideoMetadata } from './src/video-types.ts'
import { validateSegments } from './workspace-server.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Composition id registered in `src/remotion-root.tsx`. */
const COMPOSITION_ID = 'subtitle-video'
/**
 * Remotion-managed Chromium (downloaded by `ensureBrowser`, never the system
 * Chrome/Edge). `chrome-for-testing` is the full branded build, which has the
 * proprietary H.264/AAC decoders the source video needs.
 */
const CHROME_MODE: ChromeMode = 'chrome-for-testing'
/**
 * `<Video>` from `@remotion/media` decodes every frame in a single coordinator
 * ("main") tab and serves the other render tabs over a BroadcastChannel. Extra
 * tabs therefore do not add decode throughput — they only queue requests and
 * make each tab seek around the source. This video has a 5 s keyframe interval
 * (one keyframe every 150 frames), so every mis-ordered request forces a long
 * decode; with 8 tabs the queue exceeded the per-frame extraction timeout.
 * Rendering one frame at a time keeps the decoder sequential instead.
 * Override with `EXPORT_CONCURRENCY`.
 */
function resolveConcurrency(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

const EXPORT_CONCURRENCY = resolveConcurrency(process.env.EXPORT_CONCURRENCY)
/**
 * Per-operation budget for the renderer (Remotion's `remotion_puppeteerTimeout`).
 * The media extraction timeout is derived from it as `timeout - 5s`; the
 * default 30 s leaves only 25 s, which a single 5 s-GOP seek can exceed.
 * Override with `EXPORT_TIMEOUT_MS`.
 */
function resolveTimeout(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 30_000 ? parsed : 180_000
}

const EXPORT_TIMEOUT_MS = resolveTimeout(process.env.EXPORT_TIMEOUT_MS)
const MAX_STYLES = 200
const BODY_LIMIT = '16mb'
const JOB_FILE_PREFIX = 'export-'

const LOG_LEVELS: readonly LogLevel[] = ['trace', 'verbose', 'info', 'warn', 'error']

/**
 * Verbosity of Remotion's own renderer logs, which it writes straight to this
 * process's stdout/stderr. `REMOTION_LOG_LEVEL=info` (or any other level)
 * turns the chatter down; the value is validated so a typo falls back.
 */
function resolveLogLevel(value: string | undefined): LogLevel {
  return LOG_LEVELS.find((level) => level === value) ?? 'verbose'
}

const REMOTION_LOG_LEVEL = resolveLogLevel(process.env.REMOTION_LOG_LEVEL)

/** Every line is prefixed with the short job id so parallel logs stay readable. */
function jobLog(jobId: string) {
  const tag = `[export ${jobId.slice(0, 8)}]`
  return {
    info: (...args: unknown[]) => console.log(tag, ...args),
    warn: (...args: unknown[]) => console.warn(tag, ...args),
    error: (...args: unknown[]) => console.error(tag, ...args),
  }
}

type ExportJobStatus =
  | 'preparing'
  | 'rendering'
  | 'completed'
  | 'failed'
  | 'cancelled'

interface ExportJob {
  id: string
  status: ExportJobStatus
  /** `0`-`1` overall (bundle preparation counts as the first 10%). */
  progress: number
  message: string
  filename: string
  outputPath: string | null
  error: string | null
  /** Cancels the running render; `null` once the job is terminal. */
  cancel: (() => void) | null
  createdAt: number
}

interface ExportJobResponse {
  id: string
  status: ExportJobStatus
  progress: number
  message: string
  filename: string
  error: string | null
  downloadUrl: string | null
}

export interface ExportService {
  router: Router
  /** True while a job is preparing or rendering (one export at a time). */
  hasActiveJob: () => boolean
  cleanup: () => Promise<void>
  stop: () => Promise<void>
}

interface WorkspaceReader {
  get: () => { video: VideoMetadata | null }
  resolveVideoFile: (videoId: string) => string | undefined
  /** Static root that serves the videos (the app's `public` directory). */
  publicDir: string
}

export interface ExportServiceOptions {
  workspace: WorkspaceReader
  /** Directory for rendered MP4s; defaults to `<storage>/exports`. */
  dir?: string
  /** Override for tests. */
  bundleEntry?: string
  publicDir?: string
}

class ExportError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ExportError'
    this.status = status
    this.code = code
  }
}

/** Keep only well-formed style registry entries; anything else is dropped. */
function validateStyles(value: unknown): Record<string, SubtitleTokenStyle> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ExportError(400, 'INVALID_STYLES', '字幕样式格式无效。')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_STYLES) {
    throw new ExportError(400, 'INVALID_STYLES', '字幕样式数量过多。')
  }
  const out: Record<string, SubtitleTokenStyle> = {}
  for (const [rawName, rawStyle] of entries) {
    const name = sanitizeStyleName(rawName)
    const style = sanitizeSubtitleTokenStyle(rawStyle)
    if (name && style) out[name] = style
  }
  return out
}

/** `clip.mp4` -> `clip · 字幕.mp4`, falling back to a generic name. */
function exportFilename(filename: string): string {
  const base = filename.replace(/\.[^./\\]+$/u, '').trim()
  return `${base === '' ? '字幕视频' : base} · 字幕.mp4`
}

/**
 * Server-side Remotion export.
 *
 * The videos live in the app's `public/videos` directory, so the render bundle
 * (built with `publicDir: <.validation/public>` — the same `public` root the
 * browser reads) serves them directly as static files. No per-export copy or
 * hard link is needed. The bundle is invalidated whenever the workspace video
 * changes, so a new video can never render from a stale bundle (and no
 * unrelated historical video is copied into it).
 */
export async function createExportService(
  options: ExportServiceOptions,
): Promise<ExportService> {
  const { workspace } = options
  const dir = path.resolve(
    options.dir ?? process.env.EXPORT_DIR ?? path.join(process.cwd(), 'storage', 'exports'),
  )
  await fs.mkdir(dir, { recursive: true })

  const bundleEntry = options.bundleEntry ?? path.join(__dirname, 'src', 'remotion-entry.tsx')
  const publicDir = options.publicDir ?? workspace.publicDir

  const jobs = new Map<string, ExportJob>()
  let activeJobId: string | null = null
  let serveUrlPromise: Promise<string> | null = null
  /** Bundle is reused until the workspace video changes. */
  let bundleVideoKey: string | null = null
  /** One shared browser download/check, retried on failure. */
  let browserReadyPromise: Promise<void> | null = null

  /**
   * Make sure Remotion's own Chromium is available. The download happens once
   * (a few dozen MB) and is then reused for every render; failures are retried
   * on the next export. The system Chrome/Edge is never used.
   */
  const ensureRemotionBrowser = (jobId: string): Promise<void> => {
    if (browserReadyPromise) return browserReadyPromise
    const log = jobLog(jobId)
    log.info(`ensuring Remotion Chromium (${CHROME_MODE})…`)
    let lastPercent = -1
    browserReadyPromise = ensureBrowser({
      chromeMode: CHROME_MODE,
      logLevel: REMOTION_LOG_LEVEL,
      onBrowserDownload: ({ chromeMode }) => ({
        version: null,
        onProgress: ({ alreadyAvailable, percent, downloadedBytes, totalSizeInBytes }) => {
          if (alreadyAvailable) return
          const rounded = Math.floor(percent / 10) * 10
          if (rounded === lastPercent) return
          lastPercent = rounded
          log.info(
            `downloading ${chromeMode} ${rounded}% (${(downloadedBytes / 1024 ** 2).toFixed(1)} / ${(totalSizeInBytes / 1024 ** 2).toFixed(1)} MB)`,
          )
        },
      }),
    })
      .then((status) => {
        if (status.type === 'version-mismatch') {
          log.info(`browser check: version mismatch (actual: ${status.actualVersion ?? 'unknown'})`)
        } else if (status.type === 'no-browser') {
          log.info('browser check: no browser pinned')
        } else {
          log.info(`browser ready: ${status.type} ${status.path}`)
        }
      })
      .catch((error: unknown) => {
        browserReadyPromise = null
        throw error
      })
    return browserReadyPromise
  }

  /**
   * Current video identity the bundle was built for. A new upload changes this,
   * which forces a fresh bundle so the renderer never sees a stale/removed
   * video file (404) or a leftover one from the previous video.
   */
  const currentVideoKey = (): string => {
    const video = workspace.get().video
    return video ? `${video.id}:${video.publicPath ?? video.url}` : 'none'
  }

  /**
   * Bundle once per video. Building a fresh bundle per video only copies the
   * `public` directory as it is at that moment; nothing historical is staged.
   */
  const getServeUrl = (
    jobId: string,
    onProgress: (progress: number) => void,
  ): Promise<string> => {
    const key = currentVideoKey()
    if (!serveUrlPromise || bundleVideoKey !== key) {
      bundleVideoKey = key
      const log = jobLog(jobId)
      log.info(`bundling ${bundleEntry} (publicDir: ${publicDir})`)
      const startedAt = Date.now()
      serveUrlPromise = bundle({
        entryPoint: bundleEntry,
        publicDir,
        enableCaching: true,
        onProgress: (progress: number) => onProgress(progress),
      })
        .then((url) => {
          log.info(
            `bundle ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s -> ${url}`,
          )
          return url
        })
        .catch((error: unknown) => {
          // A failed bundle must be retried on the next export.
          serveUrlPromise = null
          bundleVideoKey = null
          throw error
        })
    }
    return serveUrlPromise
  }

  const toResponse = (job: ExportJob): ExportJobResponse => ({
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    filename: job.filename,
    error: job.error,
    downloadUrl:
      job.status === 'completed'
        ? `/api/export/${encodeURIComponent(job.id)}/file`
        : null,
  })

  const activeJob = (): ExportJob | null => {
    if (activeJobId === null) return null
    return jobs.get(activeJobId) ?? null
  }

  const removeJobFile = async (job: ExportJob): Promise<void> => {
    if (job.outputPath === null) return
    await fs.rm(job.outputPath, { force: true }).catch(() => undefined)
    job.outputPath = null
  }

  /** Drop files of finished jobs, keeping the one that just finished. */
  const pruneOldJobs = async (keepId: string): Promise<void> => {
    for (const job of jobs.values()) {
      if (job.id === keepId) continue
      if (job.status === 'preparing' || job.status === 'rendering') continue
      if (job.outputPath === null) continue
      await removeJobFile(job)
    }
  }

  const runJob = async (
    job: ExportJob,
    input: { video: VideoMetadata; segments: SubtitleSegment[]; styles: Record<string, SubtitleTokenStyle> },
  ): Promise<void> => {
    const { cancelSignal, cancel } = makeCancelSignal()
    job.cancel = cancel
    const outputPath = path.join(dir, `${JOB_FILE_PREFIX}${job.id}.mp4`)
    const log = jobLog(job.id)
    const startedAt = Date.now()
    const elapsed = () => ((Date.now() - startedAt) / 1000).toFixed(1)
    let lastProgressLogAt = 0
    let lastLoggedPercent = -1

    /**
     * Forward the render page's own console output. Errors and warnings always
     * surface; ordinary `debug`/`log` chatter would be thousands of lines, so it
     * is only shown at `REMOTION_LOG_LEVEL=trace`.
     */
    const onBrowserLog = (entry: { type?: string; text?: string }) => {
      const text = (entry.text ?? '').trim()
      if (text === '') return
      const type = entry.type ?? 'log'
      if (type === 'error') log.error(`[browser error] ${text}`)
      else if (type === 'warn') log.warn(`[browser warn] ${text}`)
      else if (REMOTION_LOG_LEVEL === 'trace') log.info(`[browser ${type}] ${text}`)
    }

    try {
      log.info(
        `start job: ${input.video.filename} (${input.video.width}x${input.video.height} @ ${input.video.fps}fps, ${input.segments.length} segments), logLevel=${REMOTION_LOG_LEVEL}, concurrency=${EXPORT_CONCURRENCY}, timeout=${EXPORT_TIMEOUT_MS}ms`,
      )
      job.status = 'preparing'
      job.message = '正在准备渲染环境…'
      job.progress = 0.02

      await ensureRemotionBrowser(job.id)
      const serveUrl = await getServeUrl(job.id, (progress) => {
        // The bundler reports 0-100, the job stores 0-1.
        const ratio = Math.min(1, Math.max(0, progress / 100))
        job.progress = 0.02 + ratio * 0.08
        job.message = `正在准备渲染环境… ${Math.round(ratio * 100)}%`
      })
      job.message = '正在准备视频与字体…'
      job.progress = 0.1

      const sourceFile = workspace.resolveVideoFile(input.video.id)
      if (!sourceFile) {
        throw new ExportError(409, 'VIDEO_MISSING', '视频文件缺失，无法导出。')
      }
      const publicPath = input.video.publicPath ?? `videos/${path.basename(sourceFile)}`

      // Pass the metadata through unchanged: `VideoStage` resolves the URL with
      // `staticFile(publicPath)`, so no path prefix is assembled here.
      const inputProps = {
        video: { ...input.video, publicPath },
        segments: input.segments,
        styles: input.styles,
      }

      log.info(`selecting composition "${COMPOSITION_ID}" (video src: ${publicPath})`)
      const composition = await selectComposition({
        serveUrl,
        id: COMPOSITION_ID,
        inputProps,
        chromeMode: CHROME_MODE,
        timeoutInMilliseconds: EXPORT_TIMEOUT_MS,
        logLevel: REMOTION_LOG_LEVEL,
        onBrowserLog,
      })
      log.info(
        `composition ready in ${elapsed()}s: ${composition.width}x${composition.height} @ ${composition.fps}fps, ${composition.durationInFrames} frames`,
      )
      job.status = 'rendering'
      job.message = '正在渲染视频…'
      job.progress = 0.12

      await renderMedia({
        serveUrl,
        composition,
        codec: 'h264',
        outputLocation: outputPath,
        inputProps,
        chromeMode: CHROME_MODE,
        concurrency: EXPORT_CONCURRENCY,
        timeoutInMilliseconds: EXPORT_TIMEOUT_MS,
        cancelSignal,
        logLevel: REMOTION_LOG_LEVEL,
        onBrowserLog,
        onProgress: ({ progress, renderedFrames, encodedFrames }) => {
          job.progress = 0.12 + progress * 0.88
          job.message = `正在渲染视频… ${Math.round(job.progress * 100)}%`
          // Log at most once per 5% and once per 2s, so the terminal stays useful.
          const percent = Math.round(job.progress * 100)
          const now = Date.now()
          if (percent - lastLoggedPercent >= 5 || now - lastProgressLogAt >= 2000) {
            lastLoggedPercent = percent
            lastProgressLogAt = now
            log.info(
              `render ${percent}% (rendered ${renderedFrames}/${composition.durationInFrames} frames, encoded ${encodedFrames}) ${elapsed()}s`,
            )
          }
        },
      })

      const size = await fs.stat(outputPath).then((stat) => stat.size).catch(() => 0)
      log.info(
        `completed in ${elapsed()}s -> ${outputPath} (${(size / 1024 ** 2).toFixed(1)} MB)`,
      )
      job.status = 'completed'
      job.progress = 1
      job.message = '导出完成'
      job.outputPath = outputPath
      job.cancel = null
    } catch (error) {
      await fs.rm(outputPath, { force: true }).catch(() => undefined)
      job.cancel = null
      if (job.status === 'cancelled') {
        log.warn(`cancelled after ${elapsed()}s`)
        job.message = '导出已取消'
        return
      }
      log.error(`failed after ${elapsed()}s:`, error)
      job.status = 'failed'
      job.progress = 0
      job.error = error instanceof ExportError ? error.message : renderErrorMessage(error)
      job.message = job.error
    } finally {
      if (activeJobId === job.id) activeJobId = null
      if (job.status === 'completed') void pruneOldJobs(job.id)
    }
  }

  const router = express.Router()
  router.use(express.json({ limit: BODY_LIMIT }))

  router.post('/export', (req: Request, res: Response, next: NextFunction) => {
    try {
      const video = workspace.get().video
      if (!video) {
        throw new ExportError(409, 'NO_VIDEO', '请先选择视频再导出。')
      }
      if (activeJobId !== null) {
        throw new ExportError(409, 'EXPORT_BUSY', '已有导出任务正在进行，请稍候。')
      }
      const body = (req.body ?? {}) as { segments?: unknown; styles?: unknown }
      const segments = validateSegments(body.segments ?? [])
      const styles = validateStyles(body.styles)
      if (segments.length === 0) {
        throw new ExportError(400, 'NO_SUBTITLES', '没有可导出的字幕。')
      }

      const job: ExportJob = {
        id: randomUUID(),
        status: 'preparing',
        progress: 0,
        message: '正在准备导出…',
        filename: exportFilename(video.filename),
        outputPath: null,
        error: null,
        cancel: null,
        createdAt: Date.now(),
      }
      jobs.set(job.id, job)
      activeJobId = job.id
      jobLog(job.id).info('queued')

      res.status(202).json(toResponse(job))
      void runJob(job, { video, segments, styles })
    } catch (error) {
      next(error)
    }
  })

  router.get('/export/:id', (req: Request, res: Response) => {
    const job = jobs.get(routeId(req))
    if (!job) {
      res.status(404).json({ error: '导出任务不存在或已过期。', code: 'EXPORT_NOT_FOUND' })
      return
    }
    res.json(toResponse(job))
  })

  router.get('/export/:id/file', (req: Request, res: Response) => {
    const job = jobs.get(routeId(req))
    if (!job || job.outputPath === null || job.status !== 'completed') {
      res.status(404).json({ error: '导出文件不存在。', code: 'EXPORT_FILE_NOT_FOUND' })
      return
    }
    res.download(job.outputPath, job.filename, (error?: Error) => {
      // The client may have cancelled the download; keep the file for retries.
      void error
    })
  })

  router.delete('/export/:id', (req: Request, res: Response) => {
    const job = jobs.get(routeId(req))
    if (!job) {
      res.status(404).json({ error: '导出任务不存在或已过期。', code: 'EXPORT_NOT_FOUND' })
      return
    }
    if (job.status === 'preparing' || job.status === 'rendering') {
      jobLog(job.id).warn('cancel requested')
      job.status = 'cancelled'
      job.message = '导出已取消'
      job.cancel?.()
      job.cancel = null
      if (activeJobId === job.id) activeJobId = null
    }
    void removeJobFile(job)
    res.json(toResponse(job))
  })

  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const known = asHttpError(error)
    if (known.status >= 500) console.error('Export request failed:', error)
    res.status(known.status).json({ error: known.message, code: known.code })
  })

  return {
    router,
    hasActiveJob: () => activeJob() !== null,
    cleanup: async () => {
      for (const job of jobs.values()) await removeJobFile(job)
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    },
    stop: async () => {
      for (const job of jobs.values()) {
        if (job.status === 'preparing' || job.status === 'rendering') {
          jobLog(job.id).warn('server shutting down, cancelling render')
          job.status = 'cancelled'
          job.cancel?.()
          job.cancel = null
        }
      }
      activeJobId = null
    },
  }
}

/** Read the job id from an Express 5 route param. */
function routeId(req: Request): string {
  const id = req.params.id
  return typeof id === 'string' ? id : ''
}

function renderErrorMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message.split('\n')[0].trim() : ''
  return detail === '' ? '导出失败，请稍后重试' : `导出失败：${detail}`
}

/** Normalize errors from our validation, Express and the renderer. */
function asHttpError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof ExportError) {
    return { status: error.status, code: error.code, message: error.message }
  }
  if (
    error !== null &&
    typeof error === 'object' &&
    typeof (error as { status?: unknown }).status === 'number' &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    const typed = error as { status: number; message: string; code?: unknown }
    return {
      status: typed.status,
      code: typeof typed.code === 'string' ? typed.code : 'INVALID_REQUEST',
      message: typed.message,
    }
  }
  if (isBodyTooLarge(error)) {
    return { status: 413, code: 'EXPORT_BODY_TOO_LARGE', message: '导出请求内容过大。' }
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: '导出失败，请稍后重试。' }
}

function isBodyTooLarge(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'type' in error &&
    (error as { type?: unknown }).type === 'entity.too.large'
  )
}
