import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createWorkspaceService, validateSegments } from '../workspace-server.ts'

async function tempWorkspace(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cjzmw-ws-test-'))
  return {
    dir,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    },
  }
}

async function readDocument(dir: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, 'workspace.json'), 'utf-8'))
  } catch {
    return null
  }
}

test('workspace validates segments and rejects unsafe references', () => {
  const segments = validateSegments([
    {
      id: 's1',
      tokens: [
        {
          id: 't1',
          text: '你好',
          start: 1,
          end: 2,
          timingSource: 'model',
          styleName: 'emphasis',
          units: [{ char: '你', start: 1, end: 1.5 }],
        },
        { id: 't2', text: '普通', start: 2, end: 3, timingSource: 'model' },
      ],
    },
  ])
  assert.equal(segments[0].tokens[0].units?.length, 1)
  // Optional style reference survives validation...
  assert.equal(segments[0].tokens[0].styleName, 'emphasis')
  // ...and stays absent for older documents that never had the field.
  assert.equal(segments[0].tokens[1].styleName, undefined)

  assert.throws(() => validateSegments([{ id: 's1', tokens: [{ id: 't1', text: 'a' }] }, { id: 's1', tokens: [] }]))
  assert.throws(() => validateSegments([{ id: 's1', tokens: [{ id: 't', text: 'a' }, { id: 't', text: 'b' }] }]))
  assert.throws(() => validateSegments('nope'))
})

test('workspace persists JSON atomically and restores it', async () => {
  const ws = await tempWorkspace()
  try {
    const service = await createWorkspaceService({ dir: ws.dir })
    // No document yet: nothing is written until a real change arrives.
    assert.equal(service.get().revision, 0)
    assert.equal(await readDocument(ws.dir), null)

    const express = (await import('express')).default
    const app = express()
    app.use(service.router)
    const server = app.listen(0)
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/workspace`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: 0,
          video: null,
          segments: [
            { id: 's1', tokens: [{ id: 't1', text: '持久化', start: 0, end: 1, timingSource: 'model' }] },
          ],
        }),
      })
      assert.equal(response.status, 200)
      assert.equal(service.get().revision, 1)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }

    const onDisk = await readDocument(ws.dir)
    assert.equal(onDisk?.revision, 1)
    // Atomic write leaves no temporary files behind.
    const leftovers = (await fs.readdir(ws.dir)).filter((name) => name.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])

    // A restart reads the same document back.
    const reopened = await createWorkspaceService({ dir: ws.dir })
    assert.equal(reopened.get().revision, 1)
    assert.equal(reopened.get().segments[0].tokens[0].text, '持久化')
  } finally {
    await ws.cleanup()
  }
})

test('workspace keeps a corrupt file untouched and blocks writes', async () => {
  const ws = await tempWorkspace()
  try {
    const corrupt = '{"revision": 1, "segments": [ BROKEN'
    await fs.writeFile(path.join(ws.dir, 'workspace.json'), corrupt, 'utf-8')

    const service = await createWorkspaceService({ dir: ws.dir })
    // The file is preserved byte for byte; nothing was overwritten.
    assert.equal(await fs.readFile(path.join(ws.dir, 'workspace.json'), 'utf-8'), corrupt)
    assert.equal(service.get().revision, 0)

    await assert.rejects(
      service.commitUpload({
        metadata: {
          id: 'x',
          url: '/api/videos/x/content',
          filename: 'x.mp4',
          size: 1,
          duration: 1,
          width: 1,
          height: 1,
          fps: 1,
          codec: 'h264',
        },
        tempPath: path.join(ws.dir, 'missing.mp4'),
        contentType: 'video/mp4',
        baseRevision: 0,
      }),
      (error: Error & { code?: string }) => error.code === 'WORKSPACE_CORRUPT',
    )
    assert.equal(await fs.readFile(path.join(ws.dir, 'workspace.json'), 'utf-8'), corrupt)
  } finally {
    await ws.cleanup()
  }
})

test('workspace writes are serialized so revisions never go backwards', async () => {
  const ws = await tempWorkspace()
  try {
    const service = await createWorkspaceService({ dir: ws.dir })
    const tempFile = path.join(ws.dir, 'upload.mp4')
    await fs.writeFile(tempFile, 'fake-video', 'utf-8')

    // Concurrent commits with the same base revision: exactly one wins.
    const attempt = (id: string) =>
      service
        .commitUpload({
          metadata: {
            id,
            url: `/api/videos/${id}/content`,
            filename: `${id}.mp4`,
            size: 10,
            duration: 1,
            width: 1,
            height: 1,
            fps: 1,
            codec: 'h264',
          },
          tempPath: tempFile,
          contentType: 'video/mp4',
          baseRevision: 0,
        })
        .then(() => 'ok')
        .catch((error: Error & { code?: string }) => error.code ?? 'error')

    const results = await Promise.all([attempt('a'), attempt('b')])
    assert.deepEqual(results.filter((value) => value === 'ok').length, 1)
    assert.ok(results.includes('WORKSPACE_CONFLICT'), `got ${results.join(',')}`)
    assert.equal(service.revision(), 1)

    const onDisk = await readDocument(ws.dir)
    assert.equal(onDisk?.revision, 1)
  } finally {
    await ws.cleanup()
  }
})
