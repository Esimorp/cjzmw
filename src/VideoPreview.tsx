import { useState, type CSSProperties } from 'react'
import { Player } from '@remotion/player'
import { AbsoluteFill, Html5Video } from 'remotion'
import { SubtitleProvider } from './SubtitleProvider'
import { useSubtitles } from './SubtitleContext'
import { SubtitlePlayerLayer } from './SubtitlePlayerLayer'
import { SubtitleTokenStyleProvider } from './SubtitleTokenStyleProvider'
import { useSubtitleTokenStyle, type SubtitleTokenStyle } from './subtitle-token-style'
import type { SubtitleSegment } from './subtitle-types'
import type { VideoMetadata } from './video-types'

/**
 * Remotion's `<Player>` renders its `component` inside its own React tree, so
 * the app-level contexts are not inherited. The player therefore receives
 * read-only snapshots through `inputProps` (`segments` and the registered
 * `styles`) and `VideoStage` re-provides both contexts — a bridge, not a second
 * editable copy: nothing in the composition writes back and no component here
 * calls `setSegments` or `registerStyle`.
 *
 * Passing `styles` is required: the composition must resolve the same registry
 * entries as the editor, including custom registrations, instead of silently
 * falling back to only the built-in default.
 */
function VideoStageBody({
  video,
  onPlaybackError,
}: {
  video: VideoMetadata
  onPlaybackError: (message: string) => void
}) {
  return (
    <Html5Video
      src={video.url}
      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
      onError={() => onPlaybackError('视频播放失败，请重新选择文件后再试')}
    />
  )
}

export function VideoStage({
  video,
  segments,
  styles,
  onPlaybackError,
}: {
  video: VideoMetadata
  /** Read-only snapshot bridged from the app-level SubtitleContext. */
  segments: SubtitleSegment[]
  /** Read-only snapshot of the app-level token style registry. */
  styles?: Record<string, SubtitleTokenStyle>
  onPlaybackError: (message: string) => void
}) {
  return (
    <AbsoluteFill
      style={{ backgroundColor: '#000', justifyContent: 'center' }}
    >
      <SubtitleTokenStyleProvider initialStyles={styles}>
        <SubtitleProvider initialSegments={segments}>
          <VideoStageBody video={video} onPlaybackError={onPlaybackError} />
          <SubtitlePlayerLayer />
        </SubtitleProvider>
      </SubtitleTokenStyleProvider>
    </AbsoluteFill>
  )
}

export function VideoPreview({ video }: { video: VideoMetadata }) {
  const [error, setError] = useState<string | null>(null)
  const { segments } = useSubtitles()
  const { styles } = useSubtitleTokenStyle()

  const fps = video.fps
  const width = Math.max(1, Math.round(video.width) || 1)
  const height = Math.max(1, Math.round(video.height) || 1)
  const durationInFrames = Math.max(
    1,
    Math.ceil((video.duration > 0 ? video.duration : 0) * fps),
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
}
