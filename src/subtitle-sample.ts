import type { SubtitleSegment, SubtitleToken } from './subtitle-types.ts'

/** Legacy sample token: no timing information, so it stays `unmatched`. */
export function legacyToken(id: string, text: string): SubtitleToken {
  return { id, text, start: null, end: null, timingSource: 'unmatched' }
}

/**
 * Sample subtitles shown before any workspace is restored.
 *
 * This is the single shared definition: `SubtitleProvider` seeds the context
 * with it on both the client and the server.
 */
export const SAMPLE_SEGMENTS: SubtitleSegment[] = [
  {
    id: 'seg-001',
    tokens: [
      { id: 'seg-001-t01', text: '清晨' },
      { id: 'seg-001-t02', text: '的' },
      { id: 'seg-001-t03', text: '第一缕' },
      { id: 'seg-001-t04', text: '阳光' },
      { id: 'seg-001-t05', text: '洒' },
      { id: 'seg-001-t06', text: '在' },
      { id: 'seg-001-t07', text: '窗台' },
      { id: 'seg-001-t08', text: '上' },
    ],
  },
  {
    id: 'seg-002',
    tokens: [
      { id: 'seg-002-t01', text: '我' },
      { id: 'seg-002-t02', text: '喜欢' },
      { id: 'seg-002-t03', text: '这样' },
      { id: 'seg-002-t04', text: '安静' },
      { id: 'seg-002-t05', text: '的' },
      { id: 'seg-002-t06', text: '时刻' },
    ],
  },
  {
    id: 'seg-003',
    tokens: [
      { id: 'seg-003-t01', text: '用' },
      { id: 'seg-003-t02', text: '一' },
      { id: 'seg-003-t03', text: '杯' },
      { id: 'seg-003-t04', text: '热茶' },
      { id: 'seg-003-t05', text: '的' },
      { id: 'seg-003-t06', text: '时间' },
      { id: 'seg-003-t07', text: '，' },
      { id: 'seg-003-t08', text: '整理' },
      { id: 'seg-003-t09', text: '今天' },
      { id: 'seg-003-t10', text: '的' },
      { id: 'seg-003-t11', text: '心情' },
    ],
  },
  {
    id: 'seg-004',
    tokens: [
      { id: 'seg-004-t01', text: '把' },
      { id: 'seg-004-t02', text: '每' },
      { id: 'seg-004-t03', text: '一句' },
      { id: 'seg-004-t04', text: '话' },
      { id: 'seg-004-t05', text: '都' },
      { id: 'seg-004-t06', text: '念' },
      { id: 'seg-004-t07', text: '得' },
      { id: 'seg-004-t08', text: '慢' },
      { id: 'seg-004-t09', text: '一点' },
    ],
  },
  {
    id: 'seg-005',
    tokens: [
      { id: 'seg-005-t01', text: '让' },
      { id: 'seg-005-t02', text: '观众' },
      { id: 'seg-005-t03', text: '听' },
      { id: 'seg-005-t04', text: '得' },
      { id: 'seg-005-t05', text: '清' },
      { id: 'seg-005-t06', text: '，' },
      { id: 'seg-005-t07', text: '也' },
      { id: 'seg-005-t08', text: '看' },
      { id: 'seg-005-t09', text: '得' },
      { id: 'seg-005-t10', text: '懂' },
    ],
  },
  {
    id: 'seg-006',
    tokens: [
      { id: 'seg-006-t01', text: '节奏' },
      { id: 'seg-006-t02', text: '不' },
      { id: 'seg-006-t03', text: '必' },
      { id: 'seg-006-t04', text: '太' },
      { id: 'seg-006-t05', text: '快' },
      { id: 'seg-006-t06', text: '，' },
      { id: 'seg-006-t07', text: '留' },
      { id: 'seg-006-t08', text: '一点' },
      { id: 'seg-006-t09', text: '呼吸' },
      { id: 'seg-006-t10', text: '的' },
      { id: 'seg-006-t11', text: '空间' },
    ],
  },
  {
    id: 'seg-007',
    tokens: [
      { id: 'seg-007-t01', text: '这' },
      { id: 'seg-007-t02', text: '一' },
      { id: 'seg-007-t03', text: '期' },
      { id: 'seg-007-t04', text: '我们' },
      { id: 'seg-007-t05', text: '聊聊' },
      { id: 'seg-007-t06', text: '剪辑' },
      { id: 'seg-007-t07', text: '的' },
      { id: 'seg-007-t08', text: '小' },
      { id: 'seg-007-t09', text: '技巧' },
    ],
  },
  {
    id: 'seg-008',
    tokens: [
      { id: 'seg-008-t01', text: '先' },
      { id: 'seg-008-t02', text: '记' },
      { id: 'seg-008-t03', text: '下' },
      { id: 'seg-008-t04', text: '时间' },
      { id: 'seg-008-t05', text: '点' },
      { id: 'seg-008-t06', text: '，' },
      { id: 'seg-008-t07', text: '再' },
      { id: 'seg-008-t08', text: '慢慢' },
      { id: 'seg-008-t09', text: '对' },
      { id: 'seg-008-t10', text: '齐' },
      { id: 'seg-008-t11', text: '画面' },
    ],
  },
  {
    id: 'seg-009',
    tokens: [
      { id: 'seg-009-t01', text: '字幕' },
      { id: 'seg-009-t02', text: '是' },
      { id: 'seg-009-t03', text: '声音' },
      { id: 'seg-009-t04', text: '的' },
      { id: 'seg-009-t05', text: '影子' },
      { id: 'seg-009-t06', text: '，' },
      { id: 'seg-009-t07', text: '也' },
      { id: 'seg-009-t08', text: '是' },
      { id: 'seg-009-t09', text: '内容' },
      { id: 'seg-009-t10', text: '的' },
      { id: 'seg-009-t11', text: '骨架' },
    ],
  },
  {
    id: 'seg-010',
    tokens: [
      { id: 'seg-010-t01', text: '谢谢' },
      { id: 'seg-010-t02', text: '你' },
      { id: 'seg-010-t03', text: '看到' },
      { id: 'seg-010-t04', text: '这里' },
      { id: 'seg-010-t05', text: '，' },
      { id: 'seg-010-t06', text: '我们' },
      { id: 'seg-010-t07', text: '下期' },
      { id: 'seg-010-t08', text: '再见' },
    ],
  },
].map((segment) => ({
  id: segment.id,
  tokens: segment.tokens.map((token) => legacyToken(token.id, token.text)),
}))

/** A token with a trustworthy `[start, end)` range. */
export function hasValidTokenRange(
  token: SubtitleToken,
): token is SubtitleToken & { start: number; end: number } {
  const { start, end } = token
  return (
    typeof start === 'number' &&
    typeof end === 'number' &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start >= 0 &&
    end > start
  )
}

/** Earliest valid token start in the segment, derived (never cached). */
export function segmentStartSeconds(segment: SubtitleSegment): number | null {
  let earliest: number | null = null
  for (const token of segment.tokens) {
    if (!hasValidTokenRange(token)) continue
    if (earliest === null || token.start < earliest) earliest = token.start
  }
  return earliest
}

/** Latest valid token end in the segment, derived (never cached). */
export function segmentEndSeconds(segment: SubtitleSegment): number | null {
  let latest: number | null = null
  for (const token of segment.tokens) {
    if (!hasValidTokenRange(token)) continue
    if (latest === null || token.end > latest) latest = token.end
  }
  return latest
}

/** True when `seconds` falls inside a token's `[start, end)` range. */
export function tokenActiveAt(token: SubtitleToken, seconds: number): boolean {
  if (!hasValidTokenRange(token)) return false
  return seconds >= token.start && seconds < token.end
}

/** True when `seconds` falls inside the segment's derived token range. */
export function segmentActiveAt(segment: SubtitleSegment, seconds: number): boolean {
  const start = segmentStartSeconds(segment)
  const end = segmentEndSeconds(segment)
  if (start === null || end === null) return false
  return seconds >= start && seconds < end
}
