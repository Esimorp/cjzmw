import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { SubtitleContext, type SubtitleContextValue } from './SubtitleContext'
import { SAMPLE_SEGMENTS } from './subtitle-sample'
import type { SubtitleSegment } from './subtitle-types'

/**
 * Owns the one and only subtitle state.
 *
 * `setSegments` is a stable function that forwards React's functional updater
 * unchanged, so callers may pass either a new array or `(current) => next`.
 * The context value is memoised on `segments` and the setter only.
 *
 * Passing `segments` makes the provider controlled/read-only: it is used by the
 * Remotion bridge so edits, ASR and forced alignment results reach the player's
 * separate React tree without a remount.
 */
export function SubtitleProvider({
  children,
  initialSegments = SAMPLE_SEGMENTS,
  segments: controlledSegments,
}: {
  children: ReactNode
  /** Sample used before the workspace restores; shared by client and SSR. */
  initialSegments?: SubtitleSegment[]
  /** Optional read-only snapshot that replaces the internal state when set. */
  segments?: SubtitleSegment[]
}) {
  const [stateSegments, setSegmentsState] = useState<SubtitleSegment[]>(initialSegments)
  const segments = controlledSegments ?? stateSegments

  const setSegments = useCallback<SubtitleContextValue['setSegments']>((update) => {
    setSegmentsState((current) =>
      typeof update === 'function' ? update(current) : update,
    )
  }, [])

  const value = useMemo<SubtitleContextValue>(() => ({ segments, setSegments }), [segments, setSegments])

  return <SubtitleContext.Provider value={value}>{children}</SubtitleContext.Provider>
}
