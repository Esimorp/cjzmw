import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SAMPLE_SEGMENTS,
  hasValidTokenRange,
  segmentActiveAt,
  segmentEndSeconds,
  segmentStartSeconds,
  tokenActiveAt,
} from '../src/subtitle-sample.ts'
import type { SubtitleToken } from '../src/subtitle-types.ts'

function token(
  id: string,
  start: number | null,
  end: number | null,
): SubtitleToken {
  return {
    id,
    text: id,
    start,
    end,
    timingSource: start == null || end == null ? 'unmatched' : 'model',
  }
}

/** Token built purely to exercise the range predicate. */
function range(start: number | null, end: number | null): SubtitleToken {
  return { id: 'r', text: 'r', start, end, timingSource: 'model' }
}

test('hasValidTokenRange accepts finite non-negative ranges with end > start', () => {
  assert.equal(hasValidTokenRange(range(0, 1)), true)
  assert.equal(hasValidTokenRange(range(1, 1.5)), true)
  // Zero-duration items are preserved as data but never "active".
  assert.equal(hasValidTokenRange(range(1, 1)), false)
  assert.equal(hasValidTokenRange(range(2, 1)), false)
  assert.equal(hasValidTokenRange(range(null, 1)), false)
  assert.equal(hasValidTokenRange(range(-0.5, 1)), false)
  assert.equal(hasValidTokenRange(range(0, Number.NaN)), false)
  assert.equal(hasValidTokenRange(range(0, Number.POSITIVE_INFINITY)), false)
})

test('tokenActiveAt uses half-open [start, end) semantics', () => {
  assert.equal(tokenActiveAt(token('a', 1, 2), 1), true)
  assert.equal(tokenActiveAt(token('a', 1, 2), 1.5), true)
  assert.equal(tokenActiveAt(token('a', 1, 2), 2), false)
  assert.equal(tokenActiveAt(token('a', 1, 2), 0.999), false)
})

test('tokenActiveAt never activates invalid, zero-duration or missing timings', () => {
  const zero = token('z', 3, 3)
  assert.equal(tokenActiveAt(zero, 3), false)
  const unmatched = token('u', null, null)
  assert.equal(tokenActiveAt(unmatched, 0), false)
  const negative = token('n', -1, 0.5)
  assert.equal(tokenActiveAt(negative, 0), false)
})

test('segment times are derived from valid tokens, ignoring stale segment bounds', () => {
  const segment = {
    id: 's1',
    // Deliberately wrong cache; must not be trusted.
    start: 99,
    end: 1,
    tokens: [token('a', 4, 5), token('b', 2, 3), token('c', null, null)],
  }
  assert.equal(segmentStartSeconds(segment), 2)
  assert.equal(segmentEndSeconds(segment), 5)
  assert.equal(segmentActiveAt(segment, 4.5), true)
  // 3.5 sits in a token gap but still inside the derived segment span.
  assert.equal(segmentActiveAt(segment, 3.5), true)
  assert.equal(segmentActiveAt(segment, 1.5), false)
  assert.equal(segmentActiveAt(segment, 5), false)
})

test('segment with no valid token times reports null bounds and never activates', () => {
  const segment = {
    id: 's2',
    tokens: [token('a', null, null), token('b', 1, 1)],
  }
  assert.equal(segmentStartSeconds(segment), null)
  assert.equal(segmentEndSeconds(segment), null)
  assert.equal(segmentActiveAt(segment, 1), false)
})

test('sample segments keep derived, ordering-consistent bounds', () => {
  assert.ok(SAMPLE_SEGMENTS.length > 0)
  for (const segment of SAMPLE_SEGMENTS) {
    const start = segmentStartSeconds(segment)
    const end = segmentEndSeconds(segment)
    if (start == null || end == null) {
      assert.equal(segmentActiveAt(segment, 0), false)
      continue
    }
    assert.ok(end > start, `segment ${segment.id} has non-positive derived range`)
  }
})

