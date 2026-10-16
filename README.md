# cjzmw

Express 5 + React 19 SSR skeleton built on Vite, with Remotion pinned for video rendering.

## Stack

- **Express 5** — HTTP server, Vite middleware in development
- **React 19** — `renderToString` on the server, `hydrateRoot` on the client
- **Vite 8** — dev middleware, `transformIndexHtml`, `ssrLoadModule`, client + SSR builds
- **tsx** — runs and watches `server.ts` in development (dev dependency)
- **Remotion 4.0.536** — pinned (`remotion`, `@remotion/player`, `@remotion/cli`)

## Scripts

| Script | Description |
| --- | --- |
| `pnpm dev` | Starts Express with Vite in middleware mode via `tsx watch server.ts` (restarts on server changes, HMR for the client). Default port `5173`. |
| `pnpm build` | Type-checks all projects (`tsc -b`), builds the client to `dist/client`, then builds the SSR bundle to `dist/server`. |
| `pnpm start` | Serves the production build (`node server.ts --production`). Default port `3000`. |
| `pnpm lint` | Runs Oxlint. |
| `pnpm preview` | Serves the production build (`node server.ts --production`), same as `pnpm start`. |

## Environment variables

- `PORT` — server port. Defaults to `5173` in development and `3000` in production.
- `NODE_ENV` — set to `production` to serve built assets instead of using Vite middleware. The `--production` CLI flag does the same and takes precedence in the scripts.

The app is always served from the root path (`/`); there is no configurable base path.

## How SSR works

`index.html` is the single template and contains two placeholders:

- `<!--app-head-->` — replaced with markup returned by the server render (empty by default).
- `<!--app-html-->` — replaced with the server-rendered React markup.

**Development** (`server.ts`): a `node:http` server is created from the Express app and handed to Vite as `server.hmr.server`, so HMR shares the same HTTP server and port. Vite runs in `middlewareMode` with `appType: 'custom'`. `index.html` is re-read from disk on every request, then passed through `vite.transformIndexHtml` to inject HMR/client scripts, and `vite.ssrLoadModule('/src/entry-server.tsx')` renders the app with fresh module state. `vite.ssrFixStacktrace` maps errors back to source.

**Production**: `dist/client` is served statically and `dist/server/entry-server.js` is imported once at startup to render requests.

**HMR for SSR-only modules**: `vite.config.ts` registers a small `hotUpdate` plugin. When a module changes in the `ssr` environment and the client module graph has no matching module (for example `src/entry-server.tsx`), React Fast Refresh cannot apply the update, so the plugin sends a `full-reload` to the client and returns `[]`. Otherwise it returns nothing and React refresh handles the update normally.

**Shutdown**: `SIGINT`/`SIGTERM` close the HTTP server and the Vite dev server, with a 10 second timeout that forces exit if shutdown hangs. Listen errors are logged and exit with code 1.

## Project layout

```
index.html               # SSR template with app-head / app-html placeholders
server.ts                # Express 5 + node:http server (dev middleware + prod static/SSR)
vite.config.ts           # Client build -> dist/client, SSR full-reload HMR plugin
vite.config.ssr.ts       # SSR build -> dist/server
tsconfig.app.json        # Client sources (DOM libs)
tsconfig.node.json       # Vite configs
tsconfig.server.json     # server.ts + src/entry-server.tsx (Node types)
src/entry-client.tsx     # hydrateRoot
src/entry-server.tsx     # render(url) -> { html, head }
src/App.tsx              # Application root
```

## Production run

```bash
pnpm build
pnpm start
```

`pnpm start` and `pnpm preview` both run `node server.ts --production`. Setting `NODE_ENV=production` has the same effect:

```powershell
$env:NODE_ENV="production"; pnpm start
```

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
