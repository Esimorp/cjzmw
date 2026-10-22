import { AbsoluteFill, staticFile } from 'remotion'
import { Video } from '@remotion/media'
import './player-fonts'
import './subtitles.css'
import { SubtitleProvider } from './SubtitleProvider'
import { SubtitlePlayerLayer } from './SubtitlePlayerLayer'
import { SubtitleTokenStyleProvider } from './SubtitleTokenStyleProvider'
import type { SubtitleTokenStyle } from './subtitle-token-style'
import type { SubtitleSegment } from './subtitle-types'
import type { VideoMetadata } from './video-types'

/**
 * Input props of the composition (a snapshot, never live editor state).
 *
 * The index signature is required by Remotion's `Props extends
 * Record<string, unknown>` constraint (`Composition`, `selectComposition`).
 */
export interface VideoStageProps extends Record<string, unknown> {
  video: VideoMetadata
  segments: SubtitleSegment[]
  styles?: Record<string, SubtitleTokenStyle>
  /** Player-only error sink; the renderer leaves it undefined. */
  onPlaybackError?: (message: string) => void
}

/**
 * Resolve the video URL for the composition.
 *
 * Uploaded videos are static files under `public/videos`, so `staticFile()`
 * turns `publicPath` (`videos/<id>.<ext>`) into the URL the current bundle
 * serves — `/videos/<id>.<ext>` in the app, `/public/videos/<id>.<ext>` inside a
 * Remotion bundle (where `remotion_staticBase` is `/public`). The `public/`
 * prefix is added by Remotion itself, never by hand here.
 *
 * Documents migrated before `publicPath` existed carry only `url`; that legacy
 * value is used as-is.
 */
function resolveVideoSrc(video: VideoMetadata): string {
  return video.publicPath ? staticFile(video.publicPath) : video.url
}

/**
 * Video surface used by the player, the SSR preview and the exporter.
 *
 * `@remotion/media`'s `<Video>` decodes through the browser/WebCodecs pipeline
 * for both preview and render, so the exported MP4 matches the preview.
 * `disallowFallbackToOffthreadVideo` removes the silent fallback: a decode
 * failure fails the render instead of quietly switching to another element,
 * and `onError` returns `'fail'` after reporting the original error.
 */
function VideoStageBody({
  video,
  onPlaybackError,
}: {
  video: VideoMetadata
  onPlaybackError: (message: string) => void
}) {
  return (
    <Video
      src={resolveVideoSrc(video)}
      disallowFallbackToOffthreadVideo
      objectFit="contain"
      style={{ width: '100%', height: '100%' }}
      onError={(error) => {
        console.error('Video playback failed:', error)
        onPlaybackError('视频播放失败，请重新选择文件后再试')
        return 'fail'
      }}
    />
  )
}

/**
 * Remotion composition: the video plus the burn-in subtitle layer.
 *
 * The player renders its `component` inside its own React tree, so the app
 * contexts are not inherited. Snapshot props are therefore re-provided here —
 * a bridge, not a second editable copy: nothing in the composition writes back.
 * The exporter reuses this exact component, so the MP4 matches the preview.
 */
export function VideoStage({
  video,
  segments,
  styles,
  onPlaybackError,
}: VideoStageProps) {
  return (
    <AbsoluteFill
      style={{ backgroundColor: '#000', justifyContent: 'center' }}
    >
      <SubtitleTokenStyleProvider initialStyles={styles}>
        <SubtitleProvider segments={segments}>
          <VideoStageBody
            video={video}
            onPlaybackError={onPlaybackError ?? (() => undefined)}
          />
          <SubtitlePlayerLayer />
        </SubtitleProvider>
      </SubtitleTokenStyleProvider>
    </AbsoluteFill>
  )
}
