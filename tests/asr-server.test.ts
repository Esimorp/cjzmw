import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  appendBoundedLog,
  killProcessTree,
  lastStderrHint,
  mapAlignSnapshot,
  parseWorkerResult,
  readWorkerError,
  validateAlignSnapshot,
} from '../asr-server.ts'

test('ASR log tails stay bounded in line count', () => {
  const job: { log: { stream: 'stdout' | 'stderr'; line: string }[] } = { log: [] }
  for (let index = 0; index < 100; index += 1) {
    appendBoundedLog(job, 'stdout', `line ${index}\n`)
  }
  assert.equal(job.log.length, 40)
  assert.equal(job.log[0].line, 'line 60')
  assert.equal(job.log[39].line, 'line 99')
})

test('ASR log lines are truncated and keep their stream', () => {
  const job: { log: { stream: 'stdout' | 'stderr'; line: string }[] } = { log: [] }
  appendBoundedLog(job, 'stderr', `${'x'.repeat(1000)}\n`)
  assert.equal(job.log.length, 1)
  assert.equal(job.log[0].stream, 'stderr')
  assert.ok(job.log[0].line.length <= 401)
  assert.ok(job.log[0].line.endsWith('…'))
})

test('blank and whitespace-only log chunks are ignored', () => {
  const job: { log: { stream: 'stdout' | 'stderr'; line: string }[] } = { log: [] }
  appendBoundedLog(job, 'stdout', '\n\n   \n')
  assert.equal(job.log.length, 0)
})

test('untrustworthy pids are never passed to taskkill', () => {
  // Guards the "tracked process only" rule: nothing is spawned for these.
  assert.doesNotThrow(() => {
    killProcessTree(0)
    killProcessTree(-1)
    killProcessTree(Number.NaN)
  })
})

test('align snapshot keeps exact token ids and text', () => {
  const snapshot = validateAlignSnapshot({
    segments: [
      { id: 's1', tokens: [{ id: 't1', text: '字幕' }, { id: 't2', text: '工具' }] },
      { id: 's2', tokens: [{ id: 't3', text: '很好' }] },
    ],
  })
  assert.deepEqual(snapshot.segments[1], { id: 's2', tokens: [{ id: 't3', text: '很好' }] })
  assert.equal(snapshot.tokenCount, 3)
  assert.equal(snapshot.text, '字幕 工具\n很好')
})

test('align snapshot rejects empty subtitles with EMPTY_SUBTITLES', () => {
  for (const body of [
    { segments: [] },
    { segments: [{ id: 's', tokens: [] }] },
    { segments: [{ id: 's', tokens: [{ id: 't', text: '   ' }] }] },
    { segments: [{ id: 's', tokens: [{ id: 't', text: '，。！' }] }] },
  ]) {
    assert.throws(
      () => validateAlignSnapshot(body),
      (error: Error & { code?: string }) => error.code === 'EMPTY_SUBTITLES',
    )
  }
})

test('align snapshot rejects duplicate ids and malformed bodies', () => {
  assert.throws(
    () =>
      validateAlignSnapshot({
        segments: [{ id: 's', tokens: [{ id: 't', text: '甲' }, { id: 't', text: '乙' }] }],
      }),
    (error: Error & { code?: string }) => error.code === 'ALIGN_DUPLICATE_ID',
  )
  assert.throws(
    () =>
      validateAlignSnapshot({
        segments: [
          { id: 's', tokens: [{ id: 't1', text: '甲' }] },
          { id: 's', tokens: [{ id: 't2', text: '乙' }] },
        ],
      }),
    (error: Error & { code?: string }) => error.code === 'ALIGN_DUPLICATE_ID',
  )
  assert.throws(
    () => validateAlignSnapshot(null),
    (error: Error & { code?: string }) => error.code === 'ALIGN_INVALID',
  )
})

test('align snapshot enforces bounded size but not character count', () => {
  const manySegments = Array.from({ length: 401 }, (_, index) => ({
    id: `s${index}`,
    tokens: [{ id: `t${index}`, text: '字' }],
  }))
  assert.throws(
    () => validateAlignSnapshot({ segments: manySegments }),
    (error: Error & { code?: string }) => error.code === 'ALIGN_TOO_MANY_SEGMENTS',
  )

  // A single long line is accepted: there is no character-count limit, only
  // the independent segment/token count bounds above.
  const longLine = validateAlignSnapshot({
    segments: [{ id: 's', tokens: [{ id: 't', text: '字'.repeat(401) }] }],
  })
  assert.equal(longLine.tokenCount, 1)
  assert.equal(longLine.segments[0].tokens[0].text.length, 401)
})

test('align mapping preserves ids and text and uses raw timings in order', () => {
  const snapshot = validateAlignSnapshot({
    segments: [
      { id: 's1', tokens: [{ id: 't1', text: '字幕' }, { id: 't2', text: '工具' }] },
    ],
  })
  // The aligner emits one item per character.
  const raw = [
    { text: '字', start: 1, end: 1.25 },
    { text: '幕', start: 1.25, end: 1.5 },
    { text: '工', start: 1.5, end: 1.75 },
    { text: '具', start: 1.75, end: 2 },
  ]
  const segments = mapAlignSnapshot(snapshot, raw)
  assert.equal(segments[0].id, 's1')
  assert.deepEqual(
    segments[0].tokens.map((token) => [token.id, token.text, token.start, token.end]),
    [
      ['t1', '字幕', 1, 1.5],
      ['t2', '工具', 1.5, 2],
    ],
  )
  assert.deepEqual([segments[0].start, segments[0].end], [1, 2])
})

test('align mapping leaves unmatched tokens null instead of inventing times', () => {
  const snapshot = validateAlignSnapshot({
    segments: [{ id: 's1', tokens: [{ id: 't1', text: '字幕' }, { id: 't2', text: '外星' }] }],
  })
  const raw = [
    { text: '字', start: 0, end: 0.5 },
    { text: '幕', start: 0.5, end: 1 },
  ]
  const tokens = mapAlignSnapshot(snapshot, raw)[0].tokens
  assert.deepEqual([tokens[0].start, tokens[0].end], [0, 1])
  assert.equal(tokens[1].id, 't2')
  assert.equal(tokens[1].text, '外星')
  assert.deepEqual([tokens[1].start, tokens[1].end], [null, null])
  assert.equal(tokens[1].timingSource, 'unmatched')
})

test('worker result parsing tolerates only well formed JSON', () => {
  assert.deepEqual(parseWorkerResult('{"raw":[{"text":"甲","start":0,"end":1}]}').raw, [
    { text: '甲', start: 0, end: 1 },
  ])
  assert.throws(
    () => parseWorkerResult(''),
    (error: Error & { code?: string }) => error.code === 'WORKER_NO_RESULT',
  )
  assert.throws(
    () => parseWorkerResult('not json'),
    (error: Error & { code?: string }) => error.code === 'WORKER_NO_RESULT',
  )
})

test('structured worker failures are surfaced from the stderr tail', () => {
  const job: { log: { stream: 'stdout' | 'stderr'; line: string }[] } = { log: [] }
  appendBoundedLog(job, 'stdout', 'worker ok\n')
  appendBoundedLog(job, 'stderr', '{"code":"ALIGN_AUDIO_TOO_LONG","message":"音频与字幕过长。"}\n')
  assert.deepEqual(readWorkerError(job), {
    code: 'ALIGN_AUDIO_TOO_LONG',
    message: '音频与字幕过长。',
  })
})

test('only the last well formed structured worker failure is used', () => {
  const job: { log: { stream: 'stdout' | 'stderr'; line: string }[] } = { log: [] }
  appendBoundedLog(job, 'stderr', '{"code":"FIRST","message":"旧错误"}\n')
  appendBoundedLog(job, 'stderr', '{"code":\n')
  appendBoundedLog(job, 'stderr', '{"code":"SECOND","message":"新错误"}\n')
  assert.equal(readWorkerError(job)?.code, 'SECOND')
})

test('native crash reports keep the last stderr line and ignore empty logs', () => {
  const job: { log: { stream: 'stdout' | 'stderr'; line: string }[] } = { log: [] }
  appendBoundedLog(job, 'stderr', 'GGML_ASSERT(n_tokens_all <= cparams.n_batch) failed\n')
  assert.equal(lastStderrHint(job), ' GGML_ASSERT(n_tokens_all <= cparams.n_batch) failed')
  assert.equal(readWorkerError(job), null)

  const empty: { log: { stream: 'stdout' | 'stderr'; line: string }[] } = { log: [] }
  assert.equal(readWorkerError(empty), null)
  assert.equal(lastStderrHint(empty), '')
})

test('token popup anchor effect does not depend on freshly built objects', () => {  // Regression for the white screen: the popup anchor layout effect listed a
  // freshly-built `{ segment, token }` object in its deps, so its own
  // setTokenAnchor re-created the dep every render and React threw
  // "Maximum update depth exceeded". Guard the source pattern directly.
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf-8')
  const layoutEffects = [...source.matchAll(/useLayoutEffect\(\(\) => \{[\s\S]*?\n  \}, (\[[^\]]*\])\)/g)]
  assert.ok(layoutEffects.length > 0, 'expected layout effects in App.tsx')

  const anchorEffect = layoutEffects.find((match) => match[0].includes('setTokenAnchor'))
  assert.ok(anchorEffect, 'token anchor effect must exist')
  const deps = anchorEffect[1]
  // Only primitive/stable deps are allowed here.
  assert.doesNotMatch(deps, /\binspected\b(?!Key)/, `unstable dependency list: ${deps}`)
  assert.match(deps, /inspectedKey/)

  // The setter must bail out on unchanged values, otherwise scroll/resize
  // handlers would re-render unconditionally.
  assert.match(anchorEffect[0], /setTokenAnchor\(\(current\) =>/)
  assert.match(anchorEffect[0], /current\.key === anchorKey/)
})
