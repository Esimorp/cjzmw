/**
 * Timestamp mapping between the raw ASR alignment output and the editable
 * subtitle tokens shown in the UI.
 *
 * The raw ASR output is a flat list of items such as `{ text: '字幕工具',
 * start: 1, end: 2 }`. The UI splits segment text into word tokens (for Chinese
 * that is usually one or two characters), so a token rarely matches a raw item
 * exactly. This module expands every raw item into per-code-point timings and
 * re-combines them onto the UI tokens:
 *
 * - a token matching one whole raw item exactly keeps the model bounds;
 * - a token built from raw fragments (or spanning several raw items) gets
 *   interpolated bounds: the first fragment start and the last fragment end;
 * - text that cannot be matched stays `unmatched` with `null` timings;
 * - a zero-duration raw item stays zero-duration.
 *
 * Matching walks an ordered pointer through the concatenated characters of the
 * raw items and both sides ignore whitespace and unpronounced punctuation, so
 * repeated words are matched in order instead of by a global `indexOf`.
 */

import type {
  RawAsrItem,
  SubtitleCharUnit,
  SubtitleSegment,
  SubtitleToken,
  TimingSource,
} from './subtitle-types.ts'
import { isLineBreakToken } from './subtitle-linebreak.ts'

/** Characters that carry no sound on their own and are skipped when matching. */
const IGNORABLE_PUNCTUATION = new Set([
  ',',
  '.',
  '!',
  '?',
  ';',
  ':',
  "'",
  '"',
  '`',
  '~',
  '-',
  '_',
  '/',
  '\\',
  '|',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '<',
  '>',
  '。',
  '，',
  '、',
  '；',
  '：',
  '？',
  '！',
  '…',
  '—',
  '～',
  '·',
  '「',
  '」',
  '『',
  '』',
  '《',
  '》',
  '〈',
  '〉',
  '【',
  '】',
  '（',
  '）',
  '“',
  '”',
  '‘',
  '’',
])

function isIgnorable(char: string): boolean {
  return /\s/u.test(char) || IGNORABLE_PUNCTUATION.has(char)
}

/** One code point of a raw item, with its share of the item time range. */
interface RawChar {
  char: string
  start: number
  end: number
  /** Index of the raw item this character came from. */
  item: number
  /** Code point offset inside the raw item text. */
  offset: number
  /** Total code points the source raw item expands to. */
  itemLength: number
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

function toFiniteTime(value: unknown): number | undefined {
  const num = typeof value === 'number' ? value : Number.parseFloat(String(value))
  return Number.isFinite(num) ? num : undefined
}

/** Normalize raw ASR items; unparsable or invalid entries are dropped. */
export function normalizeRawAsrItems(items: readonly RawAsrItem[]): RawAsrItem[] {
  const normalized: RawAsrItem[] = []
  for (const item of items) {
    if (!item || typeof item.text !== 'string') continue
    const start = toFiniteTime(item.start)
    const end = toFiniteTime(item.end)
    if (start === undefined || end === undefined) continue
    // A negative or reversed range is not trustworthy model output; clamping it
    // would turn invalid data into a plausible-looking `model` timestamp.
    if (start < 0 || end < start) continue
    normalized.push({ text: item.text, start, end })
  }
  return normalized
}

/**
 * Expand the raw items into one entry per Unicode code point, splitting each
 * item's `[start, end]` evenly across its code points.
 */
export function expandRawAsrItems(items: readonly RawAsrItem[]): RawChar[] {
  const chars: RawChar[] = []
  items.forEach((item, itemIndex) => {
    const codePoints = [...item.text]
    const count = codePoints.length
    if (count === 0) return
    // Callers validate ranges up front (`normalizeRawAsrItems` /
    // `parseRawAsrJson`); a zero-length range simply yields zero-duration units.
    const start = item.start
    const end = item.end
    const step = (end - start) / count
    codePoints.forEach((char, offset) => {
      chars.push({
        char,
        start: round(start + step * offset),
        end: round(start + step * (offset + 1)),
        item: itemIndex,
        offset,
        itemLength: count,
      })
    })
  })
  return chars
}

/** Split text into code points, skipping whitespace and ignorable punctuation. */
export function toMatchingChars(text: string): string[] {
  const chars: string[] = []
  for (const char of text) {
    if (isIgnorable(char)) continue
    chars.push(char)
  }
  return chars
}

/** A raw code point after ignorable whitespace/punctuation was dropped. */
interface MatchChar {
  char: string
  /** Index into the unfiltered `RawChar[]` (keeps original times + offsets). */
  source: number
}

/**
 * The matching view of the raw stream.
 *
 * Both sides of the comparison must use the same alphabet. `toMatchingChars`
 * already drops whitespace and ignorable punctuation from the *target* text, so
 * the raw stream has to drop them too — otherwise an interior `，` or space in
 * the raw output would break an otherwise exact match and the whole line would
 * fall back to `unmatched`.
 *
 * Every kept entry remembers its index in the unfiltered array, so times,
 * item numbers and code-point offsets stay those of the original raw item and
 * interpolation is unaffected.
 */
interface MatchStream {
  chars: MatchChar[]
}

function createMatchStream(rawChars: readonly RawChar[]): MatchStream {
  const chars: MatchChar[] = []
  rawChars.forEach((entry, source) => {
    if (isIgnorable(entry.char)) return
    chars.push({ char: entry.char, source })
  })
  return { chars }
}

/**
 * Find `textChars` as a contiguous run in the filtered stream, starting at
 * `pointer`.
 *
 * The pointer indexes the *filtered* stream, not the raw array: it is only
 * advanced past characters that actually matched, and it never skips over a
 * meaningful raw character, so text that is genuinely absent stays unmatched
 * instead of matching later, unrelated occurrences.
 */
function findMatch(
  textChars: readonly string[],
  stream: MatchStream,
  pointer: number,
): { start: number; next: number } | null {
  if (textChars.length === 0) return null
  const chars = stream.chars
  for (let index = pointer; index < chars.length; index += 1) {
    if (chars[index].char !== textChars[0]) continue
    let matched = true
    for (let offset = 1; offset < textChars.length; offset += 1) {
      const candidate = chars[index + offset]
      if (!candidate || candidate.char !== textChars[offset]) {
        matched = false
        break
      }
    }
    if (!matched) continue
    return { start: index, next: index + textChars.length }
  }
  return null
}

function unitsFromSlice(
  chars: readonly RawChar[],
  textChars: readonly string[],
): SubtitleCharUnit[] {
  return textChars.map((char, index) => ({
    char,
    start: chars[index].start,
    end: chars[index].end,
  }))
}

/**
 * Build the character units of a token whose code points are already known to
 * be covered by `rawChars`. Returns `null` when any code point is unmatched.
 */
export function buildTokenUnits(
  rawChars: readonly RawChar[],
  text: string,
  startIndex: number,
): SubtitleCharUnit[] | null {
  const textChars = toMatchingChars(text)
  if (rawChars.length === 0 || textChars.length === 0) return null
  const stream = createMatchStream(rawChars)
  const match = findMatch(textChars, stream, Math.max(0, startIndex))
  if (!match) return null
  const slice = stream.chars
    .slice(match.start, match.next)
    .map((entry) => rawChars[entry.source])
  return unitsFromSlice(slice, textChars)
}

/**
 * Attach `[start, end]` to an explicit code-point range of a raw item, so
 * editing code can map slices of a raw item (or a merge across items) without
 * re-running the whole mapping.
 */
export function mapRawSliceToUnits(
  items: readonly RawAsrItem[],
  from: { item: number; offset: number },
  to: { item: number; offset: number },
): SubtitleCharUnit[] {
  const chars = expandRawAsrItems(items)
  const units: SubtitleCharUnit[] = []
  for (const entry of chars) {
    const afterStart = entry.item > from.item || (entry.item === from.item && entry.offset >= from.offset)
    const beforeEnd = entry.item < to.item || (entry.item === to.item && entry.offset < to.offset)
    if (afterStart && beforeEnd) {
      units.push({ char: entry.char, start: entry.start, end: entry.end })
    }
  }
  return units
}

function spanOf(units: readonly SubtitleCharUnit[]): { start: number; end: number } | null {
  let start: number | null = null
  let end: number | null = null
  for (const unit of units) {
    if (unit.start !== null && (start === null || unit.start < start)) start = unit.start
    if (unit.end !== null && (end === null || unit.end > end)) end = unit.end
  }
  if (start === null || end === null) return null
  return { start, end }
}

/** Build a token with timings derived from its character units. */
export function buildTimedToken(
  id: string,
  text: string,
  units: SubtitleCharUnit[],
  timingSource: TimingSource,
): SubtitleToken {
  const span = spanOf(units)
  return {
    id,
    text,
    start: span ? span.start : null,
    end: span ? span.end : null,
    timingSource: span ? timingSource : 'unmatched',
    ...(units.length > 0 ? { units } : {}),
  }
}

/** Build a token that carries no timing information. */
export function buildUnmatchedToken(id: string, text: string): SubtitleToken {
  return { id, text, start: null, end: null, timingSource: 'unmatched' }
}

/** Options for {@link mapSegmentTokens}. */
export interface MapSegmentTokensOptions {
  /** Prefix used to derive stable token ids (`${tokenIdPrefix}-${index}`). */
  tokenIdPrefix?: string
  /** Pointer into the raw character list, shared across segments. */
  startIndex?: number
}

/** Result of {@link mapSegmentTokens}. */
export interface MapSegmentTokensResult {
  tokens: SubtitleToken[]
  /** Pointer to pass to the next segment so matching stays in order. */
  nextIndex: number
}

/**
 * Count the raw characters a set of tokens consumed, so callers can advance a
 * shared pointer after merging or deleting tokens that never carried units.
 */
export function countMatchingChars(tokens: readonly SubtitleToken[]): number {
  let total = 0
  for (const token of tokens) total += toMatchingChars(token.text).length
  return total
}

/**
 * Map subtitle tokens onto the ordered raw characters, starting at
 * `startIndex`.
 *
 * Pointer semantics: the stream used for matching is the raw code points with
 * whitespace/ignorable punctuation removed (the same filter `toMatchingChars`
 * applies to the target text). `startIndex`/`nextIndex` index that filtered
 * stream, and the pointer only advances past characters that actually matched —
 * it never jumps over a meaningful raw character, so unknown text stays
 * unmatched and repeated text is matched in order.
 *
 * Timings always come from the original raw entries: a token keeps the model
 * bounds only when it covers one whole raw item, everything else is
 * interpolated from the retained per-character times.
 */
export function mapSegmentTokens(
  rawChars: readonly RawChar[],
  tokens: readonly { text: string }[],
  options: MapSegmentTokensOptions = {},
): MapSegmentTokensResult {
  const prefix = options.tokenIdPrefix ?? 'tok'
  const stream = createMatchStream(rawChars)
  let pointer = Math.max(0, options.startIndex ?? 0)

  const mapped = tokens.map((token, index) => {
    const id = `${prefix}-${index}`
    const textChars = toMatchingChars(token.text)
    // Punctuation-only or whitespace-only tokens never get a timestamp.
    if (textChars.length === 0) return buildUnmatchedToken(id, token.text)

    const match = findMatch(textChars, stream, pointer)
    if (!match) return buildUnmatchedToken(id, token.text)

    pointer = match.next
    const slice = stream.chars
      .slice(match.start, match.next)
      .map((entry) => rawChars[entry.source])
    const firstRaw = slice[0]
    const lastRaw = slice[slice.length - 1]
    // Only a token covering one whole raw item keeps that item's model bounds:
    // it must start at the item's first code point and end at its last one.
    const wholeItem =
      firstRaw.item === lastRaw.item &&
      firstRaw.offset === 0 &&
      lastRaw.offset + 1 === firstRaw.itemLength
    const timingSource: TimingSource = wholeItem ? 'model' : 'interpolated'
    return buildTimedToken(id, token.text, unitsFromSlice(slice, textChars), timingSource)
  })

  return { tokens: mapped, nextIndex: pointer }
}

/** A published `SubtitleSegment` together with its mapped tokens. */
export type MappedSegment = SubtitleSegment

/** Map a segment (keeping any existing `start`/`end`) onto the raw characters. */
export function mapSegmentTokensToSegment(
  rawChars: readonly RawChar[],
  segment: {
    id: string
    tokens: readonly SubtitleToken[]
    start?: number
    end?: number
    text?: string
  },
  options: MapSegmentTokensOptions = {},
): { segment: MappedSegment; nextIndex: number } {
  const sources = segment.tokens.length > 0
    ? segment.tokens
    : segment.text !== undefined
      ? [{ text: segment.text }]
      : []
  const { tokens, nextIndex } = mapSegmentTokens(rawChars, sources, options)
  const mapped: MappedSegment = { id: segment.id, tokens }
  if (typeof segment.start === 'number') mapped.start = segment.start
  else {
    const first = tokens.find((token) => token.start !== null)
    if (first && first.start !== null) mapped.start = first.start
  }
  if (typeof segment.end === 'number') mapped.end = segment.end
  else {
    const last = [...tokens].reverse().find((token) => token.end !== null)
    if (last && last.end !== null) mapped.end = last.end
  }
  return { segment: mapped, nextIndex }
}

/**
 * Split `text` into UI tokens using `Intl.Segmenter` word granularity.
 * Whitespace is dropped; punctuation stays so captions keep readable spacing,
 * and an unsupported runtime falls back to per-code-point tokens.
 */
export function segmentTextToTokens(
  text: string,
  options: { locale?: string } = {},
): { text: string }[] {
  const trimmed = text.trim()
  if (trimmed === '') return []
  const segmenter = createWordSegmenter(options.locale)
  if (!segmenter) {
    return [...trimmed]
      .filter((char) => !/\s/u.test(char))
      .map((char) => ({ text: char }))
  }
  const tokens: { text: string }[] = []
  for (const piece of segmenter.segment(trimmed)) {
    if (piece.segment.trim() === '') continue
    tokens.push({ text: piece.segment })
  }
  return tokens
}

interface WordSegment {
  segment: string
}

interface SegmenterLike {
  segment(input: string): Iterable<WordSegment>
}

function createWordSegmenter(locale: string | undefined): SegmenterLike | null {
  const candidate = Intl.Segmenter as
    | (new (locales?: string, options?: { granularity?: string }) => SegmenterLike)
    | undefined
  if (typeof candidate !== 'function') return null
  try {
    return new candidate(locale ?? 'zh', { granularity: 'word' })
  } catch {
    return null
  }
}

/**
 * Build subtitle segments for an SRT/transcript import: each caption line
 * becomes one segment whose text is split into word tokens and mapped onto the
 * raw ASR timings.
 */
export function buildTimedSegments(
  captions: readonly { id: string; text: string }[],
  rawItems: readonly RawAsrItem[],
): SubtitleSegment[] {
  const rawChars = expandRawAsrItems(normalizeRawAsrItems(rawItems))
  const segments: SubtitleSegment[] = []
  let pointer = 0
  captions.forEach((caption, captionIndex) => {
    const tokenIdPrefix = `${caption.id}-t${String(captionIndex + 1).padStart(2, '0')}`
    const sources = segmentTextToTokens(caption.text)
    const { tokens, nextIndex } = mapSegmentTokens(rawChars, sources, {
      tokenIdPrefix,
      startIndex: pointer,
    })
    pointer = nextIndex
    const segment: SubtitleSegment = { id: caption.id, tokens }
    const first = tokens.find((token) => token.start !== null)
    const last = [...tokens].reverse().find((token) => token.end !== null)
    if (first && first.start !== null) segment.start = first.start
    if (last && last.end !== null) segment.end = last.end
    segments.push(segment)
  })
  return segments
}

/** Parsed SRT cue — text only; timings come from the raw ASR output. */
export interface ParsedCaption {
  id: string
  text: string
}

const SRT_TIME_PATTERN =
  /(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})/

/** Parse SRT text (CRLF, LF or CR line endings, multi-line cues) into captions. */
export function parseSrtCaptions(content: string, options: { idPrefix?: string } = {}): ParsedCaption[] {
  const idPrefix = options.idPrefix ?? 'srt'
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const blocks = normalized.split(/\n{2,}/)
  const captions: ParsedCaption[] = []
  for (const block of blocks) {
    const lines = block.split('\n')
    let index = 0
    if (lines[index] !== undefined && /^\d+$/.test(lines[index].trim())) index += 1
    const timeLine = lines[index]
    if (timeLine === undefined || !SRT_TIME_PATTERN.test(timeLine)) continue
    index += 1
    const textLines: string[] = []
    for (; index < lines.length; index += 1) {
      if (/^\d+\s*$/.test(lines[index]) && SRT_TIME_PATTERN.test(lines[index + 1] ?? '')) break
      textLines.push(lines[index])
    }
    const text = textLines.join('').trim()
    if (text === '') continue
    captions.push({ id: `${idPrefix}-${captions.length + 1}`, text })
  }
  return captions
}

/** Parse the raw ASR JSON output (`[{ text, start, end }]`, seconds). */
export function parseRawAsrJson(content: string): RawAsrItem[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const items: RawAsrItem[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    const { text, start, end } = entry as { text?: unknown; start?: unknown; end?: unknown }
    if (typeof text !== 'string' || text === '') continue
    const startValue = toFiniteTime(start)
    const endValue = toFiniteTime(end)
    if (startValue === undefined || endValue === undefined) continue
    // Drop negative or reversed ranges instead of normalizing them into a
    // trustworthy-looking model timestamp.
    if (startValue < 0 || endValue < startValue) continue
    items.push({ text, start: startValue, end: endValue })
  }
  return items
}

/** Parse the engine's plain-text transcript into one segment per line. */
export function parseTranscriptSegments(
  content: string,
  options: { idPrefix?: string } = {},
): { id: string; text: string }[] {
  const idPrefix = options.idPrefix ?? 'txt'
  return content
    .replace(/^\uFEFF/, '')
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line, index) => ({ id: `${idPrefix}-${index + 1}`, text: line }))
}

/**
 * Flatten edited tokens into the ordered character units used for remapping.
 *
 * Ordered character units of the original tokens an edited draft is derived
 * from. The caller keeps the order and consumes them with a forward pointer, so
 * re-splitting or merging never re-matches against the full transcript and can
 * never pick up an unrelated duplicate of the same word.
 */
export interface TimingUnitSource {
  chars: SubtitleCharUnit[]
  index: number
}

/**
 * Flatten a segment's tokens into ordered character units, filling in missing
 * per-character units by evenly splitting each token's own `[start, end]`.
 */
export function flattenTokenUnits(tokens: readonly SubtitleToken[]): SubtitleCharUnit[] {
  const flat: SubtitleCharUnit[] = []
  for (const token of tokens) {
    const chars = toMatchingChars(token.text)
    if (token.units && token.units.length > 0) {
      flat.push(...token.units.map((unit) => ({ ...unit })))
      continue
    }
    if (
      chars.length === 0 ||
      token.start === null ||
      token.end === null ||
      !Number.isFinite(token.start) ||
      !Number.isFinite(token.end)
    ) {
      continue
    }
    // Fallback: tokens without units still contribute a trustworthy span.
    const step = (token.end - token.start) / chars.length
    chars.forEach((char, index) => {
      flat.push({
        char,
        start: round(token.start as number + step * index),
        end: round(token.start as number + step * (index + 1)),
      })
    })
  }
  return flat
}

/** True when the units describe exactly the given characters, in order. */
export function unitsMatchText(
  units: readonly SubtitleCharUnit[],
  chars: readonly string[],
): boolean {
  if (units.length !== chars.length) return false
  return units.every((unit, index) => unit.char === chars[index])
}

/** Create a forward-only cursor over ordered character units. */
export function createTimingCursor(units: readonly SubtitleCharUnit[]): TimingUnitSource {
  return { chars: units.map((unit) => ({ ...unit })), index: 0 }
}

/**
 * Map one edited token onto the cursor, advancing it past the characters the
 * token consumed. Characters the token cannot match stay unmatched (`null`) and
 * the cursor stops advancing, so later tokens keep their own units.
 */
export function mapTokenFromCursor(
  cursor: TimingUnitSource,
  id: string,
  text: string,
  options: { fallbackUnits?: readonly SubtitleCharUnit[] | null } = {},
): SubtitleToken {
  const chars = toMatchingChars(text)
  if (chars.length === 0) return buildUnmatchedToken(id, text)

  const start = cursor.index
  let matched = true
  for (let offset = 0; offset < chars.length; offset += 1) {
    const candidate = cursor.chars[start + offset]
    if (!candidate || candidate.char !== chars[offset]) {
      matched = false
      break
    }
  }

  if (!matched) {
    // A fallback range may only be borrowed when it describes exactly this
    // text; otherwise the token stays unmatched rather than gaining a
    // timestamp that belongs to different characters.
    const fallback = options.fallbackUnits ?? null
    if (fallback && unitsMatchText(fallback, chars)) {
      return buildTimedToken(id, text, fallback.map((unit) => ({ ...unit })), 'interpolated')
    }
    return buildUnmatchedToken(id, text)
  }

  const slice = cursor.chars.slice(start, start + chars.length)
  cursor.index = start + chars.length
  const units: SubtitleCharUnit[] = slice.map((unit, offset) => ({
    char: chars[offset],
    start: unit.start,
    end: unit.end,
  }))
  // Rebuilt from individual character units, so the range is derived, not the
  // verbatim model bounds of a whole raw item.
  return buildTimedToken(id, text, units, 'interpolated')
}

/** A segment with the tokens an edit produced and their remapped timings. */
export interface RemappedSegment {
  id: string
  tokens: SubtitleToken[]
  start?: number
  end?: number
}

/** Remap one edited segment: retained characters keep their original timings. */
export function remapEditedSegment(
  source: readonly SubtitleToken[],
  editedTokens: readonly { id: string; text: string }[],
): RemappedSegment {
  const cursor = createTimingCursor(flattenTokenUnits(source))
  const tokens = editedTokens.map((token) =>
    mapTokenFromCursor(cursor, token.id, token.text),
  )
  const segment: RemappedSegment = { id: '', tokens }
  applySegmentSpan(segment)
  return segment
}

function applySegmentSpan(segment: {
  tokens: readonly SubtitleToken[]
  start?: number
  end?: number
}): void {
  const first = segment.tokens.find((token) => token.start !== null)
  const last = [...segment.tokens].reverse().find((token) => token.end !== null)
  if (first && first.start !== null) segment.start = first.start
  else delete segment.start
  if (last && last.end !== null) segment.end = last.end
  else delete segment.end
}

/** Build a timed segment from a draft token list and an optional cursor. */
export function buildEditedSegment(
  id: string,
  cursor: TimingUnitSource | null,
  tokens: readonly { id: string; text: string }[],
): SubtitleSegment {
  const timed = tokens.map((token) =>
    cursor
      ? mapTokenFromCursor(cursor, token.id, token.text)
      : buildUnmatchedToken(token.id, token.text),
  )
  const segment: SubtitleSegment = { id, tokens: timed }
  applySegmentSpan(segment)
  return segment
}

/**
 * Timing-aware segment builder for in-line-break data: a token whose text is a
 * single newline is a line-break marker, so it never consumes a timing unit and
 * stays untimed; every other token is mapped exactly like
 * {@link buildEditedSegment}.
 *
 * Optional `carry` supplies the previous token with the same id so the new token
 * inherits its `styleName` (and per-character units when the text is unchanged).
 */
export function buildSegmentWithLineBreaks(
  id: string,
  cursor: TimingUnitSource | null,
  tokens: readonly { id: string; text: string }[],
  carry?: readonly SubtitleToken[],
): SubtitleSegment {
  const carryById = new Map<string, SubtitleToken>()
  for (const token of carry ?? []) carryById.set(token.id, token)
  const carriedStyle = carry?.[0]?.styleName

  const built = tokens.map((token) => {
    if (isLineBreakToken(token)) {
      const lineBreak = buildUnmatchedToken(token.id, token.text)
      if (carriedStyle) lineBreak.styleName = carriedStyle
      return lineBreak
    }
    const previous = carryById.get(token.id)
    const mapped = cursor
      ? mapTokenFromCursor(cursor, token.id, token.text, {
          fallbackUnits: unitsMatchText(
            previous?.units ?? [],
            toMatchingChars(token.text),
          )
            ? previous?.units ?? null
            : null,
        })
      : buildUnmatchedToken(token.id, token.text)
    const styleName = previous?.styleName ?? carriedStyle
    if (styleName) mapped.styleName = styleName
    return mapped
  })

  const segment: SubtitleSegment = { id, tokens: built }
  applySegmentSpan(segment)
  return segment
}

/** Build a segment from tokens that already carry timings (e.g. neighbors). */export function buildRetainedSegment(
  id: string,
  tokens: readonly SubtitleToken[],
): SubtitleSegment {
  const segment: SubtitleSegment = { id, tokens: tokens.map((token) => ({ ...token })) }
  applySegmentSpan(segment)
  return segment
}
