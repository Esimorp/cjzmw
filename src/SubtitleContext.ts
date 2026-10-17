import { createContext, useContext } from 'react'
import type { SubtitleSegment } from './subtitle-types'

/**
 * The single source of truth for subtitle data.
 *
 * Every consumer (editor list, token popup, workspace saver, Remotion stage)
 * reads from here; nothing keeps a second editable copy.
 */
export interface SubtitleContextValue {
  /** Full segments, including every token field (`id/text/start/end/units/timingSource/styleName`). */
  segments: SubtitleSegment[]
  /** Stable updater; accepts a value or a React-style functional update. */
  setSegments: (update: SubtitleSegment[] | ((current: SubtitleSegment[]) => SubtitleSegment[])) => void
}

const noopSetSegments: SubtitleContextValue['setSegments'] = () => undefined

/** Default value: empty list and a no-op updater (safe outside a provider). */
export const SubtitleContext = createContext<SubtitleContextValue>({
  segments: [],
  setSegments: noopSetSegments,
})

/** Read the shared subtitles and their stable setter. */
export function useSubtitles(): SubtitleContextValue {
  return useContext(SubtitleContext)
}
