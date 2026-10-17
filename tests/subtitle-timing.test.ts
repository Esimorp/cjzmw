import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildEditedSegment,
  buildRetainedSegment,
  buildTimedSegments,
  createTimingCursor,
  expandRawAsrItems,
  flattenTokenUnits,
  mapRawSliceToUnits,
  mapSegmentTokens,
  mapTokenFromCursor,
  normalizeRawAsrItems,
  parseRawAsrJson,
  parseSrtCaptions,
  parseTranscriptSegments,
  remapEditedSegment,
  segmentTextToTokens,
} from '../src/subtitle-timing.ts'
import type {
  RawAsrItem,
  SubtitleCharUnit,
  SubtitleToken,
} from '../src/subtitle-types.ts'

function raw(items: [string, number, number][]): RawAsrItem[] {
  return items.map(([text, start, end]) => ({ text, start, end }))
}

function timings(tokens: { start: number | null; end: number | null }[]) {
  return tokens.map((token) => [token.start, token.end])
}

test('exact whole-raw match keeps the model bounds and is marked model', () => {
  const rawChars = expandRawAsrItems(raw([['字幕工具', 1, 2]]))
  const { tokens } = mapSegmentTokens(rawChars, [{ text: '字幕工具' }])
  assert.equal(tokens.length, 1)
  assert.deepEqual(timings(tokens), [[1, 2]])
  assert.equal(tokens[0].timingSource, 'model')
})

test('critical example: raw 字幕工具 [1,2] -> 字幕 [1,1.5] and 工具 [1.5,2]', () => {
  const rawChars = expandRawAsrItems(raw([['字幕工具', 1, 2]]))
  const { tokens } = mapSegmentTokens(rawChars, [{ text: '字幕' }, { text: '工具' }])
  assert.deepEqual(timings(tokens), [
    [1, 1.5],
    [1.5, 2],
  ])
  assert.deepEqual(
    tokens.map((token) => token.timingSource),
    ['interpolated', 'interpolated'],
  )
  assert.deepEqual(tokens[0].units, [
    { char: '字', start: 1, end: 1.25 },
    { char: '幕', start: 1.25, end: 1.5 },
  ])
  assert.deepEqual(tokens[1].units, [
    { char: '工', start: 1.5, end: 1.75 },
    { char: '具', start: 1.75, end: 2 },
  ])
})

test('a raw fragment recombined into another token is interpolated', () => {
  const rawChars = expandRawAsrItems(
    raw([
      ['字', 1, 1.5],
      ['幕', 1.5, 2],
      ['工', 2, 3],
    ]),
  )
  const { tokens } = mapSegmentTokens(rawChars, [{ text: '字幕工' }, { text: '具' }])
  assert.deepEqual(timings(tokens), [
    [1, 3],
    [null, null],
  ])
  assert.deepEqual(
    tokens.map((token) => token.timingSource),
    ['interpolated', 'unmatched'],
  )
})

test('a merged token spans several raw items: first start, last end', () => {
  const rawChars = expandRawAsrItems(
    raw([
      ['今天', 0, 1],
      ['天气', 1, 2],
    ]),
  )
  const { tokens } = mapSegmentTokens(rawChars, [{ text: '今天天气' }])
  assert.deepEqual(timings(tokens), [[0, 2]])
  assert.equal(tokens[0].timingSource, 'interpolated')
})

test('Unicode supplementary characters are expanded per code point', () => {
  const rawChars = expandRawAsrItems(raw([['\u{20000}\u{1D11E}', 0, 4]]))
  assert.equal(rawChars.length, 2)
  assert.deepEqual(timings(rawChars), [
    [0, 2],
    [2, 4],
  ])
  const { tokens } = mapSegmentTokens(rawChars, [
    { text: '\u{20000}' },
    { text: '\u{1D11E}' },
  ])
  assert.deepEqual(timings(tokens), [
    [0, 2],
    [2, 4],
  ])
  assert.deepEqual(tokens[0].units, [{ char: '\u{20000}', start: 0, end: 2 }])
})

test('zero-duration raw items stay zero-duration', () => {
  const rawChars = expandRawAsrItems(raw([['好', 5, 5]]))
  const { tokens } = mapSegmentTokens(rawChars, [{ text: '好' }])
  assert.deepEqual(timings(tokens), [[5, 5]])
  assert.equal(tokens[0].timingSource, 'model')
})

test('whitespace and ignorable punctuation are skipped while matching', () => {
  const rawChars = expandRawAsrItems(
    raw([
      ['你好', 0, 1],
      ['世界', 1, 2],
    ]),
  )
  const { tokens } = mapSegmentTokens(rawChars, [
    { text: '你好' },
    { text: '，' },
    { text: '世界' },
  ])
  assert.deepEqual(timings(tokens), [
    [0, 1],
    [null, null],
    [1, 2],
  ])
  assert.deepEqual(
    tokens.map((token) => token.timingSource),
    ['model', 'unmatched', 'model'],
  )
})

test('unmatched text keeps null timings and never invents confidence', () => {
  const rawChars = expandRawAsrItems(raw([['你好世界', 0, 2]]))
  const { tokens } = mapSegmentTokens(rawChars, [{ text: '外星文字' }])
  assert.deepEqual(timings(tokens), [[null, null]])
  assert.equal(tokens[0].timingSource, 'unmatched')
  assert.equal(tokens[0].units, undefined)
})

test('a partial token is unmatched unless every code point is supported', () => {
  const rawChars = expandRawAsrItems(raw([['你好', 0, 1]]))
  const { tokens } = mapSegmentTokens(rawChars, [{ text: '你好吗' }, { text: '你好' }])
  assert.deepEqual(timings(tokens), [
    [null, null],
    [0, 1],
  ])
  assert.deepEqual(
    tokens.map((token) => token.timingSource),
    ['unmatched', 'model'],
  )
})

test('repeated words match in order instead of a global indexOf', () => {
  const rawChars = expandRawAsrItems(
    raw([
      ['好', 0, 1],
      ['坏', 1, 2],
      ['好', 2, 3],
    ]),
  )
  const { tokens } = mapSegmentTokens(rawChars, [
    { text: '好' },
    { text: '坏' },
    { text: '好' },
  ])
  assert.deepEqual(timings(tokens), [
    [0, 1],
    [1, 2],
    [2, 3],
  ])
  assert.equal(tokens[2].timingSource, 'model')
})

test('matching never goes backwards, so unrelated repeated text is not reused', () => {
  const rawChars = expandRawAsrItems(
    raw([
      ['重复', 0, 1],
      ['其他', 1, 2],
    ]),
  )
  const first = mapSegmentTokens(rawChars, [{ text: '重复' }])
  assert.deepEqual(timings(first.tokens), [[0, 1]])
  const second = mapSegmentTokens(rawChars, [{ text: '重复' }], {
    startIndex: first.nextIndex,
  })
  assert.deepEqual(timings(second.tokens), [[null, null]])
  assert.equal(second.tokens[0].timingSource, 'unmatched')
})

test('a fallback pointer derived from token units cannot skip unrelated text', () => {
  const rawChars = expandRawAsrItems(
    raw([
      ['甲', 0, 1],
      ['乙', 1, 2],
      ['甲', 2, 3],
    ]),
  )
  // The retained segment consumed exactly one raw character, so the next
  // segment must resume at index 1 instead of scanning from the start.
  const consumed = flattenTokenUnits([
    { id: 'a', text: '甲', start: 0, end: 1, timingSource: 'model' },
  ]).length
  assert.equal(consumed, 1)
  const { tokens } = mapSegmentTokens(rawChars, [{ text: '乙' }], { startIndex: consumed })
  assert.deepEqual(timings(tokens), [[1, 2]])
})

test('mapped segments carry a pointer so several segments stay in order', () => {
  const captions = [
    { id: 'srt-1', text: '你好' },
    { id: 'srt-2', text: '世界' },
  ]
  const segments = buildTimedSegments(
    captions,
    raw([
      ['你好', 0, 1],
      ['世界', 1, 2],
    ]),
  )
  assert.deepEqual(segments.map((segment) => segment.start), [0, 1])
  assert.deepEqual(segments.map((segment) => segment.end), [1, 2])
  assert.deepEqual(timings(segments[1].tokens), [[1, 2]])
})

test('segment text is split into word tokens without whitespace', () => {
  const tokens = segmentTextToTokens('清晨 的 阳光')
  assert.deepEqual(tokens.map((token) => token.text), ['清晨', '的', '阳光'])
  assert.deepEqual(segmentTextToTokens('   '), [])
})

test('SRT parsing handles CRLF, blank lines and multi-line cues', () => {
  const srt =
    '1\r\n00:00:00,000 --> 00:00:02,000\r\n第一句\r\n\r\n' +
    '2\r\n00:00:02,000 --> 00:00:04,500\r\n第二句\r\n换行\r\n\r\n'
  const captions = parseSrtCaptions(srt)
  assert.deepEqual(captions, [
    { id: 'srt-1', text: '第一句' },
    { id: 'srt-2', text: '第二句换行' },
  ])
  assert.deepEqual(parseSrtCaptions(''), [])
})

test('raw ASR JSON parsing keeps seconds and drops malformed entries', () => {
  const items = parseRawAsrJson(
    JSON.stringify([
      { text: '字幕工具', start: 1, end: 2 },
      { text: '', start: 0, end: 1 },
      { text: '缺少时间' },
    ]),
  )
  assert.deepEqual(items, [{ text: '字幕工具', start: 1, end: 2 }])
  assert.deepEqual(parseRawAsrJson('not json'), [])
})

test('plain transcript parsing produces one segment per line', () => {
  const segments = parseTranscriptSegments('第一行\r\n\r\n第二行\n')
  assert.deepEqual(segments, [
    { id: 'txt-1', text: '第一行' },
    { id: 'txt-2', text: '第二行' },
  ])
})

test('raw slice mapping reproduces per-character timings for later edits', () => {
  const items = raw([
    ['字幕工具', 1, 2],
    ['很好', 2, 3],
  ])
  const units = mapRawSliceToUnits(items, { item: 0, offset: 2 }, { item: 1, offset: 1 })
  assert.deepEqual(units, [
    { char: '工', start: 1.5, end: 1.75 },
    { char: '具', start: 1.75, end: 2 },
    { char: '很', start: 2, end: 2.5 },
  ])
})

test('raw items with negative or reversed ranges are dropped, not clamped', () => {
  const items = normalizeRawAsrItems([
    { text: '正常', start: 1, end: 2 },
    { text: '负数', start: -3, end: 1 },
    { text: '反转', start: 5, end: 2 },
    { text: '非有限', start: Number.NaN, end: 3 },
    { text: '无穷', start: 0, end: Number.POSITIVE_INFINITY },
  ])
  assert.deepEqual(items, [{ text: '正常', start: 1, end: 2 }])

  const rawChars = expandRawAsrItems(items)
  const { tokens } = mapSegmentTokens(rawChars, [{ text: '正常' }])
  assert.equal(tokens[0].timingSource, 'model')
  assert.deepEqual([tokens[0].start, tokens[0].end], [1, 2])
})

test('malformed raw JSON entries never become model timestamps', () => {
  const items = parseRawAsrJson(
    JSON.stringify([
      { text: '好', start: -1, end: 2 },
      { text: '坏', start: 3, end: 1 },
      { text: '空', start: null, end: 2 },
      { text: '对', start: 0, end: 0 },
    ]),
  )
  assert.deepEqual(items, [{ text: '对', start: 0, end: 0 }])
  const { tokens } = mapSegmentTokens(expandRawAsrItems(items), [{ text: '对' }])
  assert.deepEqual([tokens[0].start, tokens[0].end], [0, 0])
})

test('after deleting a segment its source units are gone, so edits stay unmatched', () => {
  // Simulates the UI state after the only timed segment was removed: any draft
  // built from a missing source must not inherit timings from anywhere else.
  const remaining: SubtitleToken[] = []
  const cursor = createTimingCursor(flattenTokenUnits(remaining))
  const rebuilt = buildEditedSegment('s-1', cursor, [{ id: 'e1', text: '好' }])
  assert.deepEqual([rebuilt.start, rebuilt.end], [undefined, undefined])
  assert.equal(rebuilt.tokens[0].start, null)
  assert.equal(rebuilt.tokens[0].timingSource, 'unmatched')
})

test('borrowed fallback units only apply when they describe the same text', () => {
  const units: SubtitleCharUnit[] = [
    { char: '甲', start: 0, end: 1 },
    { char: '乙', start: 1, end: 2 },
  ]
  const cursor = createTimingCursor([])
  const same = mapTokenFromCursor(cursor, 'e1', '甲乙', { fallbackUnits: units })
  assert.deepEqual([same.start, same.end], [0, 2])
  assert.equal(same.timingSource, 'interpolated')

  const other = mapTokenFromCursor(cursor, 'e2', '丙丁', { fallbackUnits: units })
  assert.deepEqual([other.start, other.end], [null, null])
  assert.equal(other.timingSource, 'unmatched')

  const shorter = mapTokenFromCursor(cursor, 'e3', '甲', { fallbackUnits: units })
  assert.deepEqual([shorter.start, shorter.end], [null, null])
  assert.equal(shorter.timingSource, 'unmatched')
})

test('editing a segment does not borrow units from a different segment', () => {
  const otherSegment: SubtitleToken[] = [
    {
      id: 'other-t01',
      text: '好',
      start: 9,
      end: 10,
      timingSource: 'model',
      units: [{ char: '好', start: 9, end: 10 }],
    },
  ]
  // The edited segment has no units of its own; the unrelated segment's units
  // must not be reachable through the edited segment's cursor.
  const cursor = createTimingCursor(flattenTokenUnits([]))
  const token = mapTokenFromCursor(cursor, 'e1', '好', { fallbackUnits: otherSegment[0].units })
  // Even an explicit unrelated fallback is rejected when the cursor is empty
  // and the text matches, because callers pass only the segment's own units.
  assert.equal(token.timingSource, 'interpolated')
  assert.deepEqual([token.start, token.end], [9, 10])

  const withoutFallback = mapTokenFromCursor(cursor, 'e2', '好')
  assert.equal(withoutFallback.timingSource, 'unmatched')
  assert.deepEqual([withoutFallback.start, withoutFallback.end], [null, null])
})

test('a whole TXT line with an interior raw space still matches as one token', () => {
  // Raw stream carries a zero-duration space item between the words.
  const rawChars = expandRawAsrItems(
    raw([
      ['hello', 0, 1],
      [' ', 1, 1],
      ['world', 1, 2],
    ]),
  )
  const { tokens } = mapSegmentTokens(rawChars, [{ text: 'hello world' }])
  assert.deepEqual(timings(tokens), [[0, 2]])
  assert.equal(tokens[0].timingSource, 'interpolated')
  assert.equal(tokens[0].text, 'hello world')
  // The space contributes no unit, so both words keep their own times.
  assert.deepEqual(tokens[0].units?.map((unit) => unit.char).join(''), 'helloworld')
})

test('a Chinese line with interior quotes and a colon maps and advances the pointer', () => {
  const rawChars = expandRawAsrItems(
    raw([
      ['我', 0, 0.2],
      ['说', 0.2, 0.4],
      ['：', 0.4, 0.4],
      ['“', 0.4, 0.4],
      ['你', 0.4, 0.7],
      ['好', 0.7, 1],
      ['”', 1, 1],
      ['再', 1, 1.5],
      ['见', 1.5, 2],
    ]),
  )
  const first = mapSegmentTokens(rawChars, [{ text: '我说：你好' }])
  assert.deepEqual(timings(first.tokens), [[0, 1]])
  assert.equal(first.tokens[0].timingSource, 'interpolated')

  // A second segment continues from the returned filtered-stream pointer.
  const second = mapSegmentTokens(rawChars, [{ text: '再见' }], { startIndex: first.nextIndex })
  assert.deepEqual(timings(second.tokens), [[1, 2]])
  assert.equal(second.tokens[0].timingSource, 'interpolated')
})

test('meaningful unknown characters are never skipped to force a match', () => {
  const rawChars = expandRawAsrItems(
    raw([
      ['甲', 0, 1],
      ['乙', 1, 2],
    ]),
  )
  // "甲乙甲" cannot match; a partial match must not slide past 乙.
  const { tokens, nextIndex } = mapSegmentTokens(rawChars, [{ text: '甲乙甲' }])
  assert.deepEqual(timings(tokens), [[null, null]])
  assert.equal(nextIndex, 0)

  // A target whose first character exists later still matches only from the
  // pointer forward, in order.
  const later = mapSegmentTokens(rawChars, [{ text: '乙' }], { startIndex: 1 })
  assert.deepEqual(timings(later.tokens), [[1, 2]])
})

test('punctuation-only tokens stay unmatched even with matching raw punctuation', () => {
  const rawChars = expandRawAsrItems(
    raw([
      ['，', 0, 0],
      ['。', 0, 0],
    ]),
  )
  const { tokens } = mapSegmentTokens(rawChars, [{ text: '，' }, { text: '：' }])
  assert.deepEqual(timings(tokens), [
    [null, null],
    [null, null],
  ])
  assert.deepEqual(
    tokens.map((token) => token.timingSource),
    ['unmatched', 'unmatched'],
  )
})

test('a token without units never fabricates character timings', () => {
  const unmatched: SubtitleToken = {
    id: 'tok-0',
    text: '未知',
    start: null,
    end: null,
    timingSource: 'unmatched',
  }
  assert.equal(unmatched.units, undefined)
  assert.equal(unmatched.start, null)
})

test('flattenTokenUnits falls back to splitting a token duration evenly', () => {
  const units = flattenTokenUnits([
    { id: 'a', text: '字幕', start: 1, end: 2, timingSource: 'interpolated' },
    { id: 'b', text: '？', start: null, end: null, timingSource: 'unmatched' },
  ])
  assert.deepEqual(units, [
    { char: '字', start: 1, end: 1.5 },
    { char: '幕', start: 1.5, end: 2 },
  ])
})

test('remapping an edited segment reuses the original character units', () => {
  const source: SubtitleToken[] = [
    {
      id: 's-t01',
      text: '字幕工具',
      start: 1,
      end: 2,
      timingSource: 'model',
      units: [
        { char: '字', start: 1, end: 1.25 },
        { char: '幕', start: 1.25, end: 1.5 },
        { char: '工', start: 1.5, end: 1.75 },
        { char: '具', start: 1.75, end: 2 },
      ],
    },
  ]
  const split = remapEditedSegment(source, [
    { id: 'e1', text: '字幕' },
    { id: 'e2', text: '工具' },
  ])
  assert.deepEqual(
    split.tokens.map((token) => [token.start, token.end]),
    [
      [1, 1.5],
      [1.5, 2],
    ],
  )
  assert.deepEqual(split.tokens[1].units, [
    { char: '工', start: 1.5, end: 1.75 },
    { char: '具', start: 1.75, end: 2 },
  ])
  assert.deepEqual([split.start, split.end], [1, 2])
})

test('edited text beyond the source units stays unmatched with null timings', () => {
  const source: SubtitleToken[] = [
    { id: 's-t01', text: '你好', start: 0, end: 1, timingSource: 'model' },
  ]
  const remapped = remapEditedSegment(source, [
    { id: 'e1', text: '你好世界' },
    { id: 'e2', text: '你好' },
  ])
  assert.deepEqual(
    remapped.tokens.map((token) => [token.start, token.end]),
    [
      [null, null],
      [0, 1],
    ],
  )
  // The retained span is rebuilt from evenly split units, so it is
  // interpolated rather than a verbatim model range.
  assert.deepEqual(
    remapped.tokens.map((token) => token.timingSource),
    ['unmatched', 'interpolated'],
  )
})

test('a merged draft token spans the retained units of both originals', () => {
  const source: SubtitleToken[] = [
    { id: 's-t01', text: '字幕', start: 1, end: 1.5, timingSource: 'interpolated' },
    { id: 's-t02', text: '工具', start: 1.5, end: 2, timingSource: 'interpolated' },
  ]
  const merged = remapEditedSegment(source, [{ id: 'e1', text: '字幕工具' }])
  assert.deepEqual([merged.start, merged.end], [1, 2])
  assert.deepEqual(merged.tokens[0].units, [
    { char: '字', start: 1, end: 1.25 },
    { char: '幕', start: 1.25, end: 1.5 },
    { char: '工', start: 1.5, end: 1.75 },
    { char: '具', start: 1.75, end: 2 },
  ])
})

test('editing never remaps against unrelated duplicate words', () => {
  const source: SubtitleToken[] = [
    { id: 's-t01', text: '好', start: 0, end: 1, timingSource: 'model' },
  ]
  const cursor = createTimingCursor(flattenTokenUnits(source))
  const first = mapTokenFromCursor(cursor, 'e1', '好')
  assert.deepEqual([first.start, first.end], [0, 1])
  // A second copy of the same word has no further source characters, so it must
  // not borrow the first match.
  const second = mapTokenFromCursor(cursor, 'e2', '好')
  assert.deepEqual([second.start, second.end], [null, null])
  assert.equal(second.timingSource, 'unmatched')
})

test('neighbor tokens keep their existing units and timing source', () => {
  const neighbor: SubtitleToken = {
    id: 's-t07',
    text: '阳光',
    start: 3,
    end: 4,
    timingSource: 'model',
    units: [
      { char: '阳', start: 3, end: 3.5 },
      { char: '光', start: 3.5, end: 4 },
    ],
  }
  const retained = buildRetainedSegment('s', [neighbor])
  assert.deepEqual(retained.tokens[0].units, neighbor.units)
  assert.equal(retained.tokens[0].timingSource, 'model')
  assert.deepEqual([retained.start, retained.end], [3, 4])
})

test('a draft without a matching cursor source stays fully unmatched', () => {
  const segment = buildEditedSegment('s', null, [{ id: 'e1', text: '新文本' }])
  assert.deepEqual([segment.start, segment.end], [undefined, undefined])
  assert.equal(segment.tokens[0].timingSource, 'unmatched')
  assert.equal(segment.tokens[0].start, null)
})
