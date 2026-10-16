import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// When an SSR-only module changes, the client module graph has no matching
// module, so React Fast Refresh cannot handle the update. Fall back to a full
// page reload in that case and let React refresh handle everything else.
function ssrFullReload(): Plugin {
  return {
    name: 'ssr-full-reload',
    hotUpdate({ modules, server }) {
      if (this.environment.name !== 'ssr') return

      for (const mod of modules) {
        if (!mod.file) continue
        const clientModules = server.environments.client.moduleGraph.getModulesByFile(mod.file)
        if (!clientModules || clientModules.size === 0) {
          server.environments.client.hot.send({ type: 'full-reload' })
          return []
        }
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), ssrFullReload()],
  build: {
    outDir: 'dist/client',
  },
})
