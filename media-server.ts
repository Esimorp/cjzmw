import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import express from 'express'
import type { NextFunction, Request, Response, Router } from 'express'
import multer from 'multer'
import type { VideoMetadata } from './src/video-types.ts'

const execFileAsync = promisify(execFile)

const MAX_FILE_SIZE = 2 * 1024 ** 3
const FFPROBE_TIMEOUT_MS = 30_000
const FFPROBE_MAX_BUFFER = 4 * 1024 * 1024

const FORMAT_CONTENT_TYPES: Record<string, string> = {
  mov: 'video/mp4',
  mp4: 'video/mp4',
  m4a: 'video/mp4',
  '3gp': 'video/mp4',
  '3g2': 'video/mp4',
  mj2: 'video/mp4',
  webm: 'video/webm',
  matroska: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mpegts: 'video/mp2t',
  ogg: 'video/ogg',
}

interface StoredVideo {
  metadata: VideoMetadata
  filePath: string
  contentType: string
}

interface MediaService {
  router: Router
  cleanup: () => Promise<void>
  /** Look up the current persisted video so other routers can read its file. */
  findVideo: (id: string) => StoredVideo | undefined
  /** Seed the registry from the persisted workspace document. */
  restore: (video: VideoMetadata | null) => void
}

interface MediaServiceDependencies {
  /** True while a queued or running ASR job references the video id. */
  isVideoBusy?: (videoId: string) => boolean
  /**
   * Persistence hook. When present, a successful upload is committed to the
   * workspace (video file + JSON) before it becomes the served video, and the
   * previous workspace is kept untouched on any failure.
   */
  workspace?: WorkspaceHooks
}

interface WorkspaceHooks {
  resolveVideoFile: (videoId: string) => string | undefined
  commitUpload: (input: {
    metadata: VideoMetadata
    tempPath: string
    contentType: string
    baseRevision: number
  }) => Promise<{ document: unknown }>
  revision: () => number
}

interface FfprobeSideData {
  rotation?: unknown
}

interface FfprobeDisposition {
  attached_pic?: unknown
}

interface FfprobeStream {
  codec_type?: unknown
  codec_name?: unknown
  width?: unknown
  height?: unknown
  avg_frame_rate?: unknown
  r_frame_rate?: unknown
  duration?: unknown
  tags?: Record<string, unknown>
  side_data_list?: unknown
  disposition?: unknown
}

interface FfprobeResult {
  streams?: unknown
  format?: unknown
}

interface ExpressError extends Error {
  status?: number
  statusCode?: number
  code?: string
}

interface VideoRequest extends Request {
  file?: Express.Multer.File
}

function getRequestPath(req: Request): string | undefined {
  const file = (req as VideoRequest).file
  if (file && typeof file.path === 'string' && file.path !== '') return file.path
  return undefined
}

function getRouteId(req: Request): string | undefined {
  const id = req.params.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

function toFinitePositive(value: unknown): number | undefined {
  const num = typeof value === 'number' ? value : Number.parseFloat(String(value))
  if (!Number.isFinite(num) || num <= 0) return undefined
  return num
}

function parseRational(value: unknown): number | undefined {
  const text = String(value ?? '').trim()
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(text)
  if (match) {
    const numerator = Number(match[1])
    const denominator = Number(match[2])
    if (denominator === 0 || numerator <= 0) return undefined
    return numerator / denominator
  }
  return toFinitePositive(value)
}

function parseNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const num = typeof value === 'number' ? value : Number.parseFloat(String(value))
  return Number.isFinite(num) ? num : undefined
}

function isAttachedPicture(stream: FfprobeStream): boolean {
  const disposition =
    stream.disposition && typeof stream.disposition === 'object'
      ? (stream.disposition as FfprobeDisposition)
      : undefined
  return disposition?.attached_pic === 1 || disposition?.attached_pic === true
}

function isVideoStream(stream: FfprobeStream): boolean {
  return stream.codec_type === 'video' && !isAttachedPicture(stream)
}

function parseRotation(stream: FfprobeStream): number {
  // Modern ffprobe reports rotation in side_data_list; the legacy tags.rotate
  // value is only used as a fallback.
  const sideData = Array.isArray(stream.side_data_list)
    ? (stream.side_data_list as FfprobeSideData[])
    : []
  for (const entry of sideData) {
    const rotation = parseNumber(entry?.rotation)
    if (rotation !== undefined) return rotation
  }

  const tagRotation = parseNumber(stream.tags?.rotate ?? stream.tags?.Rotation)
  if (tagRotation !== undefined) return tagRotation

  return 0
}

function computeDisplayDimensions(
  width: number,
  height: number,
  rotation: number,
): { width: number; height: number } {
  const normalized = ((Math.round(rotation) % 360) + 360) % 360
  if (normalized === 90 || normalized === 270) return { width: height, height: width }
  return { width, height }
}

function resolveContentType(formatName: unknown): string {
  if (typeof formatName !== 'string') return 'application/octet-stream'
  const first = formatName.split(',')[0]?.trim().toLowerCase()
  if (!first) return 'application/octet-stream'
  return FORMAT_CONTENT_TYPES[first] ?? 'application/octet-stream'
}

export async function createMediaService(
  dependencies: MediaServiceDependencies = {},
): Promise<MediaService> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cjzmw-uploads-'))

  /**
   * Registry of the single current video. With a workspace the entry is
   * derived from the persisted document, so the served file is always the one
   * the workspace references.
   */
  const videos = new Map<string, StoredVideo>()

  function getRecord(id: string | undefined): StoredVideo | undefined {
    if (!id) return undefined
    const hooks = dependencies.workspace
    if (!hooks) return videos.get(id)
    // The persisted file is authoritative; the registry only holds metadata.
    const filePath = hooks.resolveVideoFile(id)
    const record = videos.get(id)
    if (!filePath || !record) return undefined
    return { ...record, filePath }
  }
  const upload = multer({
    dest: tempDir,
    limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  })

  async function removeTempFile(filePath: string): Promise<boolean> {
    try {
      // Windows keeps an exclusive lock on open handles, so retries with a
      // delay are required before the temp file can actually be removed.
      await fs.rm(filePath, { force: true, maxRetries: 5, retryDelay: 100 })
      return true
    } catch (error) {
      console.error('Failed to remove temp file:', filePath, error)
      return false
    }
  }

  const router = express.Router()

  router.post(
    '/videos',
    (req: Request, res: Response, next: NextFunction) => {
      upload.single('video')(req, res, (error: unknown) => {
        if (!error) return next()

        const requestPath = getRequestPath(req)
        if (requestPath) {
          void removeTempFile(requestPath)
        }

        if (error instanceof multer.MulterError) {
          if (error.code === 'LIMIT_FILE_SIZE') {
            res.status(413).json({
              error: '上传的文件超过 2GB 大小限制。',
              code: 'FILE_TOO_LARGE',
            })
            return
          }
          res.status(400).json({
            error: '上传请求无效。',
            code: error.code,
          })
          return
        }

        next(error)
      })
    },
    async (req: Request, res: Response) => {
      const filePath = getRequestPath(req)
      if (!filePath) {
        res.status(400).json({ error: '缺少上传的视频文件。', code: 'NO_FILE' })
        return
      }

      let size: number
      try {
        const stat = await fs.stat(filePath)
        size = stat.size
      } catch {
        await removeTempFile(filePath)
        res.status(400).json({ error: '上传的视频文件不可用。', code: 'FILE_UNAVAILABLE' })
        return
      }

      const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe'

      let probeOutput: string
      try {
        const result = await execFileAsync(
          ffprobePath,
          ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath],
          { timeout: FFPROBE_TIMEOUT_MS, maxBuffer: FFPROBE_MAX_BUFFER },
        )
        probeOutput = typeof result.stdout === 'string' ? result.stdout : ''
      } catch (error) {
        await removeTempFile(filePath)

        const probeError = error as ExpressError
        if (probeError.code === 'ENOENT') {
          res.status(503).json({
            error: '服务器上未安装 ffprobe，无法分析视频。',
            code: 'FFPROBE_UNAVAILABLE',
          })
          return
        }

        if (probeError.code === 'ETIMEDOUT' || probeError.code === 'ABORT_ERR') {
          res.status(504).json({
            error: '视频分析超时，请稍后重试或上传更小的文件。',
            code: 'PROBE_TIMEOUT',
          })
          return
        }

        res.status(422).json({
          error: '无法解析上传的视频文件。',
          code: 'INVALID_VIDEO',
        })
        return
      }

      let probed: FfprobeResult
      try {
        probed = JSON.parse(probeOutput) as FfprobeResult
      } catch {
        await removeTempFile(filePath)
        res.status(422).json({ error: '无法解析上传的视频文件。', code: 'INVALID_VIDEO' })
        return
      }

      const streams = Array.isArray(probed.streams) ? (probed.streams as FfprobeStream[]) : []
      const videoStream = streams.find(isVideoStream)

      if (!videoStream) {
        await removeTempFile(filePath)
        res.status(422).json({
          error: '上传的文件不包含视频流，请上传有效的视频文件。',
          code: 'NO_VIDEO_STREAM',
        })
        return
      }

      const rawWidth = toFinitePositive(videoStream.width)
      const rawHeight = toFinitePositive(videoStream.height)

      const format =
        probed.format && typeof probed.format === 'object'
          ? (probed.format as { duration?: unknown; format_name?: unknown })
          : undefined

      const duration = toFinitePositive(format?.duration) ?? toFinitePositive(videoStream.duration)

      const fps =
        parseRational(videoStream.avg_frame_rate) ?? parseRational(videoStream.r_frame_rate)

      if (!rawWidth || !rawHeight || !duration || !fps) {
        await removeTempFile(filePath)
        res.status(422).json({
          error: '视频元数据无效或缺失，无法处理该文件。',
          code: 'INVALID_METADATA',
        })
        return
      }

      const safeRotation = parseRotation(videoStream)
      const { width, height } = computeDisplayDimensions(rawWidth, rawHeight, safeRotation)

      const totalFrames = Math.ceil(duration * fps)
      if (!Number.isSafeInteger(totalFrames) || totalFrames <= 0) {
        await removeTempFile(filePath)
        res.status(422).json({
          error: '视频帧率或时长超出可处理范围。',
          code: 'INVALID_FRAME_COUNT',
        })
        return
      }

      const codec = typeof videoStream.codec_name === 'string' ? videoStream.codec_name : 'unknown'
      const contentType = resolveContentType(format?.format_name)

      const originalName =
        typeof req.file?.originalname === 'string' && req.file.originalname !== ''
          ? path.basename(req.file.originalname)
          : 'video'

      const id = randomUUID()
      const metadata: VideoMetadata = {
        id,
        url: `/api/videos/${id}/content`,
        filename: originalName,
        size,
        duration,
        width,
        height,
        fps,
        codec,
      }

      // The probe/validation awaits above can outlive the client connection;
      // a discarded upload must not leave a temp file or registry entry behind.
      if (res.destroyed || req.aborted) {
        await removeTempFile(filePath)
        return
      }

      const hooks = dependencies.workspace
      if (!hooks) {
        videos.set(id, { metadata, filePath, contentType })

        // If the connection closes before the body reaches the client, the
        // registry entry would leak (and nothing can ever DELETE it), so drop it
        // again — but never for a response that was actually delivered.
        res.on('close', () => {
          if (res.writableFinished) return
          videos.delete(id)
          void removeTempFile(filePath)
        })

        res.status(201).json(metadata)
        return
      }

      // Persistence first: the workspace switch must be durable before the old
      // video/subtitles are replaced. Any failure keeps the old workspace.
      try {
        await hooks.commitUpload({
          metadata,
          tempPath: filePath,
          contentType,
          baseRevision: hooks.revision(),
        })
      } catch (error) {
        await removeTempFile(filePath)
        const commitError = error as ExpressError & { code?: string }
        if (commitError.code === 'WORKSPACE_CONFLICT') {
          res.status(409).json({
            error: '工作区已在其他标签页被修改，新视频未保存。',
            code: 'WORKSPACE_CONFLICT',
          })
          return
        }
        if (commitError.code === 'WORKSPACE_CORRUPT') {
          res.status(409).json({
            error: '工作区文件已损坏，无法保存新视频；请先修复或移走该文件。',
            code: 'WORKSPACE_CORRUPT',
          })
          return
        }
        console.error('Failed to persist uploaded video:', error)
        res.status(500).json({
          error: '保存视频到工作区失败，请稍后重试。',
          code: 'WORKSPACE_WRITE_FAILED',
        })
        return
      }

      // The workspace already copied the file; drop the temporary upload.
      await removeTempFile(filePath)
      videos.clear()
      videos.set(id, { metadata, filePath: filePath, contentType })
      res.status(201).json(metadata)
    },
  )

  router.get('/videos/:id/content', (req: Request, res: Response) => {
    const id = getRouteId(req)
    const record = getRecord(id)
    if (!record) {
      res.status(404).json({ error: '未找到该视频。', code: 'NOT_FOUND' })
      return
    }

    // Send via `root` + basename: an absolute path is resolved differently by
    // send under a non-ASCII working directory and 404s. The resolved path is
    // never exposed in the response.
    res.type(record.contentType)

    res.sendFile(path.basename(record.filePath), { root: path.dirname(record.filePath), acceptRanges: true }, (error?: Error) => {
      if (!error) return
      const streamError = error as ExpressError
      console.error('Video stream failed:', streamError.status, streamError.code, streamError.message)

      if (res.headersSent) {
        res.destroy(streamError)
        return
      }

      const status = streamError.status ?? streamError.statusCode
      if (status === 416 || streamError.code === 'EINVAL' || streamError.code === 'ERANGE') {
        const contentRange = res.getHeader('Content-Range')
        if (typeof contentRange === 'string' && contentRange !== '') {
          res.setHeader('Content-Range', contentRange)
        }
        res.status(416).end()
        return
      }

      if (streamError.code === 'ENOENT') {
        res.status(404).json({ error: '未找到该视频。', code: 'NOT_FOUND' })
        return
      }

      res.status(500).json({ error: '读取视频失败。', code: 'READ_FAILED' })
    })
  })

  router.head('/videos/:id/content', (req: Request, res: Response) => {
    const id = getRouteId(req)
    const record = getRecord(id)
    if (!record) {
      res.status(404).json({ error: '未找到该视频。', code: 'NOT_FOUND' })
      return
    }

    res.type(record.contentType)

    res.sendFile(path.basename(record.filePath), { root: path.dirname(record.filePath), acceptRanges: true }, (error?: Error) => {
      if (!error) return
      const streamError = error as ExpressError

      if (res.headersSent) {
        res.destroy(streamError)
        return
      }

      if (streamError.code === 'ENOENT') {
        res.status(404).json({ error: '未找到该视频。', code: 'NOT_FOUND' })
        return
      }

      res.status(500).json({ error: '读取视频失败。', code: 'READ_FAILED' })
    })
  })

  router.delete('/videos/:id', async (req: Request, res: Response) => {
    const id = getRouteId(req)
    const record = getRecord(id)
    if (!record) {
      res.status(404).json({ error: '未找到该视频。', code: 'NOT_FOUND' })
      return
    }

    // A running transcription reads the stored file, so the video must stay
    // pinned until the job stops referencing it.
    if (id && dependencies.isVideoBusy?.(id)) {
      res.status(409).json({
        error: '该视频正在进行语音识别，暂时无法删除。',
        code: 'VIDEO_BUSY',
      })
      return
    }

    // The workspace is persistent: deleting the current video would be a
    // silent data loss, so the client simply cannot remove it any more.
    if (dependencies.workspace) {
      res.status(409).json({
        error: '当前视频属于持久工作区，不能删除；请上传新视频来替换。',
        code: 'VIDEO_PERSISTED',
      })
      return
    }

    const removed = await removeTempFile(record.filePath)
    if (!removed) {
      res.status(500).json({ error: '删除视频文件失败，请稍后重试。', code: 'DELETE_FAILED' })
      return
    }

    if (id) videos.delete(id)
    res.status(204).end()
  })

  /** Registered before the media router so unknown `/api/asr/*` paths 404. */
  router.use('/asr', (_req: Request, res: Response) => {
    res.status(404).json({ error: '未找到该请求的接口。', code: 'NOT_FOUND' })
  })

  router.use('/videos/:id', (_req: Request, res: Response) => {
    res.status(404).json({ error: '未找到该请求的接口。', code: 'NOT_FOUND' })
  })

  router.use((_req: Request, res: Response) => {
    res.status(404).json({ error: '未找到该请求的接口。', code: 'NOT_FOUND' })
  })

  router.use((error: ExpressError, _req: Request, res: Response, _next: NextFunction) => {
    // Generic (disk/multer/internal) failures end up here; never leak a stack
    // trace or an absolute path to the client.
    console.error('Media request failed:', error)
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.status(500).json({ error: '视频服务发生内部错误。', code: 'INTERNAL_ERROR' })
  })

  const cleanup = async (): Promise<void> => {
    videos.clear()
    try {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (error) {
      console.error('Failed to remove media temp directory:', tempDir, error)
    }
  }

  return {
    router,
    cleanup,
    findVideo: (id) => getRecord(id),
    restore: (video) => {
      videos.clear()
      if (!video) return
      videos.set(video.id, {
        metadata: video,
        filePath: '',
        contentType: 'video/mp4',
      })
    },
  }
}
