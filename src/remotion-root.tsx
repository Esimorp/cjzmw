import { Composition } from 'remotion'
import { resolveCompositionSize } from './composition'
import { SAMPLE_SEGMENTS } from './subtitle-sample'
import { VideoStage, type VideoStageProps } from './VideoStage'

/** Placeholder used only until `calculateMetadata` sees the real props. */
const DEFAULT_PROPS: VideoStageProps = {
  video: {
    id: 'placeholder',
    url: '',
    filename: '',
    size: 0,
    duration: 60,
    width: 1080,
    height: 1920,
    fps: 30,
    codec: 'h264',
  },
  segments: SAMPLE_SEGMENTS,
}

/**
 * Composition registry for `@remotion/renderer`.
 *
 * Only `subtitle-video` is registered: the renderer selects it by id and the
 * dimensions/frame count are computed from the video passed through
 * `inputProps`, so the export always matches the player's timeline.
 */
export function RemotionRoot() {
  return (
    <Composition
      id="subtitle-video"
      component={VideoStage}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={1800}
      defaultProps={DEFAULT_PROPS}
      calculateMetadata={({ props }) => resolveCompositionSize(props.video)}
    />
  )
}
