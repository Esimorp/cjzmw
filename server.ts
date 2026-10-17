import fs from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import express from 'express'
import type { ViteDevServer } from 'vite'
import { createAsrService } from './asr-server.ts'
import { createMediaService } from './media-server.ts'
import { createWorkspaceService } from './workspace-server.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isProduction =
  process.argv.includes('--production') || process.env.NODE_ENV === 'production'
const port = Number(process.env.PORT ?? (isProduction ? 3000 : 5173))

const clientDist = path.resolve(__dirname, 'dist/client')
const serverEntry = path.resolve(__dirname, 'dist/server/entry-server.js')
const indexHtml = path.resolve(__dirname, 'index.html')

type Render = (url: string) => Promise<{ html: string; head: string }>

async function createServer() {
  const app = express()
  const httpServer = createHttpServer(app)

  let vite: ViteDevServer | undefined
  let template: string
  let render: Render

  // The media API is registered before Vite/static/SSR so uploads and video
  // content are never handled by the client-side fallbacks. The ASR router is
  // mounted first: every `/api/asr/*` path must be resolved there, before the
  // media router's `/videos/:id` catch-all can see it.
  //
  // The workspace owns the persisted video file and subtitle JSON; media and
  // ASR read the video through it so a restart restores the same content.
  const workspace = await createWorkspaceService()
  const asr = await createAsrService({
    resolveVideoFile: (videoId) => media.findVideo(videoId)?.filePath,
    isVideoBusy: (videoId) => asr.hasActiveJobForVideo(videoId),
  })
  const media = await createMediaService({
    isVideoBusy: (videoId) => asr.hasActiveJobForVideo(videoId),
    workspace,
  })
  media.restore(workspace.get().video)
  app.use('/api', asr.router)
  app.use('/api', workspace.router)
  app.use('/api', media.router)
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: '未找到该请求的接口。', code: 'NOT_FOUND' })
  })

  if (isProduction) {
    template = await fs.readFile(path.join(clientDist, 'index.html'), 'utf-8')
    render = (await import(pathToFileURL(serverEntry).href)).render as Render
    app.use(express.static(clientDist, { index: false }))
  } else {
    const { createServer: createViteServer } = await import('vite')
    vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: { server: httpServer },
      },
      appType: 'custom',
    })
    app.use(vite.middlewares)
    template = await fs.readFile(indexHtml, 'utf-8')
    render = async (url) => {
      const mod = await vite!.ssrLoadModule('/src/entry-server.tsx')
      return (mod.render as Render)(url)
    }
  }

  app.use(async (req, res, next) => {
    const url = req.originalUrl

    try {
      // Re-read the template on every development request so edits to
      // index.html are picked up without restarting the server.
      let html = vite ? await fs.readFile(indexHtml, 'utf-8') : template
      if (vite) {
        html = await vite.transformIndexHtml(url, html)
      }

      const { html: appHtml, head } = await render(url)
      html = html
        .replace('<!--app-head-->', head)
        .replace('<!--app-html-->', appHtml)

      res.status(200).set({ 'Content-Type': 'text/html' }).end(html)
    } catch (error) {
      vite?.ssrFixStacktrace(error as Error)
      next(error)
    }
  })

  return {
    app,
    httpServer,
    vite,
    cleanup: media.cleanup,
    cleanupWorkspace: workspace.cleanup,
    cleanupAsr: asr.cleanup,
    stopAsr: asr.stop,
  }
}

const { httpServer, vite, cleanup, cleanupWorkspace, cleanupAsr, stopAsr } = await createServer()

httpServer.on('error', (error) => {
  console.error('Failed to start server:', error)
  process.exit(1)
})

httpServer.listen(port, () => {
  console.log(
    `Server started at http://localhost:${port} (${isProduction ? 'production' : 'development'})`,
  )
})

let shuttingDown = false

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`Received ${signal}, shutting down...`)

  const timeout = setTimeout(() => {
    console.error('Shutdown timed out, forcing exit')
    process.exit(1)
  }, 10_000)
  timeout.unref()

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()))
      // Shutdown must not wait for a multi-minute transcription: stop the jobs
      // (killing their process trees), then close the idle connections they
      // left behind so `close` can finish.
      void stopAsr().then(() => httpServer.closeIdleConnections())
    })
    await vite?.close()
    // ASR jobs read the stored media files, so they are cleaned up before the
    // media temp directory disappears.
    await cleanupAsr()
    // Flush the workspace JSON; the workspace directory is never deleted.
    await cleanupWorkspace()
    await cleanup()
    clearTimeout(timeout)
    process.exit(0)
  } catch (error) {
    console.error('Error during shutdown:', error)
    process.exit(1)
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
