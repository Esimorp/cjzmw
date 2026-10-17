import { Fragment } from 'react'
import { AbsoluteFill } from 'remotion'
import { useActiveSubtitles } from './useActiveSubtitles'
import { isLineBreakToken } from './subtitle-linebreak'

/**
 * Player captions rendered inside a Remotion composition.
 *
 * Behavior:
 * - Shows every token of each segment active at the current frame, not only
 *   the token whose range covers the frame. A segment therefore stays on screen
 *   for its whole derived `[start, end)` span, including gaps between tokens.
 * - Each token resolves its classes from the shared style registry via
 *   `styleName`; the focused class is applied only while
 *   `token.start <= t < token.end`. The editor's `isInspected` selection and
 *   DOM focus never influence playback styling.
 * - Segments with missing, non-finite, negative or non-positive ranges never
 *   activate, and overlapping segments are all rendered, so nothing is
 *   silently dropped.
 * - Uses its own `player-caption*` classes (no `token-chip` paper look); the
 *   registered default classes still provide colour, size and margins.
 */
export function SubtitlePlayerLayer() {
  const { playbackSegments } = useActiveSubtitles()

  if (playbackSegments.length === 0) return null

  return (
    <AbsoluteFill className="player-caption-layer">
      {playbackSegments.map(({ segment, tokens }) => (
        <div
          key={segment.id}
          className="player-caption-segment"
          data-player-segment-id={segment.id}
        >
          {tokens.map(({ token, className, focusedClassName, focused }, index) => (
            <Fragment key={token.id ?? `${segment.id}-${index}`}>
              {isLineBreakToken(token) ? (
                // Real line break inside the segment; it carries no timing so it
                // can never become "focused".
                <br data-player-line-break="true" />
              ) : (
                <>
                  {index > 0 ? (
                    <span className="player-caption-gap" aria-hidden="true" />
                  ) : null}
                  <span
                    className={focused ? `${className} ${focusedClassName}` : className}
                    data-player-token-id={token.id}
                    data-player-focused={focused ? 'true' : 'false'}
                  >
                    {token.text}
                  </span>
                </>
              )}
            </Fragment>
          ))}
        </div>
      ))}
    </AbsoluteFill>
  )
}
