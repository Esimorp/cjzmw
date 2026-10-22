import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from 'react'
import './subtitles.css'
import './App.css'
import { VideoPreview, type VideoPreviewHandle } from './VideoPreview'
import {
  ExportRequestError,
  cancelExportJob,
  createExportJob,
  downloadExportFile,
  fetchExportJob,
  type ExportJob,
} from './export-client'
import { useSubtitles } from './SubtitleContext'
import { legacyToken } from './subtitle-sample'
import {
  BUILT_IN_SUBTITLE_TOKEN_STYLES,
  DEFAULT_SUBTITLE_TOKEN_STYLE_NAME,
  subtitleTokenStyleLabel,
  useSubtitleTokenStyle,
} from './subtitle-token-style'
import {
  buildRetainedSegment,
  buildSegmentWithLineBreaks,
  createTimingCursor,
  flattenTokenUnits,
  remapEditedSegment,
} from './subtitle-timing'
import {
  createLineBreakToken,
  hasMeaningfulText,
  isLineBreakToken,
  splitDraftAtCaret,
  splitDraftToLines,
  tokensToDraft,
} from './subtitle-linebreak'
import type { SubtitleSegment, SubtitleToken } from './subtitle-types'
import type { VideoMetadata } from './video-types'

type Token = SubtitleToken
type Segment = SubtitleSegment

// In-segment line breaks are stored as dedicated untimed `\n` tokens, so save
// never splits a segment on newlines; see `subtitle-linebreak.ts`.
const SEGMENT_SPLIT_HINT = '段落内按回车可换行，保存后仍为同一段落。'
const HINT_ID = 'segment-edit-hint'

const POPUP_GAP = 12
const POPUP_MARGIN = 12
const POPUP_MIN_WIDTH = 240
const POPUP_TARGET_WIDTH = 280
/** Preferred width of the read-only token timing popup. */
const TOKEN_POPUP_WIDTH = 220

type PopupAnchor = {
  segmentId: string
  top: number
  left: number
  width: number
  maxHeight: number
  ready: boolean
}

function formatTime(totalSeconds: number) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '--:--'
  const total = Math.floor(totalSeconds)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function formatSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '未知大小'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unit]}`
}

function formatFps(fps: number) {
  if (!Number.isFinite(fps) || fps <= 0) return '未知帧率'
  return `${Number.isInteger(fps) ? fps : fps.toFixed(2)} fps`
}

function formatResolution(width: number, height: number) {
  if (width > 0 && height > 0) return `${width} × ${height}`
  return '未知分辨率'
}

function formatSeconds(seconds: number): string {
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(3)
}

/** Tooltip text for a token: exact seconds plus where the timing came from. */
function tokenTimingLabel(token: Token): string {
  if (token.start === null || token.end === null) return '无可靠时间戳'
  const source =
    token.timingSource === 'model'
      ? '模型时间戳'
      : token.timingSource === 'interpolated'
        ? '推算时间戳'
        : '无可靠时间戳'
  return `${source}：${formatSeconds(token.start)}s – ${formatSeconds(token.end)}s`
}

/** Earliest trusted token start in a segment (`null` when none exists). */
function segmentStart(segment: Segment): number | null {
  let earliest: number | null = null
  for (const token of segment.tokens) {
    if (token.start === null) continue
    if (earliest === null || token.start < earliest) earliest = token.start
  }
  return earliest
}

/** Latest trusted token end in a segment (`null` when none exists). */
function segmentEnd(segment: Segment): number | null {
  let latest: number | null = null
  for (const token of segment.tokens) {
    if (token.end === null) continue
    if (latest === null || token.end > latest) latest = token.end
  }
  return latest
}

/** Compact `start – end` label derived from the tokens, never segment fields. */
function segmentTimingLabel(segment: Segment): string {
  const start = segmentStart(segment)
  const end = segmentEnd(segment)
  if (start === null || end === null) return '暂无时间'
  return `${formatSeconds(start)}s – ${formatSeconds(end)}s`
}

/**
 * Text-only signature of the subtitles sent to forced alignment.
 *
 * It mirrors `buildAlignSnapshot`: untimed line-break/blank tokens are ignored,
 * ids are excluded, while token and segment boundaries are kept because the
 * aligner maps timings per token. A different signature means the stored
 * timings were computed for other text and alignment must run again.
 */
function subtitleSignature(segments: Segment[]): string {
  return segments
    .map((segment) =>
      segment.tokens
        .filter((token) => token.text.trim() !== '')
        .map((token) => token.text)
        .join('\u001f'),
    )
    .filter((text) => text !== '')
    .join('\u001e')
}

const TOKEN_STYLE_SELECT_ID = 'token-style-select'

/** Popup-friendly duration text for a token with unknown bounds. */
function tokenDurationLabel(token: Token): string {
  if (token.start === null || token.end === null) return '暂无时间'
  const duration = Math.max(0, token.end - token.start)
  return `${formatSeconds(Number(duration.toFixed(3)))}s`
}

/** Copy a token without its optional `styleName` (i.e. back to default). */
function withoutStyleName(token: Token): Token {
  const { styleName: _styleName, ...rest } = token
  return rest
}

const UPLOAD_ERROR_MESSAGE = '上传失败，请检查网络后重试'

/** Export runs on the server through Remotion's renderer. */
const EXPORT_FAILED_MESSAGE = '导出失败，请稍后重试'
/** How often the client asks the server for export progress. */
const EXPORT_POLL_INTERVAL_MS = 800

/** Snapshot of the current export job, mirrored into rendering UI state. */
type ExportState = {
  status: ExportJob['status']
  progress: number
  message: string
  filename: string
  error: string | null
}

function exportStateFromJob(job: ExportJob): ExportState {
  return {
    status: job.status,
    progress: job.progress,
    message: job.message,
    filename: job.filename,
    error: job.error,
  }
}

const ASR_POLL_INTERVAL_MS = 1000
const ASR_START_ERROR = '语音识别启动失败，请稍后重试'
const ASR_POLL_ERROR = '语音识别状态查询失败，请稍后重试'
const ASR_FAILED_FALLBACK = '语音识别失败，请稍后重试'
const ASR_CANCELLED_MESSAGE = '语音识别已取消'
const ASR_UNKNOWN_JOB = '语音识别任务不存在或已过期'
const ALIGN_START_ERROR = '强制对齐启动失败，请稍后重试'
const ALIGN_FAILED_FALLBACK = '强制对齐失败，请稍后重试'
const ALIGN_CANCELLED_MESSAGE = '强制对齐已取消'
const ALIGN_NO_TEXT = '没有可对齐的字幕文本'
const ALIGN_POLL_ERROR = '强制对齐状态查询失败，请稍后重试'
const ALIGN_UNKNOWN_JOB = '强制对齐任务不存在或已过期'
/** Workspace persistence tuning. */
const WORKSPACE_SAVE_DEBOUNCE_MS = 600
const WORKSPACE_SAVE_ERROR = '字幕保存失败，请检查网络后重试'
const WORKSPACE_CONFLICT_MESSAGE = '工作区已在其他标签页被修改，请刷新后再保存'
const WORKSPACE_LOAD_ERROR = '工作区恢复失败，当前不会自动保存'
const WORKSPACE_REPLACED_MESSAGE = '新视频已保存，旧视频与字幕已替换'

type AsrJobStatus = 'queued' | 'running' | 'completed' | 'failed'
/** `asr` = 语音识别, `align` = 强制对齐（基于已有字幕文本）. */
type JobKind = 'asr' | 'align'

interface AsrJobError {
  code: string
  message: string
}

interface AsrJobLogLine {
  stream: 'stdout' | 'stderr'
  line: string
}

interface AsrJobResult {
  kind: JobKind
  text: string
  srt: string
  raw: { text: string; start: number; end: number }[]
  segments: SubtitleSegment[]
  durationMs: number
}

interface AsrJobResponse {
  id: string
  videoId: string
  kind: JobKind
  status: AsrJobStatus
  queuePosition?: number
  error?: AsrJobError
  log?: AsrJobLogLine[]
  result?: AsrJobResult
}

interface AsrState {
  jobId: string
  videoId: string
  kind: JobKind
  status: AsrJobStatus | 'starting'
  message: string
  isError: boolean
}

const SUBTITLE_EXTENSION_ERROR = '仅支持导入 .txt 文本字幕文件'
const SUBTITLE_EMPTY_ERROR = '字幕文件没有可用内容，请检查后重新导入'
const SUBTITLE_READ_ERROR = '字幕文件读取失败，请重试'
const SUBTITLE_DECODE_ERROR = '字幕文件编码无法识别，请另存为 UTF-8 后重试'
const SUBTITLE_IMPORT_ID_PREFIX = 'txt'

let subtitleImportCounter = 0

function parseSubtitleText(text: string): Segment[] | null {
  const normalized = text.startsWith('\uFEFF') ? text.slice(1) : text
  const lines = normalized.split(/\r\n|\r|\n/)
  const parsed: Segment[] = []
  for (const line of lines) {
    if (line.trim() === '') continue
    const id = `${SUBTITLE_IMPORT_ID_PREFIX}-${subtitleImportCounter}-${parsed.length + 1}`
    // TXT import keeps one text token per line, without any timing information.
    parsed.push({ id, tokens: [legacyToken(`${id}-t01`, line)] })
  }
  if (parsed.length === 0) return null
  return parsed
}

// Only errors explicitly marked as server responses may surface their
// localized message; anything else (network/browser failures) is generic.
class UploadResponseError extends Error {}

async function readUploadError(response: Response): Promise<string | null> {
  try {
    const payload: unknown = await response.json()
    if (payload && typeof payload === 'object') {
      const { error } = payload as { error?: unknown }
      if (typeof error === 'string' && error.trim() !== '') return error
    }
  } catch {
    // Fall through to the generic message on network or parse failure.
  }
  return null
}

/**
 * Build the alignment snapshot from the current subtitles.
 *
 * Token ids and text are sent verbatim so the server can map the aligner's raw
 * timings back onto the exact same strings; empty tokens are dropped (the
 * server also rejects an empty snapshot).
 */
function buildAlignSnapshot(
  segments: Segment[],
): { segments: { id: string; tokens: { id: string; text: string }[] }[] } | null {
  const snapshot = segments
    .map((segment) => ({
      id: segment.id,
      tokens: segment.tokens
        .filter((token) => token.text.trim() !== '')
        .map((token) => ({ id: token.id, text: token.text })),
    }))
    .filter((segment) => segment.tokens.length > 0)
  if (snapshot.length === 0) return null
  return { segments: snapshot }
}

/** Await one poll interval; resolves `true` when aborted, detaching its listener. */
function waitForNextPoll(
  controller: AbortController,
  intervalMs = ASR_POLL_INTERVAL_MS,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (controller.signal.aborted) {
      resolve(true)
      return
    }
    const onAbort = () => {
      window.clearTimeout(timer)
      resolve(true)
    }
    const timer = window.setTimeout(() => {
      controller.signal.removeEventListener('abort', onAbort)
      resolve(false)
    }, intervalMs)
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Best-effort remote cancellation; failures are ignored (job expires anyway). */
async function cancelRemoteJob(jobId: string): Promise<void> {
  if (jobId === '') return
  await fetch(`/api/asr/jobs/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
    keepalive: true,
  }).catch(() => undefined)
}

function App() {
  // Subtitles live in the shared context: one source of truth for the editor,
  // the workspace saver and the Remotion composition.
  const { segments, setSegments } = useSubtitles()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [anchor, setAnchor] = useState<PopupAnchor | null>(null)
  const [measure, setMeasure] = useState<{
    id: string
    width: number
    height: number
  } | null>(null)
  const [video, setVideo] = useState<VideoMetadata | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [isImportingSubtitle, setIsImportingSubtitle] = useState(false)
  const [subtitleNotice, setSubtitleNotice] = useState<{
    kind: 'status' | 'error'
    text: string
  } | null>(null)
  const [asr, setAsr] = useState<AsrState | null>(null)
  const [asrResult, setAsrResult] = useState<AsrJobResult | null>(null)
  /**
   * Subtitle signature whose timings are current (workspace restore, ASR or a
   * completed forced alignment). Any later text edit makes it stale.
   */
  const [alignedSignature, setAlignedSignature] = useState(() =>
    subtitleSignature(segments),
  )
  const [workspaceNotice, setWorkspaceNotice] = useState<{
    kind: 'status' | 'error'
    text: string
  } | null>(null)
  const [exportState, setExportState] = useState<ExportState | null>(null)
  const [isWorkspaceLoading, setIsWorkspaceLoading] = useState(true)
  // Token classes come from the named style registry, never inline values.
  const { getStyle: getTokenStyle, styles: registeredStyles } = useSubtitleTokenStyle()
  /** Token shown in the read-only timing popup; mutually exclusive with editing. */
  const [inspectedToken, setInspectedToken] = useState<{
    segmentId: string
    tokenId: string
  } | null>(null)

  const rowRefs = useRef(new Map<string, HTMLLIElement>())
  const tokenRefs = useRef(new Map<string, HTMLSpanElement>())
  /** Imperative handle to the preview player, used to seek from segment rows. */
  const playerRef = useRef<VideoPreviewHandle | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)
  const tokenPopupRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  /**
   * Last known caret offset in the draft textarea. The insert button reads it
   * from here because clicking the button moves focus away from the textarea.
   * It is state (not a ref) so the button's disabled state re-evaluates.
   */
  const [caret, setCaret] = useState<number | null>(null)
  const focusRowOnClose = useRef(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const subtitleInputRef = useRef<HTMLInputElement | null>(null)
  const importingSubtitleRef = useRef(false)
  const uploadingRef = useRef(false)
  const controllerRef = useRef<AbortController | null>(null)
  const videoRef = useRef<VideoMetadata | null>(null)
  const deleteTimersRef = useRef(new Set<number>())
  const asrPollRef = useRef<AbortController | null>(null)
  /** In-flight browser export; aborting it cancels the Remotion render. */
  const exportAbortRef = useRef<AbortController | null>(null)
  /** Server-side export job currently being polled. */
  const exportJobRef = useRef<string | null>(null)
  /** True while the create-export request is in flight (double-click guard). */
  const exportStartingRef = useRef(false)
  // The job the UI is currently showing; only results for this exact pair are
  // accepted, so a stale poll from a previous video can never overwrite state.
  const asrActiveRef = useRef<{ jobId: string; videoId: string } | null>(null)
  const asrStartingRef = useRef(false)
  /** Latest segments, read by the debounced saver without stale closures. */
  const segmentsRef = useRef<Segment[]>(segments)
  // Lets the ASR poll close the editor popup without re-creating the callback.
  const closeEditorRef = useRef<(() => void) | null>(null)

  const isAsrActive =
    asr !== null && (asr.status === 'queued' || asr.status === 'running' || asr.status === 'starting')
  const isExporting =
    exportState?.status === 'preparing' || exportState?.status === 'rendering'

  const alignMeaningfulChars = segments.reduce(
    (total, segment) =>
      total +
      segment.tokens.reduce(
        (count, token) => count + token.text.replace(/\s+/gu, '').length,
        0,
      ),
    0,
  )
  /** Alignment needs a video plus some subtitle text (no length cap). */
  const hasAlignText = alignMeaningfulChars > 0

  const currentSubtitleSignature = useMemo(
    () => subtitleSignature(segments),
    [segments],
  )
  /** Text changed since the last ASR/alignment, so the timings may be stale. */
  const needsReAlign =
    video !== null &&
    hasAlignText &&
    !isAsrActive &&
    currentSubtitleSignature !== alignedSignature

  const editingSegment =
    segments.find((segment) => segment.id === editingId) ?? null

  const activeAnchor = anchor && anchor.segmentId === editingId ? anchor : null

  const selectedIndex = segments.findIndex(
    (segment) => segment.id === selectedId,
  )

  const clearTimers = () => {
    deleteTimersRef.current.forEach((timer) => window.clearTimeout(timer))
    deleteTimersRef.current.clear()
  }

  // --- persistent workspace -------------------------------------------------
  // The server owns the durable copy; the client only mirrors it. While
  // `workspaceReady` is false the initial sample segments must never be saved,
  // so a slow load cannot overwrite the disk state.
  const workspaceReadyRef = useRef(false)
  const workspaceVideoIdRef = useRef<string | null>(null)
  const workspaceRevisionRef = useRef(0)
  const workspaceSaveTimerRef = useRef<number | null>(null)
  const workspaceSavingRef = useRef(false)
  const workspaceQueuedRef = useRef(false)

  const cancelWorkspaceSave = () => {
    if (workspaceSaveTimerRef.current !== null) {
      window.clearTimeout(workspaceSaveTimerRef.current)
      workspaceSaveTimerRef.current = null
    }
  }

  /**
   * Persist the current subtitles. Saves are debounced and serialized; each
   * save carries the revision it was based on, so a request from a previous
   * video (or another tab) is rejected with 409 instead of overwriting.
   */
  const flushWorkspaceSave = async () => {
    workspaceSaveTimerRef.current = null
    if (!workspaceReadyRef.current || asrActiveRef.current !== null) return
    if (workspaceSavingRef.current) {
      workspaceQueuedRef.current = true
      return
    }
    workspaceSavingRef.current = true
    const videoId = workspaceVideoIdRef.current
    try {
      // The video may have been swapped while the timer was pending.
      if (videoRef.current?.id !== videoId) return
      const response = await fetch('/api/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: workspaceRevisionRef.current,
          video: videoRef.current,
          segments: segmentsRef.current,
        }),
      })
      if (response.status === 409) {
        const message = (await readUploadError(response)) ?? WORKSPACE_CONFLICT_MESSAGE
        setWorkspaceNotice({ kind: 'error', text: message })
        return
      }
      if (!response.ok) {
        const message = (await readUploadError(response)) ?? WORKSPACE_SAVE_ERROR
        setWorkspaceNotice({ kind: 'error', text: message })
        return
      }
      const payload = (await response.json()) as { workspace?: { revision?: unknown } }
      if (typeof payload.workspace?.revision === 'number') {
        workspaceRevisionRef.current = payload.workspace.revision
      }
      setWorkspaceNotice(null)
    } catch {
      setWorkspaceNotice({ kind: 'error', text: WORKSPACE_SAVE_ERROR })
    } finally {
      workspaceSavingRef.current = false
      if (workspaceQueuedRef.current) {
        workspaceQueuedRef.current = false
        scheduleWorkspaceSave()
      }
    }
  }

  const scheduleWorkspaceSave = () => {
    if (!workspaceReadyRef.current) return
    cancelWorkspaceSave()
    workspaceSaveTimerRef.current = window.setTimeout(() => {
      void flushWorkspaceSave()
    }, WORKSPACE_SAVE_DEBOUNCE_MS)
  }

  /** Change the video identity; any pending save now belongs to the old video. */
  const adoptWorkspaceVideo = (next: VideoMetadata | null) => {
    cancelWorkspaceSave()
    workspaceQueuedRef.current = false
    workspaceVideoIdRef.current = next?.id ?? null
    videoRef.current = next
    setVideo(next)
  }

  const abortAsrPolling = () => {
    asrPollRef.current?.abort()
    asrPollRef.current = null
  }

  const statusText = (kind: JobKind, status: AsrJobStatus, queuePosition?: number) => {
    const noun = kind === 'align' ? '强制对齐' : '语音识别'
    if (status === 'queued') {
      return queuePosition && queuePosition > 1
        ? `排队中（前面还有 ${queuePosition - 1} 个任务）…`
        : '排队中…'
    }
    if (status === 'running') {
      return kind === 'align' ? '正在对齐字幕与语音，请稍候…' : '正在识别语音，请稍候…'
    }
    if (status === 'completed') return `${noun}完成`
    return kind === 'align' ? ALIGN_FAILED_FALLBACK : ASR_FAILED_FALLBACK
  }

  /**
   * Release the pin the instant a job reaches a terminal state. Only the job
   * the ref still points at is released, so a late response from a previous job
   * can never unpin the current one.
   */
  const releaseActiveJob = (jobId: string, videoId: string) => {
    const active = asrActiveRef.current
    if (!active) return
    if (active.videoId !== videoId) return
    // A placeholder entry (empty id) is always ours to release.
    if (active.jobId !== '' && active.jobId !== jobId) return
    asrActiveRef.current = null
  }

  /**
   * Poll a job until it finishes. The loop only accepts a result whose job id
   * and video id are still the ones being displayed, so cancelling, switching
   * videos or unmounting never applies a stale result or leaves the video
   * pinned. Every terminal branch releases the active-job ref.
   */
  const pollAsrJob = async (
    jobId: string,
    videoId: string,
    kind: JobKind,
    controller: AbortController,
  ) => {
    const pollError = kind === 'align' ? ALIGN_POLL_ERROR : ASR_POLL_ERROR
    const failedFallback = kind === 'align' ? ALIGN_FAILED_FALLBACK : ASR_FAILED_FALLBACK
    const unknownJob = kind === 'align' ? ALIGN_UNKNOWN_JOB : ASR_UNKNOWN_JOB
    while (!controller.signal.aborted) {
      let response: Response
      try {
        response = await fetch(`/api/asr/jobs/${encodeURIComponent(jobId)}`, {
          signal: controller.signal,
        })
      } catch (error) {
        if (controller.signal.aborted) return
        void error
        releaseActiveJob(jobId, videoId)
        setAsr((current) =>
          current && current.jobId === jobId
            ? { ...current, status: 'failed', message: pollError, isError: true }
            : current,
        )
        return
      }

      if (controller.signal.aborted) return

      if (!response.ok) {
        const message = (await readUploadError(response)) ?? unknownJob
        if (controller.signal.aborted) return
        releaseActiveJob(jobId, videoId)
        setAsr((current) =>
          current && current.jobId === jobId
            ? { ...current, status: 'failed', message, isError: true }
            : current,
        )
        return
      }

      let payload: AsrJobResponse
      try {
        payload = (await response.json()) as AsrJobResponse
      } catch {
        if (controller.signal.aborted) return
        releaseActiveJob(jobId, videoId)
        setAsr((current) =>
          current && current.jobId === jobId
            ? { ...current, status: 'failed', message: pollError, isError: true }
            : current,
        )
        return
      }

      if (controller.signal.aborted) return
      const activeJob = asrActiveRef.current
      if (!activeJob || activeJob.jobId !== jobId || activeJob.videoId !== videoId) return
      if (payload.id !== jobId || payload.videoId !== videoId) return

      if (payload.status === 'completed') {
        const result = payload.result
        releaseActiveJob(jobId, videoId)
        if (!result) {
          setAsr({
            jobId,
            videoId,
            kind,
            status: 'failed',
            message: failedFallback,
            isError: true,
          })
          return
        }
        setSegments(result.segments)
        setAlignedSignature(subtitleSignature(result.segments))
        setAsrResult(result)
        setSelectedId(null)
        setInspectedToken(null)
        closeEditorRef.current?.()
        setAsr({
          jobId,
          videoId,
          kind,
          status: 'completed',
          message: statusText(kind, 'completed'),
          isError: false,
        })
        return
      }

      if (payload.status === 'failed') {
        releaseActiveJob(jobId, videoId)
        setAsr({
          jobId,
          videoId,
          kind,
          status: 'failed',
          message: payload.error?.message ?? failedFallback,
          isError: true,
        })
        return
      }

      setAsr({
        jobId,
        videoId,
        kind,
        status: payload.status,
        message: statusText(kind, payload.status, payload.queuePosition),
        isError: false,
      })

      // Wait one interval, but wake immediately (and detach the listener) on
      // abort so the loop never accumulates listeners or leaks a timer.
      const aborted = await waitForNextPoll(controller)
      if (aborted) return
    }
  }

  const startAsr = async (kind: JobKind = 'asr') => {
    const current = videoRef.current
    if (!current) return
    if (asrStartingRef.current || isAsrActive) return
    if (exportAbortRef.current !== null) return

    const noun = kind === 'align' ? '强制对齐' : '语音识别'
    const startError = kind === 'align' ? ALIGN_START_ERROR : ASR_START_ERROR

    let body: string | undefined
    if (kind === 'align') {
      const snapshot = buildAlignSnapshot(segments)
      if (!snapshot) {
        setAsr({
          jobId: '',
          videoId: current.id,
          kind,
          status: 'failed',
          message: ALIGN_NO_TEXT,
          isError: true,
        })
        return
      }
      body = JSON.stringify(snapshot)
    }

    asrStartingRef.current = true

    abortAsrPolling()
    const controller = new AbortController()
    asrPollRef.current = controller

    // Claim the busy UI and the active-job ref *before* the request, so the
    // video/TXT/editing inputs are disabled for the whole POST round trip.
    asrActiveRef.current = { jobId: '', videoId: current.id }
    setAsr({
      jobId: '',
      videoId: current.id,
      kind,
      status: 'starting',
      message: `正在启动${noun}…`,
      isError: false,
    })

    let jobId = ''
    try {
      const response = await fetch(`/api/videos/${encodeURIComponent(current.id)}/${kind}`, {
        method: 'POST',
        signal: controller.signal,
        ...(body === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body }),
      })

      if (!response.ok) {
        const message = (await readUploadError(response)) ?? startError
        if (controller.signal.aborted) return
        releaseActiveJob('', current.id)
        setAsr({
          jobId: '',
          videoId: current.id,
          kind,
          status: 'failed',
          message,
          isError: true,
        })
        return
      }

      let payload: { id?: unknown; status?: unknown }
      try {
        payload = (await response.json()) as { id?: unknown; status?: unknown }
      } catch {
        if (controller.signal.aborted) return
        releaseActiveJob('', current.id)
        setAsr({
          jobId: '',
          videoId: current.id,
          kind,
          status: 'failed',
          message: startError,
          isError: true,
        })
        return
      }

      // A response that arrived after the user cancelled still created a job on
      // the server, so cancel it instead of orphaning it.
      if (controller.signal.aborted) {
        const cancelledId = typeof payload.id === 'string' ? payload.id : ''
        if (cancelledId !== '') void cancelRemoteJob(cancelledId)
        return
      }

      jobId = typeof payload.id === 'string' ? payload.id : ''
      if (jobId === '') {
        releaseActiveJob('', current.id)
        setAsr({
          jobId: '',
          videoId: current.id,
          kind,
          status: 'failed',
          message: startError,
          isError: true,
        })
        return
      }

      asrActiveRef.current = { jobId, videoId: current.id }
      setAsr({
        jobId,
        videoId: current.id,
        kind,
        status: typeof payload.status === 'string' ? (payload.status as AsrJobStatus) : 'queued',
        message: statusText(kind, 'queued'),
        isError: false,
      })
      // `pollAsrJob` owns the terminal branches; it releases the active ref.
      await pollAsrJob(jobId, current.id, kind, controller)
    } catch (error) {
      if (controller.signal.aborted) {
        if (jobId !== '') void cancelRemoteJob(jobId)
        return
      }
      void error
      releaseActiveJob(jobId, current.id)
      setAsr({
        jobId: '',
        videoId: current.id,
        kind,
        status: 'failed',
        message: startError,
        isError: true,
      })
    } finally {
      asrStartingRef.current = false
    }
  }

  const cancelAsr = async () => {
    const active = asrActiveRef.current
    const kind = asr?.kind ?? 'asr'
    abortAsrPolling()
    asrActiveRef.current = null
    if (active && active.jobId !== '') {
      setAsr({
        jobId: active.jobId,
        videoId: active.videoId,
        kind,
        status: 'failed',
        message: kind === 'align' ? ALIGN_CANCELLED_MESSAGE : ASR_CANCELLED_MESSAGE,
        isError: false,
      })
      await cancelRemoteJob(active.jobId)
      return
    }
    setAsr(null)
  }

  useEffect(() => {
    return () => {
      abortAsrPolling()
      asrActiveRef.current = null
    }
  }, [])

  /**
   * Export the current subtitles burned into the video.
   *
   * The server renders the same Remotion composition the player shows (one
   * export at a time) and this function polls its progress. Rendering a snapshot:
   * later edits do not affect an export that has already started.
   */
  const startExport = async () => {
    const current = videoRef.current
    if (!current || isAsrActive || isExporting) return
    if (exportStartingRef.current || exportJobRef.current !== null) return

    exportStartingRef.current = true
    const controller = new AbortController()
    exportAbortRef.current = controller
    setExportState({
      status: 'preparing',
      progress: 0,
      message: '正在准备导出…',
      filename: '',
      error: null,
    })

    try {
      const job = await createExportJob({
        segments: segmentsRef.current,
        styles: registeredStyles,
      })
      if (controller.signal.aborted) {
        void cancelExportJob(job.id)
        return
      }
      exportJobRef.current = job.id
      setExportState(exportStateFromJob(job))
      await pollExportJob(job, controller)
    } catch (error) {
      if (controller.signal.aborted) return
      setExportState({
        status: 'failed',
        progress: 0,
        message:
          error instanceof ExportRequestError && error.message !== ''
            ? error.message
            : EXPORT_FAILED_MESSAGE,
        filename: '',
        error: null,
      })
    } finally {
      exportStartingRef.current = false
      if (exportAbortRef.current === controller) exportAbortRef.current = null
      exportJobRef.current = null
    }
  }

  /** Poll one job until it finishes, mirroring its progress into the UI. */
  const pollExportJob = async (job: ExportJob, controller: AbortController) => {
    let latest = job
    while (!controller.signal.aborted) {
      if (latest.status === 'completed') {
        setExportState(exportStateFromJob(latest))
        downloadExportFile(latest)
        return
      }
      if (latest.status === 'failed' || latest.status === 'cancelled') {
        setExportState(exportStateFromJob(latest))
        return
      }
      const aborted = await waitForNextPoll(controller, EXPORT_POLL_INTERVAL_MS)
      if (aborted) return
      try {
        latest = await fetchExportJob(job.id, controller.signal)
      } catch (error) {
        if (controller.signal.aborted) return
        if (error instanceof ExportRequestError) {
          setExportState({
            status: 'failed',
            progress: 0,
            message: error.message,
            filename: job.filename,
            error: null,
          })
          return
        }
        // A transient network hiccup should not lose the running render.
        continue
      }
      if (controller.signal.aborted) return
      setExportState(exportStateFromJob(latest))
    }
  }

  const cancelExport = () => {
    const jobId = exportJobRef.current
    exportAbortRef.current?.abort()
    exportAbortRef.current = null
    exportJobRef.current = null
    if (jobId !== null) void cancelExportJob(jobId)
    setExportState(null)
  }

  useEffect(() => {
    return () => {
      exportAbortRef.current?.abort()
      const jobId = exportJobRef.current
      if (jobId !== null) void cancelExportJob(jobId)
    }
  }, [])

  useEffect(() => {
    return () => {
      clearTimers()
      cancelWorkspaceSave()
    }
  }, [])

  // Restore the saved workspace once on mount. Never write anything before the
  // load settles, so the sample segments cannot clobber the persisted state.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch('/api/workspace')
        if (!response.ok) throw new Error(`workspace load ${response.status}`)
        const payload = (await response.json()) as {
          workspace?: {
            revision?: unknown
            video?: VideoMetadata | null
            segments?: Segment[]
          }
          writable?: boolean
          restoreError?: string | null
        }
        if (cancelled) return
        const document = payload.workspace
        if (typeof document?.revision === 'number') {
          workspaceRevisionRef.current = document.revision
        }
        if (payload.writable === false) {
          setWorkspaceNotice({ kind: 'error', text: WORKSPACE_LOAD_ERROR })
        } else if (payload.restoreError) {
          setWorkspaceNotice({ kind: 'status', text: payload.restoreError })
        }
        if (document?.video) {
          adoptWorkspaceVideo(document.video)
          const restored = Array.isArray(document.segments) ? document.segments : []
          segmentsRef.current = restored
          setSegments(restored)
          setAlignedSignature(subtitleSignature(restored))
        }
      } catch {
        if (!cancelled) setWorkspaceNotice({ kind: 'error', text: WORKSPACE_LOAD_ERROR })
      } finally {
        if (!cancelled) {
          workspaceReadyRef.current = true
          setIsWorkspaceLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // `setSegments` is a stable callback from the subtitle provider.
  }, [setSegments])

  // Any subtitle edit (import, edit, delete, merge, ASR, align) schedules a
  // debounced save once the workspace has been loaded.
  useEffect(() => {
    segmentsRef.current = segments
    if (!workspaceReadyRef.current) return
    scheduleWorkspaceSave()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments])

  useEffect(() => {
    const handlePageHide = () => {
      // The workspace is persistent: leaving the page must never delete it.
      // Flush any pending edit instead so the last keystroke survives.
      cancelWorkspaceSave()
      if (workspaceReadyRef.current && !asrStartingRef.current) {
        void flushWorkspaceSave()
      }
    }
    window.addEventListener('pagehide', handlePageHide)
    return () => window.removeEventListener('pagehide', handlePageHide)
  }, [])

  useEffect(() => {
    videoRef.current = video
  }, [video])

  const closePicker = () => {
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const openPicker = () => {
    if (uploadingRef.current) return
    closePicker()
    fileInputRef.current?.click()
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    if (uploadingRef.current || isAsrActive) return
    void uploadFile(file)
  }

  const closeSubtitlePicker = () => {
    if (subtitleInputRef.current) subtitleInputRef.current.value = ''
  }

  const openSubtitlePicker = () => {
    if (importingSubtitleRef.current) return
    closeSubtitlePicker()
    subtitleInputRef.current?.click()
  }

  const handleSubtitleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    if (importingSubtitleRef.current || isAsrActive) return
    void importSubtitleFile(file)
  }

  const importSubtitleFile = async (file: File) => {
    importingSubtitleRef.current = true
    setIsImportingSubtitle(true)
    setSubtitleNotice({ kind: 'status', text: '正在读取字幕文件…' })

    const fail = (text: string) => {
      setSubtitleNotice({ kind: 'error', text })
    }

    try {
      if (!/\.txt$/i.test(file.name)) {
        fail(SUBTITLE_EXTENSION_ERROR)
        return
      }

      let buffer: ArrayBuffer
      try {
        buffer = await file.arrayBuffer()
      } catch {
        fail(SUBTITLE_READ_ERROR)
        return
      }

      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
      } catch {
        fail(SUBTITLE_DECODE_ERROR)
        return
      }

      subtitleImportCounter += 1
      const parsed = parseSubtitleText(text)
      if (parsed === null) {
        fail(SUBTITLE_EMPTY_ERROR)
        return
      }

      setSegments(parsed)
      setSelectedId(null)
      setEditingId(null)
      setDraft('')
      setAnchor(null)
      setMeasure(null)
      setInspectedToken(null)
      focusRowOnClose.current = false
      setSubtitleNotice({
        kind: 'status',
        text: `已导入 ${parsed.length} 条字幕，可在下方逐段校订`,
      })
    } finally {
      importingSubtitleRef.current = false
      setIsImportingSubtitle(false)
      closeSubtitlePicker()
    }
  }

  const uploadFile = async (file: File) => {
    uploadingRef.current = true
    setIsUploading(true)
    setUploadError(null)

    const controller = new AbortController()
    controllerRef.current = controller

    try {
      const formData = new FormData()
      formData.append('video', file)
      const response = await fetch('/api/videos', {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new UploadResponseError(
          (await readUploadError(response)) ?? UPLOAD_ERROR_MESSAGE,
        )
      }
      const metadata: VideoMetadata = await response.json()
      if (controller.signal.aborted) return

      // The server committed the video + empty subtitles to the workspace, so
      // only now replace the local state. A failed upload never reaches here,
      // which keeps the previous workspace intact.
      cancelWorkspaceSave()
      workspaceQueuedRef.current = false
      workspaceRevisionRef.current += 1
      adoptWorkspaceVideo(metadata)
      segmentsRef.current = []
      setSegments([])
      setAlignedSignature(subtitleSignature([]))
      setSelectedId(null)
      setEditingId(null)
      setDraft('')
      setAnchor(null)
      setMeasure(null)
      setInspectedToken(null)
      setAsrResult(null)
      setAsr(null)
      setSubtitleNotice(null)
      setWorkspaceNotice({ kind: 'status', text: WORKSPACE_REPLACED_MESSAGE })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setUploadError(
        error instanceof UploadResponseError && error.message !== ''
          ? error.message
          : UPLOAD_ERROR_MESSAGE,
      )
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
      uploadingRef.current = false
      setIsUploading(false)
      closePicker()
    }
  }

  useEffect(() => () => controllerRef.current?.abort(), [])

  const openEditor = (segment: Segment) => {
    if (isAsrActive) return
    setSelectedId(segment.id)
    setEditingId(segment.id)
    setDraft(tokensToDraft(segment.tokens))
    setCaret(null)
    setAnchor(null)
    setMeasure(null)
    // The two popups are mutually exclusive.
    setInspectedToken(null)
  }

  const closeEditor = () => {
    setEditingId(null)
    setDraft('')
    setAnchor(null)
    setMeasure(null)
    setCaret(null)
  }

  /** Move the preview player to a time in seconds; unknown times are ignored. */
  const seekPreview = (
    seconds: number | null,
    options?: { pause?: boolean },
  ) => {
    if (seconds === null) return
    playerRef.current?.seekToSeconds(seconds, options)
  }

  /**
   * Open the token popup (timing info + style picker), closing the editor, and
   * pause the preview at the token's start (falling back to the segment start)
   * so the frame can be inspected without playback moving on.
   */
  const inspectToken = (segmentId: string, tokenId: string) => {
    if (isAsrActive) return
    const segment = segments.find((item) => item.id === segmentId)
    const token = segment?.tokens.find((item) => item.id === tokenId)
    seekPreview(token?.start ?? (segment ? segmentStart(segment) : null), {
      pause: true,
    })
    if (editingId !== null) closeEditor()
    setSelectedId(segmentId)
    setInspectedToken({ segmentId, tokenId })
  }

  const closeTokenPopup = () => {
    setInspectedToken(null)
  }

  /** Clicking a row selects it and jumps the preview to its first trusted time. */
  const focusSegment = (segment: Segment) => {
    setSelectedId(segment.id)
    seekPreview(segmentStart(segment))
  }

  /**
   * Change only `styleName` of the inspected token. The id, text, timings and
   * character units are preserved by reference, and the existing debounced
   * workspace save picks the change up.
   */
  const applyTokenStyleName = (styleName: string) => {
    if (!inspectedToken || isAsrActive) return
    const { segmentId, tokenId } = inspectedToken
    const existing = getTokenStyle(styleName)
    if (!existing) return
    const next = segmentsRef.current.map((segment) => {
      if (segment.id !== segmentId) return segment
      return {
        ...segment,
        tokens: segment.tokens.map((token) =>
          token.id === tokenId
            ? styleName === DEFAULT_SUBTITLE_TOKEN_STYLE_NAME
              ? withoutStyleName(token)
              : { ...token, styleName }
            : token,
        ),
      }
    })
    segmentsRef.current = next
    setSegments(next)
    scheduleWorkspaceSave()
  }

  useEffect(() => {
    closeEditorRef.current = closeEditor
  })

  const cancelEditing = () => {
    focusRowOnClose.current = true
    closeEditor()
  }

  /**
   * Turn a draft into the segment's token list: words keep their order, and each
   * line break becomes one untimed marker token placed *between* lines. Nothing
   * is split into extra segments and no timing is invented for the break.
   */
  const draftToTokens = (segmentId: string, text: string) => {
    const lines = splitDraftToLines(text)
    const tokens: { id: string; text: string }[] = []
    lines.forEach((words, lineIndex) => {
      if (lineIndex > 0) {
        tokens.push(createLineBreakToken(`${segmentId}-lb${lineIndex}`))
      }
      for (const word of words) {
        tokens.push({
          id: `${segmentId}-t${String(tokens.length + 1).padStart(2, '0')}`,
          text: word,
        })
      }
    })
    return tokens
  }

  /**
   * Splitting needs text on both sides of the caret; when no caret has been
   * recorded yet, the end of the draft is used.
   */
  const canInsertSegment =
    hasMeaningfulText(
      splitDraftAtCaret(draft, caret ?? draft.length).before,
    ) &&
    hasMeaningfulText(
      splitDraftAtCaret(draft, caret ?? draft.length).after,
    )

  const saveEditing = () => {
    if (!editingSegment) return
    const currentIndex = segments.findIndex(
      (segment) => segment.id === editingSegment.id,
    )
    const isDraftEmpty = !hasMeaningfulText(draft)

    if (isDraftEmpty) {
      const remaining = segments.filter(
        (segment) => segment.id !== editingSegment.id,
      )
      setSegments(remaining)
      const nextSelected =
        remaining[Math.min(currentIndex, remaining.length - 1)] ?? null
      setSelectedId(nextSelected?.id ?? null)
      focusRowOnClose.current = true
      closeEditor()
      return
    }

    // One forward cursor over the original segment's own characters, so an edit
    // never re-matches against unrelated duplicate text elsewhere. Line-break
    // markers consume nothing.
    const source = flattenTokenUnits(editingSegment.tokens)
    const cursor = createTimingCursor(source)
    const replacement = buildSegmentWithLineBreaks(
      editingSegment.id,
      cursor,
      draftToTokens(editingSegment.id, draft),
      editingSegment.tokens,
    )
    const nextSegment: Segment =
      replacement.tokens.some((token) => !isLineBreakToken(token))
        ? replacement
        : editingSegment

    setSegments((current) => {
      const index = current.findIndex(
        (segment) => segment.id === editingSegment.id,
      )
      if (index === -1) return current
      return [
        ...current.slice(0, index),
        nextSegment,
        ...current.slice(index + 1),
      ]
    })
    setSelectedId(nextSegment.id)
    focusRowOnClose.current = true
    closeEditor()
  }

  /**
   * Split the segment at the textarea caret (or selection start) into two
   * adjacent segments and save immediately. The part before the caret keeps the
   * current id; the part after it becomes a new neighbour, and both are mapped
   * through one forward timing cursor so timings and styles survive.
   */
  const insertSegmentAtCaret = () => {
    if (!editingSegment || isAsrActive) return
    const caretOffset = caret ?? draft.length
    const { before, after } = splitDraftAtCaret(draft, caretOffset)
    if (!hasMeaningfulText(before) || !hasMeaningfulText(after)) return

    const source = flattenTokenUnits(editingSegment.tokens)
    const cursor = createTimingCursor(source)
    const headId = editingSegment.id
    const tailId = `${headId}-n${crypto.randomUUID()}`
    const head = buildSegmentWithLineBreaks(
      headId,
      cursor,
      draftToTokens(headId, before),
      editingSegment.tokens,
    )
    const tail = buildSegmentWithLineBreaks(
      tailId,
      cursor,
      draftToTokens(tailId, after),
      editingSegment.tokens,
    )

    setSegments((current) => {
      const index = current.findIndex((segment) => segment.id === headId)
      if (index === -1) return current
      return [...current.slice(0, index), head, tail, ...current.slice(index + 1)]
    })
    setSelectedId(tailId)
    focusRowOnClose.current = true
    closeEditor()
  }

  /**
   * Merge one segment into its neighbor by explicit id, preserving token order
   * and timings.
   *
   * `sourceTokenTexts` drives the merged segment's own tokens (the editor passes
   * the current draft; inline buttons pass the segment's existing tokens). The
   * neighbor always keeps its existing units and timing source untouched. New
   * token ids follow the neighbor's id strategy.
   *
   * Returns the surviving segment id, or `null` when the merge is impossible
   * (missing segment/neighbor). Never touches segments other than these two.
   */
  const mergeSegments = (
    segmentId: string,
    direction: 'previous' | 'next',
    sourceTokenTexts: string[],
    tokens: readonly Segment[],
  ): { survivorId: string; next: Segment[] } | null => {
    const index = tokens.findIndex((segment) => segment.id === segmentId)
    if (index === -1) return null
    const neighborIndex = direction === 'previous' ? index - 1 : index + 1
    if (neighborIndex < 0 || neighborIndex >= tokens.length) return null

    const source = tokens[index]
    const neighbor = tokens[neighborIndex]
    const editedTokens = sourceTokenTexts.map((text, tokenIndex) => ({
      id: `${neighbor.id}-t${String(tokenIndex + 1).padStart(2, '0')}`,
      text,
    }))
    const remapped = remapEditedSegment(source.tokens, editedTokens).tokens

    const ordered =
      direction === 'previous'
        ? [...neighbor.tokens, ...remapped]
        : [...remapped, ...neighbor.tokens]
    const boundaryTokens = ordered.map((token, tokenIndex) => ({
      ...token,
      id: `${neighbor.id}-t${String(tokenIndex + 1).padStart(2, '0')}`,
    }))

    const next = tokens
      .filter((segment) => segment.id !== source.id)
      .map((segment) =>
        segment.id === neighbor.id
          ? buildRetainedSegment(neighbor.id, boundaryTokens)
          : segment,
      )
    return { survivorId: neighbor.id, next }
  }

  /** Merge a segment that is *not* being edited from its row buttons. */
  const mergeFromRow = (segmentId: string, direction: 'previous' | 'next') => {
    if (isAsrActive) return
    const segment = segments.find((item) => item.id === segmentId)
    if (!segment) return
    const result = mergeSegments(
      segmentId,
      direction,
      segment.tokens.map((token) => token.text),
      segments,
    )
    if (!result) return
    setSegments(result.next)
    setSelectedId(result.survivorId)
    // The merged-away segment can no longer be an edit or popup target.
    if (editingId === segmentId) closeEditor()
    if (inspectedToken?.segmentId === segmentId) setInspectedToken(null)
  }

  useEffect(() => {
    if (editingId === null) return

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancelEditing()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [editingId])

  useEffect(() => {
    if (editingId === null && focusRowOnClose.current) {
      focusRowOnClose.current = false
      // Rows are no longer focusable; return focus to the edit button instead.
      if (selectedId) {
        rowRefs.current.get(selectedId)?.querySelector<HTMLButtonElement>(
          '.segment-edit-btn',
        )?.focus()
      }
    }
  }, [editingId, selectedId])

  useLayoutEffect(() => {
    if (editingId === null) return

    const updateAnchor = () => {
      const row = rowRefs.current.get(editingId)
      if (!row) return

      const rowRect = row.getBoundingClientRect()
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const maxUsableWidth = Math.max(
        viewportWidth - POPUP_MARGIN * 2,
        POPUP_MIN_WIDTH,
      )
      const width = Math.min(
        Math.max(rowRect.width, POPUP_TARGET_WIDTH),
        maxUsableWidth,
      )
      const left = Math.min(
        Math.max(rowRect.left, POPUP_MARGIN),
        Math.max(viewportWidth - POPUP_MARGIN - width, POPUP_MARGIN),
      )

      const measuredHeight =
        measure && measure.id === editingId ? measure.height : 0
      const popupHeight = popupRef.current?.offsetHeight || measuredHeight
      const roomAbove = rowRect.top - POPUP_GAP - POPUP_MARGIN
      const placeAbove = roomAbove >= popupHeight
      const desiredTop = placeAbove
        ? rowRect.top - POPUP_GAP - popupHeight
        : rowRect.bottom + POPUP_GAP
      const maxTop = Math.max(
        viewportHeight - POPUP_MARGIN - popupHeight,
        POPUP_MARGIN,
      )
      const top = Math.min(Math.max(desiredTop, POPUP_MARGIN), maxTop)
      const maxHeight = Math.max(
        viewportHeight - top - POPUP_MARGIN,
        Math.min(popupHeight, viewportHeight - POPUP_MARGIN * 2),
      )

      setAnchor((current) => {
        const next = {
          segmentId: editingId,
          top,
          left,
          width,
          maxHeight,
          ready: popupHeight > 0,
        }
        if (
          current &&
          current.segmentId === next.segmentId &&
          current.top === next.top &&
          current.left === next.left &&
          current.width === next.width &&
          current.maxHeight === next.maxHeight &&
          current.ready === next.ready
        ) {
          return current
        }
        return next
      })
    }

    updateAnchor()
    window.addEventListener('resize', updateAnchor)
    window.addEventListener('scroll', updateAnchor, true)
    return () => {
      window.removeEventListener('resize', updateAnchor)
      window.removeEventListener('scroll', updateAnchor, true)
    }
  }, [editingId, segments, draft, measure])

  useLayoutEffect(() => {
    if (editingId === null) return
    const node = popupRef.current
    if (!node || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.borderBoxSize?.[0]
      const measuredWidth = box ? box.inlineSize : node.offsetWidth
      const measuredHeight = box ? box.blockSize : node.offsetHeight
      setMeasure((current) => {
        if (
          current &&
          current.id === editingId &&
          current.width === measuredWidth &&
          current.height === measuredHeight
        ) {
          return current
        }
        return {
          id: editingId,
          width: measuredWidth,
          height: measuredHeight,
        }
      })
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [editingId])

  const anchorReady = activeAnchor?.ready ?? false

  useEffect(() => {
    if (editingId === null || !anchorReady) return
    const id = window.setTimeout(() => textareaRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [editingId, anchorReady])

  const popupStyle: CSSProperties = activeAnchor
    ? {
        top: `${activeAnchor.top}px`,
        left: `${activeAnchor.left}px`,
        width: `${activeAnchor.width}px`,
        maxHeight: `${activeAnchor.maxHeight}px`,
        visibility: activeAnchor.ready ? undefined : 'hidden',
      }
    : {
        top: '12px',
        left: '12px',
        width: 'calc(100vw - 24px)',
        visibility: 'hidden',
      }

  // --- token timing popup (read-only) -------------------------------------
  const inspected = inspectedToken
    ? (() => {
        const segment = segments.find((item) => item.id === inspectedToken.segmentId)
        const token = segment?.tokens.find((item) => item.id === inspectedToken.tokenId)
        return segment && token ? { segment, token } : null
      })()
    : null

  // Drop the popup as soon as its target disappears (import, edit, delete, ASR).
  // Derived during render: a stale token simply renders nothing, and the next
  // interaction starts from a clean popup.
  const inspectedKey = inspected ? `${inspected.segment.id}/${inspected.token.id}` : null

  // Style picker options come straight from the registry; the built-in styles
  // (`default`, `emphasis`) are always present because the provider registers
  // them up front.
  const styleOptions = useMemo(() => {
    const names = Object.keys(registeredStyles)
    // Built-in styles first in a fixed order, then custom names alphabetically.
    const builtInOrder = Object.keys(BUILT_IN_SUBTITLE_TOKEN_STYLES)
    const rank = (name: string) => {
      const index = builtInOrder.indexOf(name)
      return index === -1 ? builtInOrder.length : index
    }
    names.sort((a, b) => {
      const byRank = rank(a) - rank(b)
      return byRank !== 0 ? byRank : a.localeCompare(b)
    })
    return names
  }, [registeredStyles])

  const currentStyleName =
    inspected === null
      ? DEFAULT_SUBTITLE_TOKEN_STYLE_NAME
      : inspected.token.styleName && registeredStyles[inspected.token.styleName]
        ? inspected.token.styleName
        : DEFAULT_SUBTITLE_TOKEN_STYLE_NAME

  const [tokenAnchorState, setTokenAnchor] = useState<{
    key: string
    top: number
    left: number
    maxWidth: number
  } | null>(null)

  useLayoutEffect(() => {
    // Depend only on primitive keys: `inspected` is a fresh object every render,
    // so using it here would re-run the effect after each setTokenAnchor and
    // loop until React throws "Maximum update depth exceeded".
    if (!inspectedToken || inspectedKey === null) return
    const anchorKey = inspectedKey
    const updateAnchor = () => {
      const node = tokenRefs.current.get(anchorKey)
      const popup = tokenPopupRef.current
      if (!node) return
      const rect = node.getBoundingClientRect()
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const width = popup?.offsetWidth || TOKEN_POPUP_WIDTH
      const height = popup?.offsetHeight || 0
      const left = Math.min(
        Math.max(rect.left, POPUP_MARGIN),
        Math.max(viewportWidth - POPUP_MARGIN - width, POPUP_MARGIN),
      )
      const roomBelow = viewportHeight - rect.bottom - POPUP_GAP - POPUP_MARGIN
      const placeAbove = roomBelow < height && rect.top - POPUP_GAP - POPUP_MARGIN >= height
      const desiredTop = placeAbove ? rect.top - POPUP_GAP - height : rect.bottom + POPUP_GAP
      const top = Math.min(
        Math.max(desiredTop, POPUP_MARGIN),
        Math.max(viewportHeight - POPUP_MARGIN - height, POPUP_MARGIN),
      )
      const maxWidth = Math.max(viewportWidth - POPUP_MARGIN * 2, 180)
      // Bail out when nothing moved, so scroll/resize events cannot re-render
      // unconditionally either.
      setTokenAnchor((current) =>
        current &&
        current.key === anchorKey &&
        current.top === top &&
        current.left === left &&
        current.maxWidth === maxWidth
          ? current
          : { key: anchorKey, top, left, maxWidth },
      )
    }
    updateAnchor()
    window.addEventListener('resize', updateAnchor)
    window.addEventListener('scroll', updateAnchor, true)
    return () => {
      window.removeEventListener('resize', updateAnchor)
      window.removeEventListener('scroll', updateAnchor, true)
    }
  }, [inspectedToken, inspectedKey])

  // Escape closes; a pointer press outside the popup and its token closes too.
  useEffect(() => {
    if (!inspectedToken) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setInspectedToken(null)
      }
    }
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (tokenPopupRef.current?.contains(target)) return
      if (target instanceof Element && target.closest('[data-token-id]')) return
      setInspectedToken(null)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', onPointerDown)
    }
  }, [inspectedToken])

  const tokenAnchor =
    tokenAnchorState && inspectedKey !== null && tokenAnchorState.key === inspectedKey
      ? tokenAnchorState
      : null
  const tokenPopupStyle: CSSProperties = tokenAnchor
    ? {
        top: `${tokenAnchor.top}px`,
        left: `${tokenAnchor.left}px`,
        maxWidth: `${tokenAnchor.maxWidth}px`,
      }
    : {
        top: '12px',
        left: '12px',
        maxWidth: 'calc(100vw - 24px)',
        visibility: 'hidden',
      }

  return (
    <div className="app">
      <header className="app-bar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            字
          </span>
          <span className="brand-text">
            <span className="brand-title">超级字幕王</span>
            <span className="brand-sub">逐字校订 · 所见即所得</span>
          </span>
        </div>
        <div className="toolbar" role="group" aria-label="工作流程">
          <button type="button" className="primary-btn" onClick={openPicker} disabled={isAsrActive || isExporting || isUploading} title={
              isAsrActive
                ? '语音识别进行中，暂时无法更换视频'
                : isExporting
                  ? '导出进行中，暂时无法更换视频'
                  : '选择本地视频文件'
            }
          >
            选择视频
          </button>
          {isAsrActive ? (
            <button
              type="button"
              className="ghost-btn"
              onClick={() => void cancelAsr()}
              title={asr?.kind === 'align' ? '取消当前的强制对齐任务' : '取消当前的语音识别任务'}
            >
              {asr?.kind === 'align' ? '取消对齐' : '取消识别'}
            </button>
          ) : (
            <button
              type="button"
              className="ghost-btn"
              onClick={() => void startAsr('asr')}
              disabled={!video || isUploading || isAsrActive || isExporting}
              title={
                !video
                  ? '请先选择视频'
                  : isExporting
                    ? '导出进行中，暂时无法识别'
                    : '使用本地 Qwen3-ASR 识别视频语音'
              }
            >
              语音识别
            </button>
          )}
          <button
            type="button"
            className="ghost-btn"
            onClick={openSubtitlePicker}
            disabled={isImportingSubtitle || isAsrActive || isExporting}
            aria-busy={isImportingSubtitle}
            title={
              isExporting
                ? '导出进行中，暂时无法导入字幕'
                : isAsrActive
                  ? '语音识别进行中，暂时无法导入字幕'
                  : '导入本地 TXT 字幕文件'
            }
          >
            上传字幕
          </button>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => void startAsr('align')}
            disabled={!video || isUploading || isAsrActive || isExporting || !hasAlignText}
            title={
              !video
                ? '请先选择视频'
                : !hasAlignText
                  ? '请先导入或识别字幕'
                  : isExporting
                    ? '导出进行中，暂时无法对齐'
                    : '用已有字幕文本强制对齐视频语音'
            }
          >
            强制对齐
          </button>
          {isExporting ? (
            <button
              type="button"
              className="ghost-btn"
              onClick={cancelExport}
              title="取消当前的视频导出"
            >
              取消导出
            </button>
          ) : (
            <button
              type="button"
              className="primary-btn"
              onClick={() => void startExport()}
              disabled={!video || isUploading || isAsrActive}
              title={
                !video
                  ? '请先选择视频'
                  : isAsrActive
                    ? '语音识别进行中，暂时无法导出'
                    : '用 Remotion 在本地导出带字幕的 MP4'
              }
            >
              导出
            </button>
          )}
        </div>
        <input
          ref={fileInputRef}
          className="file-input"
          type="file"
          accept="video/*"
          aria-label="选择本地视频文件"
          onChange={handleFileChange}
        />
        <input
          ref={subtitleInputRef}
          className="file-input"
          type="file"
          accept=".txt,text/plain"
          aria-label="选择本地 TXT 字幕文件"
          onChange={handleSubtitleFileChange}
        />
      </header>

      <main className="workbench">
        <section
          className="panel panel-list"
          aria-labelledby="subtitle-list-title"
        >
          <div className="panel-head">
            <div>
              <h1 className="panel-title" id="subtitle-list-title">
                字幕分段
              </h1>
              <p className="panel-sub">
                共 {segments.length} 段
                {selectedIndex >= 0
                  ? ` · 当前第 ${selectedIndex + 1} 段`
                  : ' · 未选择'}
              </p>
            </div>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                setSelectedId(null)
                closeEditor()
              }}
            >
              取消选择
            </button>
          </div>

          {subtitleNotice?.kind === 'status' ? (
            <p className="stage-status" role="status">
              {subtitleNotice.text}
            </p>
          ) : null}

          {subtitleNotice?.kind === 'error' ? (
            <p className="stage-error" role="alert">
              {subtitleNotice.text}
            </p>
          ) : null}

          {asr ? (
            <p
              className={asr.isError ? 'stage-error' : 'stage-status'}
              role={asr.isError ? 'alert' : 'status'}
            >
              {asr.message}
              {isAsrActive ? (
                <button
                  type="button"
                  className="inline-cancel-btn"
                  onClick={() => void cancelAsr()}
                >
                  取消
                </button>
              ) : null}
            </p>
          ) : null}

          {workspaceNotice ? (
            <p
              className={
                workspaceNotice.kind === 'error' ? 'stage-error' : 'stage-status'
              }
              role={workspaceNotice.kind === 'error' ? 'alert' : 'status'}
              data-workspace-notice={workspaceNotice.kind}
            >
              {workspaceNotice.text}
            </p>
          ) : null}

          {isWorkspaceLoading ? (
            <p className="stage-status" role="status">
              正在恢复上次的工作区…
            </p>
          ) : null}

          {asrResult ? (
            <p className="stage-substatus" role="status">
              {asrResult.kind === 'align' ? '已对齐' : '已识别'} {asrResult.segments.length} 段 ·
              原始时间戳 {asrResult.raw.length} 项 ·
              耗时 {(asrResult.durationMs / 1000).toFixed(1)} 秒
            </p>
          ) : null}

          {needsReAlign ? (
            <p className="stage-warning" role="status" data-align-needed="true">
              字幕有变化，需要重新强制对齐
            </p>
          ) : null}

          <ul
            className="segment-list"
            aria-label="字幕分段列表"
            data-editing={editingId ?? undefined}
            aria-busy={isAsrActive}
          >
            {segments.map((segment, index) => {
              const isSelected = segment.id === selectedId
              const rowClassName = [
                'segment-row',
                isSelected ? 'is-selected' : '',
                segment.id === editingId ? 'is-editing' : '',
              ]
                .filter(Boolean)
                .join(' ')

              return (
                <li
                  key={segment.id}
                  ref={(node) => {
                    if (node) rowRefs.current.set(segment.id, node)
                    else rowRefs.current.delete(segment.id)
                  }}
                  className={rowClassName}
                  aria-label={`第 ${index + 1} 段字幕`}
                  title={
                    segmentStart(segment) === null
                      ? undefined
                      : '点击定位到该段开始时间'
                  }
                  onClick={() => focusSegment(segment)}
                >
                  <div className="segment-head">
                    <span className="segment-index" aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className="segment-time" data-segment-time>
                      {segmentTimingLabel(segment)}
                    </span>
                    <div className="segment-actions">
                      <button
                        type="button"
                        className="segment-edit-btn ghost-btn"
                        onClick={(event) => {
                          event.stopPropagation()
                          openEditor(segment)
                        }}
                        disabled={isAsrActive}
                        aria-label={`编辑第 ${index + 1} 段字幕`}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="segment-merge-btn ghost-btn"
                        onClick={(event) => {
                          event.stopPropagation()
                          mergeFromRow(segment.id, 'previous')
                        }}
                        disabled={isAsrActive || index === 0}
                        title={
                          index === 0
                            ? '已是第一段，无法向前合并'
                            : '与上一段合并，保留本段文字'
                        }
                        aria-label={`将第 ${index + 1} 段向前合并`}
                      >
                        向前合并
                      </button>
                      <button
                        type="button"
                        className="segment-merge-btn ghost-btn"
                        onClick={(event) => {
                          event.stopPropagation()
                          mergeFromRow(segment.id, 'next')
                        }}
                        disabled={isAsrActive || index >= segments.length - 1}
                        title={
                          index >= segments.length - 1
                            ? '已是最后一段，无法向后合并'
                            : '与下一段合并，保留本段文字'
                        }
                        aria-label={`将第 ${index + 1} 段向后合并`}
                      >
                        向后合并
                      </button>
                    </div>
                  </div>
                  <div className="segment-text">
                    {segment.tokens.map((token) => {
                      const tokenKey = `${segment.id}/${token.id}`
                      const isInspected =
                        inspectedToken?.segmentId === segment.id &&
                        inspectedToken.tokenId === token.id
                      // Line-break markers render as a real break, not a chip:
                      // they carry no timing and are not selectable.
                      if (isLineBreakToken(token)) {
                        return (
                          <span
                            key={token.id}
                            className="segment-line-break"
                            data-line-break={token.id}
                            aria-label="段落内换行"
                          />
                        )
                      }
                      // Editor tokens keep one fixed paper-chip look. Registered
                      // token styles apply to the player only, so `styleName`
                      // never changes the left column's class list; selection
                      // only adds the fixed `is-inspected` highlight.
                      return (
                        <span
                          className={
                            isInspected ? 'token-chip is-inspected' : 'token-chip'
                          }
                          key={token.id}
                          ref={(node) => {
                            if (node) tokenRefs.current.set(tokenKey, node)
                            else tokenRefs.current.delete(tokenKey)
                          }}
                          role="button"
                          tabIndex={isAsrActive ? -1 : 0}
                          aria-haspopup="dialog"
                          aria-pressed={isInspected}
                          aria-label={`${token.text}，${tokenTimingLabel(token)}`}
                          title={tokenTimingLabel(token)}
                          data-token-id={token.id}
                          data-timing-source={token.timingSource}
                          data-start={token.start === null ? undefined : token.start}
                          data-end={token.end === null ? undefined : token.end}
                          onClick={(event) => {
                            event.stopPropagation()
                            inspectToken(segment.id, token.id)
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              event.stopPropagation()
                              inspectToken(segment.id, token.id)
                            } else if (event.key === 'Escape') {
                              event.preventDefault()
                              event.stopPropagation()
                              closeTokenPopup()
                            }
                          }}
                        >
                          {token.text}
                        </span>
                      )
                    })}
                  </div>
                </li>
              )
            })}
          </ul>
        </section>

        <section
          className="panel panel-stage"
          aria-labelledby="preview-title"
        >
          <div className="panel-head">
            <div>
              <h2 className="panel-title" id="preview-title">
                画面预览
              </h2>
              <p className="panel-sub">
                {video
                  ? '真实素材 · 帧级预览'
                  : '尚未选择视频 · 请先点击“选择视频”'}
              </p>
            </div>
            <span className="badge">
              {isUploading ? '上传中' : video ? '已就绪' : '空'}
            </span>
          </div>

          {isUploading ? (
            <p className="stage-status" role="status">
              正在上传并解析视频，请稍候…
            </p>
          ) : null}

          {uploadError ? (
            <p className="stage-error" role="alert">
              {uploadError}
            </p>
          ) : null}

          {exportState ? (
            <div
              className={`${
                exportState.status === 'failed'
                  ? 'stage-error'
                  : exportState.status === 'completed'
                    ? 'stage-status export-status export-status--done'
                    : 'stage-status export-status'
              }`}
              role={exportState.status === 'failed' ? 'alert' : 'status'}
              data-export-status={exportState.status}
            >
              <span>
                {exportState.status === 'completed'
                  ? `已导出 ${exportState.filename}`
                  : exportState.message}
              </span>
              {isExporting ? (
                <>
                  <progress
                    className="export-progress"
                    max={100}
                    value={Math.round(exportState.progress * 100)}
                    aria-label="导出进度"
                  />
                  <button
                    type="button"
                    className="inline-cancel-btn"
                    onClick={cancelExport}
                  >
                    取消
                  </button>
                </>
              ) : null}
            </div>
          ) : null}

          {video ? (
            <>
              <VideoPreview key={video.id} ref={playerRef} video={video} />
              <dl className="video-facts">
                <div className="video-fact">
                  <dt>文件名</dt>
                  <dd>{video.filename}</dd>
                </div>
                <div className="video-fact">
                  <dt>大小</dt>
                  <dd>{formatSize(video.size)}</dd>
                </div>
                <div className="video-fact">
                  <dt>时长</dt>
                  <dd>{formatTime(video.duration)}</dd>
                </div>
                <div className="video-fact">
                  <dt>分辨率</dt>
                  <dd>{formatResolution(video.width, video.height)}</dd>
                </div>
                <div className="video-fact">
                  <dt>帧率</dt>
                  <dd>{formatFps(video.fps)}</dd>
                </div>
                <div className="video-fact">
                  <dt>编码</dt>
                  <dd>{video.codec || '未知编码'}</dd>
                </div>
              </dl>
            </>
          ) : !isUploading ? (
            <div className="stage-empty">
              <p className="stage-empty-title">还没有导入视频</p>
              <p className="stage-empty-text">
                点击上方的“选择视频”导入本地素材，导入后即可预览画面并逐段校订字幕。
              </p>
            </div>
          ) : null}
        </section>
      </main>

      {editingSegment && !isAsrActive ? (
        <div
          ref={popupRef}
          className="popup"
          style={popupStyle}
          role="dialog"
          aria-label={`编辑第 ${selectedIndex + 1} 段字幕`}
        >
          <p className="popup-title">
            编辑第 {selectedIndex + 1} 段（共 {segments.length} 段）
          </p>
          <textarea
            ref={textareaRef}
            className="popup-input"
            value={draft}
            spellCheck={false}
            aria-describedby={HINT_ID}
            onChange={(event) => {
              setDraft(event.target.value)
              setCaret(event.currentTarget.selectionStart)
            }}
            onSelect={(event) => {
              setCaret(event.currentTarget.selectionStart)
            }}
            onKeyUp={(event) => {
              setCaret(event.currentTarget.selectionStart)
            }}
            onMouseUp={(event) => {
              setCaret(event.currentTarget.selectionStart)
            }}
          />
          <p className="popup-hint" id={HINT_ID}>
            {SEGMENT_SPLIT_HINT}
          </p>
          <div className="popup-actions">
            <button
              type="button"
              className="ghost-btn"
              onClick={insertSegmentAtCaret}
              disabled={isAsrActive || !canInsertSegment}
              title="按光标位置把当前段落分为两段并立即保存"
            >
              插入段落
            </button>
            <div className="popup-actions-group">
              <button type="button" className="ghost-btn" onClick={cancelEditing}>
                取消
              </button>
              <button
                type="button"
                className="primary-btn"
                onClick={saveEditing}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {inspected ? (
        <div
          ref={tokenPopupRef}
          className="token-popup"
          style={tokenPopupStyle}
          role="dialog"
          aria-label={`字幕词元信息：${inspected.token.text}`}
        >
          <p className="token-popup-text">{inspected.token.text}</p>
          <dl className="token-popup-facts">
            <div>
              <dt>开始</dt>
              <dd>
                {inspected.token.start === null
                  ? '暂无时间'
                  : `${formatSeconds(inspected.token.start)} 秒`}
              </dd>
            </div>
            <div>
              <dt>结束</dt>
              <dd>
                {inspected.token.end === null
                  ? '暂无时间'
                  : `${formatSeconds(inspected.token.end)} 秒`}
              </dd>
            </div>
            <div>
              <dt>持续</dt>
              <dd>{tokenDurationLabel(inspected.token)}</dd>
            </div>
          </dl>
          <div className="token-popup-style">
            <label className="token-popup-style-label" htmlFor={TOKEN_STYLE_SELECT_ID}>
              样式
            </label>
            <select
              id={TOKEN_STYLE_SELECT_ID}
              className="token-popup-style-select"
              value={currentStyleName}
              disabled={isAsrActive || !workspaceReadyRef.current}
              onChange={(event) => applyTokenStyleName(event.target.value)}
            >
              {styleOptions.map((name) => (
                <option key={name} value={name}>
                  {subtitleTokenStyleLabel(name)}
                </option>
              ))}
            </select>
          </div>
          <div className="token-popup-actions">
            <button type="button" className="ghost-btn" onClick={closeTokenPopup}>
              关闭
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default App
