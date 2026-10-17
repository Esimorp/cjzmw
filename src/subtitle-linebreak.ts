/**
 * In-segment line breaks.
 *
 * A segment may span several visual lines, but each line break is *data*, not
 * whitespace: it must survive JSON round-trips and must never be turned into a
 * token. The representation is a dedicated token whose text is a single `\n`
 * and which carries no timing (`start`/`end` `null`, `timingSource`
 * `'unmatched'`). Real word tokens keep their own text, order, timings, units
 * and `styleName`, so splitting a line never destroys timing information.
 *
 * Documents written before this feature contain no such token and keep working
 * unchanged.
 */

/** Marker placed between lines inside the editor draft textarea. */
export const LINE_BREAK = '\n'

const normalizeNewlines = (text: string): string => text.replace(/\r\n|\r/g, LINE_BREAK)

/** True when a token is a pure line-break marker. */
export function isLineBreakToken(token: { text: string }): boolean {
  return token.text === LINE_BREAK || token.text === '\r\n' || token.text === '\r'
}

/** Build the untimed token that represents one line break. */
export function createLineBreakToken(id: string): {
  id: string
  text: string
  start: null
  end: null
  timingSource: 'unmatched'
} {
  return { id, text: LINE_BREAK, start: null, end: null, timingSource: 'unmatched' }
}

/**
 * Text of the editor textarea for a token list: words joined by single spaces,
 * line-break tokens rendered as real newlines.
 */
export function tokensToDraft(tokens: readonly { text: string }[]): string {
  let draft = ''
  tokens.forEach((token, index) => {
    const isBreak = isLineBreakToken(token)
    if (index > 0 && !isBreak && !isLineBreakToken(tokens[index - 1])) draft += ' '
    draft += isBreak ? LINE_BREAK : token.text
  })
  return draft
}

/**
 * Draft split into lines, each line split into word tokens.
 *
 * Empty lines are dropped (`filter` on the trimmed line) so a segment can never
 * gain a blank line, but line breaks *inside* a draft are preserved as their own
 * group boundary rather than being split into separate segments.
 */
export function splitDraftToLines(draft: string): string[][] {
  return normalizeNewlines(draft)
    .split(LINE_BREAK)
    .filter((line) => line.trim() !== '')
    .map((line) =>
      line
        .trim()
        .split(/\s+/)
        .filter((text) => text.length > 0),
    )
    .filter((texts) => texts.length > 0)
}

/** True when the text contains at least one non-whitespace character. */
export function hasMeaningfulText(text: string): boolean {
  return /\S/.test(text)
}

/**
 * Split a draft at a caret offset into a before-part and an after-part,
 * trimmed at the cut so neither side keeps the surrounding space.
 *
 * `caret` is clamped into range; a selection should be passed as its
 * `selectionStart`, matching the textarea's own behaviour.
 */
export function splitDraftAtCaret(
  draft: string,
  caret: number,
): { before: string; after: string } {
  const text = normalizeNewlines(draft)
  const index = Math.min(Math.max(0, Math.trunc(caret) || 0), text.length)
  return {
    before: text.slice(0, index).trimEnd(),
    after: text.slice(index).trimStart(),
  }
}
