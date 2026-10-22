import type { SubtitleTokenStyle } from './subtitle-token-style'
import type { SubtitleSegment } from './subtitle-types'

export type ExportJobStatus =
  | 'preparing'
  | 'rendering'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** Server-side Remotion export job (see `export-server.ts`). */
export interface ExportJob {
  id: string
  status: ExportJobStatus
  /** `0`-`1` overall progress. */
  progress: number
  message: string
  filename: string
  error: string | null
  downloadUrl: string | null
}

/** Failure with a message that is safe to display in the UI. */
export class ExportRequestError extends Error {}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload: unknown = await response.json()
    if (payload && typeof payload === 'object') {
      const { error } = payload as { error?: unknown }
      if (typeof error === 'string' && error.trim() !== '') return error
    }
  } catch {
    // Fall through to the generic message.
  }
  return fallback
}

async function expectJob(response: Response, fallback: string): Promise<ExportJob> {
  if (!response.ok) throw new ExportRequestError(await readError(response, fallback))
  return (await response.json()) as ExportJob
}

/** Queue an export of the given subtitle snapshot for the current video. */
export async function createExportJob(input: {
  segments: SubtitleSegment[]
  styles: Record<string, SubtitleTokenStyle>
}): Promise<ExportJob> {
  const response = await fetch('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ segments: input.segments, styles: input.styles }),
  })
  return expectJob(response, '导出启动失败，请稍后重试')
}

/** Read the current state of a job; `signal` stops a pending poll. */
export async function fetchExportJob(
  id: string,
  signal?: AbortSignal,
): Promise<ExportJob> {
  const response = await fetch(`/api/export/${encodeURIComponent(id)}`, { signal })
  return expectJob(response, '导出状态查询失败，请稍后重试')
}

/** Ask the server to stop a running render (best effort). */
export async function cancelExportJob(id: string): Promise<void> {
  await fetch(`/api/export/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    keepalive: true,
  }).catch(() => undefined)
}

/** Start the browser download for a completed job. */
export function downloadExportFile(job: ExportJob) {
  if (job.downloadUrl === null) return
  const anchor = document.createElement('a')
  anchor.href = job.downloadUrl
  anchor.download = job.filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}
