import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import type { NextFunction, Request, Response, Router } from 'express'
import type { SubtitleSegment } from './src/subtitle-types.ts'
import type { VideoMetadata } from './src/video-types.ts'

/**
 * Persisted workspace: one JSON document describing the current video and all
 * subtitle segments. The video file itself lives next to the JSON and is never
 * embedded in it.
 */
export interface WorkspaceDocument {
  revision: number
  video: VideoMetadata | null
  videoFile: string | null
  segments: SubtitleSegment[]
  updatedAt: string
}

interface StoredWorkspace {
  document: WorkspaceDocument
  /** Set while the JSON could not be read; blocks writes from clobbering it. */
  corrupt: boolean
  corruptReason?: string
}

export interface WorkspaceService {
  router: Router
  /** Directory holding the workspace JSON. */
  readonly dir: string
  /** Static root that serves the video files (the app's `public` directory). */
  readonly publicDir: string
  /** Resolve the persisted video file, validating it stays inside `publicDir/videos`. */
  resolveVideoFile: (videoId: string) => string | undefined
  /** Persist a newly uploaded video and reset the subtitle segments. */
  commitUpload: (input: {
    metadata: VideoMetadata
    tempPath: string
    contentType: string
    baseRevision: number
  }) => Promise<{ document: WorkspaceDocument; filePath: string }>
  get: () => WorkspaceDocument
  revision: () => number
  cleanup: () => Promise<void>
}

const MAX_SEGMENTS = 5000
const MAX_TOKENS_PER_SEGMENT = 5000
const BODY_LIMIT = '32mb'
const MAX_VIDEO_FILENAME_LENGTH = 128

class WorkspaceError extends Error {
  readonly code: string
  readonly status: number

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'WorkspaceError'
    this.code = code
    this.status = status
  }
}

function emptyDocument(): WorkspaceDocument {
  return {
    revision: 0,
    video: null,
    videoFile: null,
    segments: [],
    updatedAt: new Date().toISOString(),
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function validateVideoMetadata(value: unknown): VideoMetadata | null {
  if (value === null) return null
  if (!value || typeof value !== 'object') {
    throw new WorkspaceError(400, 'INVALID_WORKSPACE', '工作区视频信息格式无效。')
  }
  const video = value as Partial<VideoMetadata>
  if (
    typeof video.id !== 'string' ||
    video.id === '' ||
    typeof video.url !== 'string' ||
    typeof video.filename !== 'string' ||
    !isFiniteNumber(video.size) ||
    !isFiniteNumber(video.duration) ||
    !isFiniteNumber(video.width) ||
    !isFiniteNumber(video.height) ||
    !isFiniteNumber(video.fps) ||
    typeof video.codec !== 'string'
  ) {
    throw new WorkspaceError(400, 'INVALID_WORKSPACE', '工作区视频信息格式无效。')
  }
  return {
    id: video.id,
    url: video.url,
    ...(typeof video.publicPath === 'string' && video.publicPath !== ''
      ? { publicPath: video.publicPath }
      : {}),
    filename: video.filename,
    size: video.size,
    duration: video.duration,
    width: video.width,
    height: video.height,
    fps: video.fps,
    codec: video.codec,
  }
}

/** Validate a subtitle tree coming from disk or from the client. */
export function validateSegments(value: unknown): SubtitleSegment[] {
  if (!Array.isArray(value)) {
    throw new WorkspaceError(400, 'INVALID_WORKSPACE', '工作区字幕格式无效。')
  }
  if (value.length > MAX_SEGMENTS) {
    throw new WorkspaceError(400, 'INVALID_WORKSPACE', '工作区字幕段数过多。')
  }
  const seenSegmentIds = new Set<string>()
  const seenTokenIds = new Set<string>()
  return value.map((rawSegment) => {
    if (!rawSegment || typeof rawSegment !== 'object') {
      throw new WorkspaceError(400, 'INVALID_WORKSPACE', '工作区字幕格式无效。')
    }
    const segment = rawSegment as {
      id?: unknown
      tokens?: unknown
      start?: unknown
      end?: unknown
    }
    if (typeof segment.id !== 'string' || segment.id === '' || seenSegmentIds.has(segment.id)) {
      throw new WorkspaceError(400, 'INVALID_WORKSPACE', '工作区字幕段标识无效。')
    }
    seenSegmentIds.add(segment.id)
    if (!Array.isArray(segment.tokens) || segment.tokens.length > MAX_TOKENS_PER_SEGMENT) {
      throw new WorkspaceError(400, 'INVALID_WORKSPACE', '工作区字幕词元格式无效。')
    }
    const tokens = segment.tokens.map((rawToken) => {
      if (!rawToken || typeof rawToken !== 'object') {
        throw new WorkspaceError(400, 'INVALID_WORKSPACE', '工作区字幕词元格式无效。')
      }
      const token = rawToken as {
        id?: unknown
        text?: unknown
        start?: unknown
        end?: unknown
        timingSource?: unknown
        styleName?: unknown
        units?: unknown
      }
      if (
        typeof token.id !== 'string' ||
        token.id === '' ||
        seenTokenIds.has(token.id) ||
        typeof token.text !== 'string'
      ) {
        throw new WorkspaceError(400, 'INVALID_WORKSPACE', '工作区字幕词元格式无效。')
      }
      seenTokenIds.add(token.id)
      const timingSource =
        token.timingSource === 'model' ||
        token.timingSource === 'interpolated' ||
        token.timingSource === 'unmatched'
          ? token.timingSource
          : 'unmatched'
      const start = token.start === null ? null : isFiniteNumber(token.start) ? token.start : null
      const end = token.end === null ? null : isFiniteNumber(token.end) ? token.end : null
      const units = Array.isArray(token.units)
        ? token.units.flatMap((rawUnit) => {
            if (!rawUnit || typeof rawUnit !== 'object') return []
            const unit = rawUnit as { char?: unknown; start?: unknown; end?: unknown }
            if (typeof unit.char !== 'string') return []
            return [
              {
                char: unit.char,
                start: isFiniteNumber(unit.start) ? unit.start : null,
                end: isFiniteNumber(unit.end) ? unit.end : null,
              },
            ]
          })
        : undefined
      const out: SubtitleSegment['tokens'][number] = {
        id: token.id,
        text: token.text,
        start,
        end,
        timingSource,
      }
      // Optional style reference: preserved when valid, dropped otherwise so
      // older documents (without the field) stay compatible.
      if (typeof token.styleName === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(token.styleName)) {
        out.styleName = token.styleName
      }
      if (units && units.length > 0) out.units = units
      return out
    })
    const out: SubtitleSegment = { id: segment.id, tokens }
    if (isFiniteNumber(segment.start)) out.start = segment.start
    if (isFiniteNumber(segment.end)) out.end = segment.end
    return out
  })
}

/** Reject anything that could escape the workspace directory. */
function assertSafeBasename(name: string): string {
  if (
    name === '' ||
    name.length > MAX_VIDEO_FILENAME_LENGTH ||
    name !== path.basename(name) ||
    name === '.' ||
    name === '..' ||
    /[\\/:*?"<>|]/.test(name)
  ) {
    throw new WorkspaceError(400, 'INVALID_WORKSPACE', '工作区视频引用无效。')
  }
  return name
}

/**
 * Validate a path relative to the static `public` root: it must stay inside
 * `videos/`, contain no separators beyond that prefix and no traversal parts.
 */
function assertSafePublicPath(publicPath: string): string {
  const normalized = publicPath.replace(/\\/g, '/')
  if (normalized.length > 256 || normalized.startsWith('/')) {
    throw new WorkspaceError(400, 'INVALID_WORKSPACE', '工作区视频路径无效。')
  }
  const parts = normalized.split('/')
  if (parts.length !== 2 || parts[0] !== PUBLIC_VIDEOS_DIR) {
    throw new WorkspaceError(400, 'INVALID_WORKSPACE', '工作区视频路径无效。')
  }
  assertSafeBasename(parts[1])
  return `${PUBLIC_VIDEOS_DIR}/${parts[1]}`
}

export interface WorkspaceServiceOptions {
  /** Root directory; defaults to `WORKSPACE_DIR` or `<repo>/storage/workspace`. */
  dir?: string
  /**
   * Static root that serves video files; defaults to `PUBLIC_DIR` or
   * `<repo>/public`. Videos are stored under `<publicDir>/videos/`.
   */
  publicDir?: string
}

/** Directory (relative to the public root) holding the persisted videos. */
const PUBLIC_VIDEOS_DIR = 'videos'

export async function createWorkspaceService(
  options: WorkspaceServiceOptions = {},
): Promise<WorkspaceService> {
  const dir = path.resolve(
    options.dir ?? process.env.WORKSPACE_DIR ?? path.join(process.cwd(), 'storage', 'workspace'),
  )
  const documentPath = path.join(dir, 'workspace.json')
  const publicDir = path.resolve(
    options.publicDir ?? process.env.PUBLIC_DIR ?? path.join(process.cwd(), 'public'),
  )
  /** Static root for videos; the browser loads them as `/videos/<name>`. */
  const videosDir = path.join(publicDir, PUBLIC_VIDEOS_DIR)
  /** Legacy location: videos used to live next to the workspace JSON. */
  const legacyVideosDir = path.join(dir, 'videos')
  await fs.mkdir(videosDir, { recursive: true })

  let current: StoredWorkspace = { document: emptyDocument(), corrupt: false }
  let writeChain: Promise<void> = Promise.resolve()

  /**
   * Move a pre-`public/videos` workspace forward.
   *
   * Old documents referenced `videos/<name>` inside the workspace directory and
   * used the `/api/videos/<id>/content` proxy URL. When such a file is still
   * present it is **copied** (not moved) into `<public>/videos`, the JSON is
   * rewritten only after the copy is verified, and the legacy file is removed
   * last. Any failure leaves the original document and file untouched, so a
   * broken migration can never delete or blank existing data.
   */
  async function migrateLegacyVideo(document: WorkspaceDocument): Promise<WorkspaceDocument> {
    if (!document.video || !document.videoFile) return document
    if (document.video.publicPath) return document

    const legacyPath = path.join(legacyVideosDir, document.videoFile)
    const target = path.join(videosDir, document.videoFile)
    const publicPath = `${PUBLIC_VIDEOS_DIR}/${document.videoFile}`

    let targetReady = true
    try {
      const legacyStat = await fs.stat(legacyPath)
      targetReady = false
      await fs.copyFile(legacyPath, target)
      const copied = await fs.stat(target)
      if (!copied.isFile() || copied.size !== legacyStat.size) {
        throw new Error('copied video size mismatch')
      }
      targetReady = true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        // Leave the document and the legacy file exactly as they were.
        console.error('Workspace video migration failed:', error)
        return document
      }
      // No legacy file: fall back to an existing public copy if one is there.
      targetReady = await fileExists(target)
    }

    const migrated: WorkspaceDocument = {
      ...document,
      video: {
        ...document.video,
        publicPath,
        url: `/${publicPath}`,
      },
    }
    if (!targetReady) {
      // Point at the static path anyway; the missing-file check reports it and
      // the legacy file (if any) is left in place.
      return migrated
    }
    try {
      await persist(migrated)
    } catch (error) {
      console.error('Workspace video migration could not be persisted:', error)
      return document
    }
    await fs.rm(legacyPath, { force: true }).catch(() => undefined)
    return migrated
  }

  /** Read the document, quarantining (not deleting) a corrupt file. */
  async function load(): Promise<StoredWorkspace> {
    let raw: string
    try {
      raw = await fs.readFile(documentPath, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { document: emptyDocument(), corrupt: false }
      }
      throw error
    }
    try {
      const parsed = JSON.parse(raw) as Partial<WorkspaceDocument>
      const video = validateVideoMetadata(parsed.video ?? null)
      const segments = validateSegments(parsed.segments ?? [])
      const videoFile =
        typeof parsed.videoFile === 'string' ? assertSafeBasename(parsed.videoFile) : null
      const publicPath =
        typeof parsed.video?.publicPath === 'string' && parsed.video.publicPath !== ''
          ? assertSafePublicPath(parsed.video.publicPath)
          : undefined
      return {
        document: {
          revision: isFiniteNumber(parsed.revision) ? parsed.revision : 0,
          video: video ? (publicPath ? { ...video, publicPath } : video) : null,
          videoFile: video ? videoFile : null,
          segments,
          updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
        },
        corrupt: false,
      }
    } catch (error) {
      // Keep the original file untouched; surface a recovery error instead.
      console.error('Workspace JSON is unreadable:', error)
      return {
        document: emptyDocument(),
        corrupt: true,
        corruptReason: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /** Serialize writes and replace the JSON atomically via a temp file. */
  async function persist(document: WorkspaceDocument): Promise<void> {
    const body = JSON.stringify(document, null, 2)
    const tempPath = `${documentPath}.${randomUUID()}.tmp`
    await fs.writeFile(tempPath, body, 'utf-8')
    await fs.rename(tempPath, documentPath)
  }

  function enqueueWrite(task: () => Promise<void>): Promise<void> {
    const run = writeChain.then(task, task)
    writeChain = run.catch(() => undefined)
    return run
  }

  function assertWritable(): void {
    if (current.corrupt) {
      throw new WorkspaceError(
        409,
        'WORKSPACE_CORRUPT',
        '工作区文件已损坏，无法保存；请先修复或移走该文件。',
      )
    }
  }

  current = await load()
  if (!current.corrupt) {
    current = { document: await migrateLegacyVideo(current.document), corrupt: false }
  }

  /** Resolve a persisted video file, guaranteeing it lives under `videos/`. */
  function resolveVideoFile(videoId: string): string | undefined {
    const document = current.document
    if (!document.video || document.video.id !== videoId || !document.videoFile) return undefined
    let safeName: string
    try {
      safeName = assertSafeBasename(document.videoFile)
    } catch {
      return undefined
    }
    const resolved = path.resolve(videosDir, safeName)
    const prefix = path.resolve(videosDir) + path.sep
    if (!resolved.startsWith(prefix)) return undefined
    return resolved
  }

  async function fileExists(filePath: string | null): Promise<boolean> {
    if (!filePath) return false
    try {
      const stat = await fs.stat(filePath)
      return stat.isFile() && stat.size > 0
    } catch {
      return false
    }
  }

  /** REST surface: read, replace, and upload-triggered commit. */
  const router = express.Router()
  const json = express.json({ limit: BODY_LIMIT })

  router.get('/workspace', async (_req: Request, res: Response) => {
    const document = current.document
    const videoPath = resolveVideoFile(document.video?.id ?? '')
    const videoFileMissing = document.video !== null && !(await fileExists(videoPath ?? null))
    res.json({
      workspace: document,
      writable: !current.corrupt,
      corrupt: current.corrupt,
      restoreError: current.corrupt
        ? '工作区数据无法读取，已保留原文件；当前不会自动保存。'
        : videoFileMissing
          ? '工作区中记录的视频文件缺失。'
          : null,
      videoFileMissing,
    })
  })

  router.put('/workspace', (req: Request, res: Response, next: NextFunction) => {
    json(req, res, (error?: unknown) => {
      if (error) {
        const bodyError = error as { status?: number; type?: string }
        const tooLarge = bodyError.type === 'entity.too.large'
        if (typeof bodyError.status === 'number' && bodyError.status >= 400 && bodyError.status < 500) {
          res.status(tooLarge ? 413 : 400).json({
            error: tooLarge ? '工作区数据过大。' : '工作区请求格式无效。',
            code: tooLarge ? 'WORKSPACE_BODY_TOO_LARGE' : 'INVALID_WORKSPACE',
          })
          return
        }
        next(error)
        return
      }
      void (async () => {
        try {
          assertWritable()
          const body = (req.body ?? {}) as {
            revision?: unknown
            video?: unknown
            segments?: unknown
          }
          if (!isFiniteNumber(body.revision)) {
            throw new WorkspaceError(400, 'INVALID_WORKSPACE', '缺少工作区版本号。')
          }
          const document = current.document
          if (body.revision !== document.revision) {
            throw new WorkspaceError(
              409,
              'WORKSPACE_CONFLICT',
              '工作区已在其他标签页被修改，请刷新后再保存。',
            )
          }
          // Preview the next document before the first write-side await.
          const preview: WorkspaceDocument = {
            ...document,
            revision: document.revision + 1,
            segments: [],
            updatedAt: new Date().toISOString(),
          }
          // Reserve the revision synchronously so a concurrent save or upload
          // cannot also succeed with this base revision.
          current = { ...current, document: preview }
          try {
            const video = validateVideoMetadata(body.video ?? null)
            // Saving may never introduce a different video than the one on disk.
            if ((video?.id ?? null) !== (document.video?.id ?? null)) {
              throw new WorkspaceError(
                409,
                'WORKSPACE_VIDEO_MISMATCH',
                '工作区视频已变更，请刷新后再保存。',
              )
            }
            const segments = validateSegments(body.segments ?? [])
            const next: WorkspaceDocument = { ...preview, segments }
            if (document.video && !(await fileExists(resolveVideoFile(document.video.id) ?? null)) && !current.corrupt) {
              throw new WorkspaceError(409, 'WORKSPACE_VIDEO_MISSING', '工作区视频文件缺失，无法保存。')
            }
            await enqueueWrite(() => persist(next))
            current = { ...current, document: next }
            res.status(200).json({ workspace: next })
          } catch (reservationError) {
            // Nothing was written: restore the previous revision.
            current = { ...current, document }
            throw reservationError
          }
        } catch (writeError) {
          next(writeError)
        }
      })()
    })
  })

  async function commitUpload(input: {
    metadata: VideoMetadata
    tempPath: string
    contentType: string
    baseRevision: number
  }): Promise<{ document: WorkspaceDocument; filePath: string }> {
    assertWritable()
    if (input.baseRevision !== current.document.revision) {
      throw new WorkspaceError(
        409,
        'WORKSPACE_CONFLICT',
        '工作区已被其他标签页修改，新视频未保存。',
      )
    }
    const previousFile = current.document.videoFile
    // Reserve the revision *synchronously* before the first await, otherwise
    // two concurrent uploads both pass the check above and the later one
    // silently wins.
    const previousDocument = current.document
    current = {
      ...current,
      document: {
        ...previousDocument,
        revision: previousDocument.revision + 1,
        updatedAt: new Date().toISOString(),
      },
    }
    const reservedRevision = current.document.revision

    const fileName = `${input.metadata.id}${path.extname(input.metadata.filename).slice(0, 10)}`
    const safeName = assertSafeBasename(fileName)
    const target = path.join(videosDir, safeName)
    const publicPath = `${PUBLIC_VIDEOS_DIR}/${safeName}`

    try {
      // Copy (never move) so the temp file can still be reconciled on failure.
      await fs.copyFile(input.tempPath, target)

      const next: WorkspaceDocument = {
        revision: reservedRevision,
        // The URL is always server-derived: client-supplied paths are ignored.
        video: { ...input.metadata, url: `/${publicPath}`, publicPath },
        videoFile: safeName,
        segments: [],
        updatedAt: new Date().toISOString(),
      }
      await enqueueWrite(() => persist(next))
      current = { ...current, document: next }
      // Only after the new document is durable may the old file be removed.
      if (previousFile && previousFile !== safeName) {
        const previousPath = path.resolve(videosDir, previousFile)
        if (previousPath.startsWith(path.resolve(videosDir) + path.sep)) {
          await fs.rm(previousPath, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined)
        }
      }
      await fs.rm(input.tempPath, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined)
      return { document: next, filePath: target }
    } catch (error) {
      // Roll the reservation back so the old workspace stays authoritative.
      current = { ...current, document: previousDocument }
      await fs.rm(target, { force: true }).catch(() => undefined)
      throw error
    }
  }

  function get(): WorkspaceDocument {
    return current.document
  }

  function revision(): number {
    return current.document.revision
  }

  router.use('/workspace', (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      res.destroy()
      return
    }
    if (error instanceof WorkspaceError) {
      res.status(error.status).json({ error: error.message, code: error.code })
      return
    }
    console.error('Workspace request failed:', error)
    res.status(500).json({ error: '工作区服务发生内部错误。', code: 'INTERNAL_ERROR' })
  })

  async function cleanup(): Promise<void> {
    // Persist whatever the server last accepted; never delete the workspace.
    await enqueueWrite(() => persist(current.document)).catch((error) => {
      console.error('Failed to flush workspace on shutdown:', error)
    })
  }

  return { router, dir, publicDir, resolveVideoFile, commitUpload, get, revision, cleanup }
}
