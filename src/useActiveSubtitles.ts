import { useMemo } from 'react'
import { useCurrentFrame, useVideoConfig } from 'remotion'
import { useSubtitles } from './SubtitleContext'
import { useSubtitleTokenStyle } from './subtitle-token-style'
import { segmentActiveAt, segmentStartSeconds, tokenActiveAt } from './subtitle-sample'
import type { SubtitleSegment, SubtitleToken } from './subtitle-types'

/** One active token together with its segment and resolved CSS classes. */
export interface ActiveSubtitleToken {
  segment: SubtitleSegment
  token: SubtitleToken
  /** Normal-state class from the style registry. */
  className: string
  /** Focused-state class from the style registry. */
  focusedClassName: string
}

/** One token rendered inside an active segment, with its resolved classes. */
export interface PlaybackSegmentToken {
  token: SubtitleToken
  /** Normal-state class from the style registry. */
  className: string
  /** Focused-state class from the style registry. */
  focusedClassName: string
  /** True when `[start, end)` contains the current playback position. */
  focused: boolean
}

/** A segment visible at the current playback position. */
export interface PlaybackSegment {
  segment: SubtitleSegment
  /** Every token of the segment, in source order (not only the active ones). */
  tokens: PlaybackSegmentToken[]
}

export interface ActiveSubtitles {
  /** Current playback position in seconds, derived from frame/fps. */
  seconds: number
  /** Segments whose derived token range contains `seconds`. */
  activeSegments: SubtitleSegment[]
  /**
   * Active segments with the full token list and per-token classes. This is
   * what the player caption renders: the whole segment stays visible for its
   * derived `[start, end)`, including gaps between tokens.
   */
  playbackSegments: PlaybackSegment[]
  /** Only the tokens whose own range contains `seconds`. */
  activeTokens: ActiveSubtitleToken[]
}

/**
 * Composition-only hook: resolves the subtitles active at the current frame.
 *
 * - Reads the shared `SubtitleContext` (no local copy, no writes).
 * - `seconds = currentFrame / fps`; `useVideoConfig` fps is authoritative.
 * - A token is active only when its `[start, end)` range is finite, non-negative
 *   and `end > start`; tokens without trustworthy timing never activate.
 * - Segment ranges are derived from the segment's valid tokens on every call,
 *   so stale cached segment bounds can never leak in.
 * - Overlapping tokens/segments are all returned in source order.
 * - Classes come from the existing style registry; nothing is duplicated.
 */
export function useActiveSubtitles(): ActiveSubtitles {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const { segments } = useSubtitles()
  const { getStyle } = useSubtitleTokenStyle()

  const seconds = fps > 0 ? frame / fps : 0

  return useMemo(() => {
    const activeSegments: SubtitleSegment[] = []
    const playbackSegments: PlaybackSegment[] = []
    const activeTokens: ActiveSubtitleToken[] = []

    for (const segment of segments) {
      if (!segmentActiveAt(segment, seconds)) continue
      activeSegments.push(segment)

      // The player shows the whole segment; membership is decided by the
      // segment's derived range, not by individual token ranges.
      const rendered: PlaybackSegmentToken[] = []
      for (const token of segment.tokens) {
        const style = getStyle(token.styleName)
        const focused = tokenActiveAt(token, seconds)
        rendered.push({
          token,
          className: style.className,
          focusedClassName: style.focusedClassName,
          focused,
        })
        if (!focused) continue
        activeTokens.push({
          segment,
          token,
          className: style.className,
          focusedClassName: style.focusedClassName,
        })
      }
      playbackSegments.push({ segment, tokens: rendered })
    }

    return { seconds, activeSegments, playbackSegments, activeTokens }
  }, [segments, getStyle, seconds])
}

/** Times (seconds) of a segment, derived from its valid tokens. */
export function segmentDerivedTimes(segment: SubtitleSegment): {
  start: number | null
  end: number | null
} {
  let end: number | null = null
  for (const token of segment.tokens) {
    if (typeof token.end !== 'number' || !Number.isFinite(token.end)) continue
    if (end === null || token.end > end) end = token.end
  }
  return { start: segmentStartSeconds(segment), end }
}
