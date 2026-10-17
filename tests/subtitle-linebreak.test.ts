import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LINE_BREAK,
  createLineBreakToken,
  hasMeaningfulText,
  isLineBreakToken,
  splitDraftAtCaret,
  splitDraftToLines,
  tokensToDraft,
} from '../src/subtitle-linebreak.ts'
import {
  buildSegmentWithLineBreaks,
  createTimingCursor,
  flattenTokenUnits,
} from '../src/subtitle-timing.ts'
import type { SubtitleToken } from '../src/subtitle-types.ts'

function timed(id: string, text: string, start: number, end: number): SubtitleToken {
  const chars = [...text]
  const step = (end - start) / chars.length
  return {
    id,
    text,
    start,
    end,
    timingSource: 'model',
    units: chars.map((char, index) => ({
      char,
      start: start + step * index,
      end: start + step * (index + 1),
    })),
  }
}

test('a line break is a dedicated untimed token', () => {
  const token = createLineBreakToken('lb1')
  assert.equal(token.text, LINE_BREAK)
  assert.equal(token.start, null)
  assert.equal(token.end, null)
  assert.equal(token.timingSource, 'unmatched')
  assert.equal(isLineBreakToken(token), true)
  assert.equal(isLineBreakToken({ text: '第一' }), false)
})

test('draft rendering keeps line breaks as newlines', () => {
  const tokens = [
    timed('a', '第一', 1, 2),
    createLineBreakToken('lb'),
    timed('b', '第二', 3, 4),
  ]
  assert.equal(tokensToDraft(tokens), '第一\n第二')
})

test('saving a line break keeps one segment and maps timings by token', () => {
  const original = [timed('a', '第一', 1, 2), timed('b', '第二', 3, 4)]
  const cursor = createTimingCursor(flattenTokenUnits(original))
  const tokens = [
    { id: 'a', text: '第一' },
    createLineBreakToken('lb1'),
    { id: 'b', text: '第二' },
  ]
  const segment = buildSegmentWithLineBreaks('seg', cursor, tokens, original)

  assert.equal(segment.tokens.length, 3)
  assert.equal(isLineBreakToken(segment.tokens[1]), true)
  // The break never eats timing: the second word still owns its own bounds.
  assert.deepEqual(
    { start: segment.tokens[0].start, end: segment.tokens[0].end },
    { start: 1, end: 2 },
  )
  assert.deepEqual(
    { start: segment.tokens[2].start, end: segment.tokens[2].end },
    { start: 3, end: 4 },
  )
  assert.equal(
    segment.tokens[2].timingSource,
    'interpolated',
    'recombined fragments are interpolated, not model',
  )
  // Segment span derives from timed tokens only.
  assert.equal(segment.start, 1)
  assert.equal(segment.end, 4)
})

test('line breaks survive a JSON round trip', () => {
  const original = [timed('a', '第一', 1, 2), timed('b', '第二', 3, 4)]
  const cursor = createTimingCursor(flattenTokenUnits(original))
  const segment = buildSegmentWithLineBreaks(
    'seg',
    cursor,
    [
      { id: 'a', text: '第一' },
      createLineBreakToken('lb1'),
      { id: 'b', text: '第二' },
    ],
    original,
  )
  const restored = JSON.parse(JSON.stringify(segment)) as typeof segment
  assert.equal(tokensToDraft(restored.tokens), '第一\n第二')
  assert.equal(restored.tokens.filter((t) => isLineBreakToken(t)).length, 1)
})

test('the line-break marker inherits the segment style, words keep theirs', () => {
  const original: SubtitleToken[] = [
    { ...timed('a', '第一', 1, 2), styleName: 'big' },
    { ...timed('b', '第二', 3, 4), styleName: 'big' },
  ]
  const cursor = createTimingCursor(flattenTokenUnits(original))
  const segment = buildSegmentWithLineBreaks(
    'seg',
    cursor,
    [
      { id: 'a', text: '第一' },
      createLineBreakToken('lb1'),
      { id: 'b', text: '第二' },
    ],
    original,
  )
  assert.equal(segment.tokens[0].styleName, 'big')
  assert.equal(segment.tokens[1].styleName, 'big')
  assert.equal(segment.tokens[2].styleName, 'big')
})

test('draft splitting drops blank lines but keeps interior breaks', () => {
  assert.deepEqual(splitDraftToLines('第一 第二\n\n第三'), [
    ['第一', '第二'],
    ['第三'],
  ])
  assert.deepEqual(splitDraftToLines('单行 段落'), [['单行', '段落']])
})

test('caret split keeps text on both sides and trims the cut', () => {
  assert.deepEqual(splitDraftAtCaret('第一第二', 2), { before: '第一', after: '第二' })
  assert.deepEqual(splitDraftAtCaret('第一 第二', 3), { before: '第一', after: '第二' })
  // Out-of-range and empty sides are reported as-is for the caller to reject.
  assert.deepEqual(splitDraftAtCaret('第一', 0), { before: '', after: '第一' })
  assert.deepEqual(splitDraftAtCaret('第一', 99), { before: '第一', after: '' })
  assert.equal(hasMeaningfulText('  \n '), false)
  assert.equal(hasMeaningfulText('字'), true)
})

test('splitting at the caret produces two adjacent timed segments', () => {
  const original = [timed('a', '第一', 1, 2), timed('b', '第二', 3, 4)]
  const cursor = createTimingCursor(flattenTokenUnits(original))
  const { before, after } = splitDraftAtCaret('第一第二', 2)
  const head = buildSegmentWithLineBreaks(
    'seg',
    cursor,
    [{ id: 'seg-t01', text: before }],
    original,
  )
  const tail = buildSegmentWithLineBreaks(
    'seg-n',
    cursor,
    [{ id: 'seg-n-t01', text: after }],
    original,
  )
  assert.deepEqual(
    { start: head.tokens[0].start, end: head.tokens[0].end },
    { start: 1, end: 2 },
  )
  assert.deepEqual(
    { start: tail.tokens[0].start, end: tail.tokens[0].end },
    { start: 3, end: 4 },
  )
})

test('old documents without line-break tokens render unchanged', () => {
  const legacy = [timed('a', '第一', 1, 2), timed('b', '第二', 2, 3)]
  assert.equal(tokensToDraft(legacy), '第一 第二')
  const cursor = createTimingCursor(flattenTokenUnits(legacy))
  const rebuilt = buildSegmentWithLineBreaks(
    'seg',
    cursor,
    [
      { id: 'a', text: '第一' },
      { id: 'b', text: '第二' },
    ],
    legacy,
  )
  assert.equal(rebuilt.tokens.length, 2)
  assert.equal(rebuilt.tokens.some((t) => isLineBreakToken(t)), false)
})
