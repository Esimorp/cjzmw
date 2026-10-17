/**
 * Shared subtitle types used by both the server (ASR import) and the client
 * (segment/token editing). Timings are optional so older samples and imported
 * plain-text subtitles remain valid without any timing information.
 */

/** Where a token's time range came from. */
export type TimingSource = 'model' | 'interpolated' | 'unmatched'

/**
 * A single editable subtitle unit (usually one word).
 *
 * `start`/`end` are seconds relative to the source video. Both are `null` when
 * no trustworthy timing could be established (see `timingSource`).
 */
export interface SubtitleToken {
  id: string
  text: string
  start: number | null
  end: number | null
  timingSource: TimingSource
  /**
   * Optional name of a registered token style (see `subtitle-token-style.ts`).
   * Missing values fall back to the default style.
   */
  styleName?: string
  /**
   * Per-character timing units covering the token text. Present when the token
   * carries timings, so later split/merge edits can remap timings accurately.
   */
  units?: SubtitleCharUnit[]
}

/** Timing of a single Unicode code point inside a {@link SubtitleToken}. */
export interface SubtitleCharUnit {
  /** The code point this unit describes (surrogate pairs are one unit). */
  char: string
  start: number | null
  end: number | null
}

/** A subtitle segment: an ordered list of tokens with an optional time range. */
export interface SubtitleSegment {
  id: string
  tokens: SubtitleToken[]
  start?: number
  end?: number
}

/** One raw item of the ASR alignment output, in seconds. */
export interface RawAsrItem {
  text: string
  start: number
  end: number
}
