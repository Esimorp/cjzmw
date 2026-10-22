import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { Player, type PlayerRef } from '@remotion/player'
import { resolveCompositionSize } from './composition'
import { useSubtitles } from './SubtitleContext'
import { useSubtitleTokenStyle } from './subtitle-token-style'
import { VideoStage } from './VideoStage'
import type { VideoMetadata } from './video-types'

export interface VideoPreviewHandle {
  /**
   * Jump the player to an absolute time in seconds (clamped to the video).
   * `pause` stops playback first so the target frame can be inspected.
   */
  seekToSeconds: (seconds: number, options?: { pause?: boolean }) => void
}

/** Remotion player for the current video; exposes seeking to the editor. */
export const VideoPreview = forwardRef<
  VideoPreviewHandle,
  { video: VideoMetadata }
>(function VideoPreview({ video }, ref) {
  const [error, setError] = useState<string | null>(null)
  const { segments } = useSubtitles()
  const { styles } = useSubtitleTokenStyle()
  const playerRef = useRef<PlayerRef>(null)

  const { width, height, fps, durationInFrames } = resolveCompositionSize(video)

  useImperativeHandle(
    ref,
    () => ({
      seekToSeconds(seconds: number, options?: { pause?: boolean }) {
        const player = playerRef.current
        if (!player || !Number.isFinite(seconds)) return
        if (options?.pause) player.pause()
        // Ceil so the frame lands at or after the requested time; rounding
        // could seek to the frame just before a segment starts.
        const frame = Math.ceil(Math.max(0, seconds) * fps)
        player.seekTo(Math.min(frame, durationInFrames - 1))
      },
    }),
    [fps, durationInFrames],
  )

  return (
    <div className="preview-stage">
      <div
        className="preview-frame"
        style={
          {
            '--preview-ratio': width / height,
          } as CSSProperties
        }
      >
        <Player
          key={video.id}
          ref={playerRef}
          component={VideoStage}
          inputProps={{
            video,
            segments,
            styles,
            onPlaybackError: (message: string) => setError(message),
          }}
          compositionWidth={width}
          compositionHeight={height}
          fps={fps}
          durationInFrames={durationInFrames}
          controls
          style={{ width: '100%', height: '100%' }}
          errorFallback={({ error: playerError }) => (
            <p className="preview-error" role="alert">
              {`视频渲染失败，请重新选择文件后再试（${playerError.message}）`}
            </p>
          )}
        />
      </div>
      {error ? (
        <p className="preview-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
})
