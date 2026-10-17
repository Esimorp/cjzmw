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
 */
export function SubtitleProvider({
  children,
  initialSegments = SAMPLE_SEGMENTS,
}: {
  children: ReactNode
  /** Sample used before the workspace restores; shared by client and SSR. */
  initialSegments?: SubtitleSegment[]
}) {
  const [segments, setSegmentsState] = useState<SubtitleSegment[]>(initialSegments)

  const setSegments = useCallback<SubtitleContextValue['setSegments']>((update) => {
    setSegmentsState((current) =>
      typeof update === 'function' ? update(current) : update,
    )
  }, [])

  const value = useMemo<SubtitleContextValue>(() => ({ segments, setSegments }), [segments, setSegments])

  return <SubtitleContext.Provider value={value}>{children}</SubtitleContext.Provider>
}
