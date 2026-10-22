import type { VideoMetadata } from './video-types'

/**
 * Frame dimensions and count shared by the player and the export renderer, so
 * the exported file has exactly the preview's timeline.
 */
export function resolveCompositionSize(video: VideoMetadata) {
  const width = Math.max(1, Math.round(video.width) || 1)
  const height = Math.max(1, Math.round(video.height) || 1)
  const fps = Number.isFinite(video.fps) && video.fps > 0 ? video.fps : 30
  const durationInFrames = Math.max(
    1,
    Math.ceil((video.duration > 0 ? video.duration : 0) * fps),
  )
  return { width, height, fps, durationInFrames }
}
