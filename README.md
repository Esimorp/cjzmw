# 超级字幕王 (cjzmw)

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
| `pnpm typecheck` | Type-checks the server project (`tsc -p tsconfig.server.json --noEmit`). |
| `pnpm test` | Runs the `node:test` timestamp-mapping tests (`node --test src/*.test.ts`, Node 24 native TypeScript). |
| `pnpm preview` | Serves the production build (`node server.ts --production`), same as `pnpm start`. |

## Environment variables

- `PORT` — server port. Defaults to `5173` in development and `3000` in production.
- `NODE_ENV` — set to `production` to serve built assets instead of using Vite middleware. The `--production` CLI flag does the same and takes precedence in the scripts.
- `FFPROBE_PATH` — **optional**. Absolute path to the `ffprobe` binary used to inspect uploads. When unset, the server runs `ffprobe`, so **`ffprobe` must be installed and available on `PATH`**; if it is missing, uploads fail with `503 FFPROBE_UNAVAILABLE`.
- `FFMPEG_PATH` — **optional**. Absolute path to the `ffmpeg` binary used to extract 16 kHz mono PCM audio for speech recognition. When unset, `ffmpeg` is resolved from `PATH`; if it is missing, jobs fail with `503 FFMPEG_UNAVAILABLE`.
- `QWEN_ASR_DIR` — **optional**. Runtime directory containing the `model/` and `qwen_asr_gguf/` sources/deps. Defaults to `lib/qwen`. The whole directory is git-ignored and must be copied in manually. The frozen `transcribe.exe` inside it is **not** used.
- `QWEN_PYTHON` — **optional**. Absolute path to the worker interpreter. Defaults to `.venv\Scripts\python.exe` in the repository; see [`python/SETUP.md`](python/SETUP.md).
- `WORKSPACE_DIR` — **optional**. Directory for the persistent workspace (`workspace.json` + `videos/`). Defaults to `./storage/workspace` (git-ignored).

## Media API

The media router (`media-server.ts`) is mounted at `/api` **before** Vite middleware, static assets, and SSR, so uploads and video content never fall through to the client. Unknown `/api` routes return a JSON `404`.

| Route | Description |
| --- | --- |
| `POST /api/videos` | Accepts one file in the `video` multipart field (max **2 GB**, one file per request), probes it with `ffprobe`, stores it in a per-process temp directory, and returns the video metadata as JSON (`201`). |
| `GET /api/videos/:id/content` | Streams the stored video with the probed content type and HTTP range support (`206`); an unsatisfiable range returns `416`. |
| `HEAD /api/videos/:id/content` | Same as above but headers only. |
| `DELETE /api/videos/:id` | Deletes the temp file and metadata, returning `204`. |

Responses use a localized JSON error shape (`{ error, code }`):

- `400` — malformed upload request or missing file part.
- `413` — file exceeds the 2 GB limit.
- `422` — the upload is not a valid video (no video stream, invalid or missing duration/dimensions/fps, or unparseable probe output).
- `404` — unknown video id or unknown `/api` route.
- `503` — `ffprobe` is not available.
- `504` — the probe exceeded the 30 second `ffprobe` timeout.

Metadata returned by `POST /api/videos`:

```ts
interface VideoMetadata {
  id: string // UUID
  url: string // /api/videos/:id/content
  filename: string // sanitized original filename
  size: number // bytes
  duration: number // seconds
  width: number // display width, rotation applied
  height: number // display height, rotation applied
  fps: number // from avg_frame_rate, r_frame_rate fallback
  codec: string // probed video codec name
}
```

Notes:

- **Temporary storage only.** Uploads live in a unique `fs.mkdtemp` directory under `os.tmpdir()`; nothing is written into the repo. Files are removed on `DELETE`, on failed uploads/probes, and the whole directory is removed during graceful shutdown (after the HTTP server closes).
- **No transcoding.** Files are stored byte-for-byte as uploaded; the server does not re-encode or remux.
- The shared `VideoMetadata` type lives in `src/video-types.ts` and is importable from both server and client code.

## Persistent workspace

The app keeps exactly **one** resumable workspace on disk:

- Location: `WORKSPACE_DIR`, default `./storage/workspace` (git-ignored).
- `workspace.json` — `revision`, the current video metadata, the video filename, all subtitle segments/tokens/`units` with timings, and `updatedAt`. Written atomically (temp file + rename) and serialized so writes never interleave.
- `videos/<id>.<ext>` — the video bytes. The JSON **never** embeds the video; playback still goes through the `/api/videos/:id/content` proxy with Range support.

Behaviour:

- **Restore on load.** `GET /api/workspace` returns the saved document; the client applies it once before enabling autosave, so the built-in sample/empty state can never overwrite the disk copy.
- **Autosave.** TXT import, edits, deletes, merges, and completed ASR/align jobs schedule a debounced (600 ms) `PUT /api/workspace` carrying the revision they were based on.
- **Uploads.** A new video is only adopted after the server has copied the file and durably written the JSON (subtitles reset to empty). Any upload/probe/write failure leaves the previous workspace untouched. The old video file is removed only after the new document is durable.
- **Conflicts.** A stale revision returns `409 WORKSPACE_CONFLICT` (shown in the UI) instead of silently overwriting; saving can never swap the video identity.
- **Corruption.** If `workspace.json` cannot be parsed it is left byte-for-byte untouched, the API reports `corrupt: true` / `writable: false`, and all writes return `409 WORKSPACE_CORRUPT`.
- **Leaving the page never deletes anything**; pending edits are flushed instead.
- **Not restored:** running ASR/align jobs, open editors/popups and drafts. Only saved data comes back.
- **Paths** are validated: only a bare filename is stored, and the resolved file must stay inside `videos/`.

The app is always served from the root path (`/`); there is no configurable base path.

## Speech recognition API

The ASR router (`asr-server.ts`) is mounted at `/api` **before** the media router, so `/api/asr/*` is never swallowed by the media router's `/videos/:id` catch-all. Unknown `/api/asr/*` paths return a JSON `404`.

A job extracts audio from the registered video with FFmpeg (`-vn -ac 1 -ar 16000 -c:a pcm_s16le`) into a private per-job directory, then runs the tracked worker with the **project virtualenv** Python (`.venv\Scripts\python.exe python\qwen_worker.py`). The worker imports the unmodified `lib/qwen/qwen_asr_gguf` **source** package, so the frozen `transcribe.exe` is never invoked:

```
.venv\Scripts\python.exe python\qwen_worker.py --mode <asr|align> --input <job>/input.wav \
    --request <job>/request.json --output <job>/result.json --runtime-dir lib/qwen
```

Environment is configured before any inference import: `PYTHONUTF8=1`, `PYTHONNOUSERSITE=1`, `VK_ICD_FILENAMES=none`, `GGML_VULKAN=0`, the runtime `bin/` added to `PATH` and `os.add_dll_directory`, and the runtime root prepended to `sys.path`. Inference is CPU-only (`use_dml=False`).

**Setup:** run `python\setup.ps1` (or follow [`python/SETUP.md`](python/SETUP.md)) to create `.venv` from the installed Python 3.14 and install `python\requirements.txt`; nothing is installed globally. `.venv/`, `.python/` and `.cache/` are git-ignored.

Limits: force alignment has **no duration cap and no character cap** — the whole audio and the supplied text are aligned in one call; only an empty snapshot is rejected. The aligner still runs with its fixed decoder context, so long audio or very long text can fail at the runtime level; such errors are surfaced as-is rather than pre-empted or chunked. Independent structural limits still apply: ≤400 segments, ≤4000 tokens, 512 kb body.

| Route | Description |
| --- | --- |
| `POST /api/videos/:id/asr` | Queues a transcription of a registered video and returns `202 { id, kind: "asr", status }`. `404` for an unknown video, `409 ASR_BUSY` when that video already has an active job, `409 ASR_QUEUE_FULL` when the bounded queue is full. |
| `POST /api/videos/:id/align` | Queues a force alignment of the same audio against the supplied subtitle snapshot `{ segments: [{ id, tokens: [{ id, text }] }] }` (body ≤ 512 kb) and returns `202 { id, kind: "align", status }`. Token ids and text are echoed back verbatim; `400 EMPTY_SUBTITLES` / `ALIGN_INVALID` / `ALIGN_DUPLICATE_ID` / `ALIGN_TOO_MANY_SEGMENTS` / `ALIGN_TOO_MANY_TOKENS` describe validation failures (there is no text-length limit). |
| `GET /api/asr/jobs/:id` | Job status: `queued` (with `queuePosition`), `running`, `completed` or `failed`, plus `kind`. Completed jobs also return `result`. |
| `DELETE /api/asr/jobs/:id` | Cancels a queued/running job (killing the tracked process tree) or drops a finished one. Always `204`. |

Job response shape (no filesystem path is ever included):

```ts
interface AsrJobResponse {
  id: string
  videoId: string
  kind: 'asr' | 'align'
  status: 'queued' | 'running' | 'completed' | 'failed'
  queuedAt: string // ISO timestamp
  startedAt?: string
  finishedAt?: string
  queuePosition?: number // 1-based, while queued
  error?: { code: string; message: string } // localized
  log?: { stream: 'stdout' | 'stderr'; line: string }[] // bounded tail
  result?: {
    kind: 'asr' | 'align'
    text: string // transcript (asr) or the aligned snapshot text (align)
    srt: string // SRT for asr, empty string for align
    raw: { text: string; start: number; end: number }[] // seconds
    segments: SubtitleSegment[] // tokens with timings, ready for the UI
    durationMs: number
  }
}
```

Behaviour notes:

- **CPU bounded.** Only one inference runs at a time; further requests wait in a queue of at most 4 jobs. Every queued and running job counts towards the video pin.
- **Bounded jobs.** A job is aborted — and its Windows process tree killed with `taskkill /PID <pid> /T /F` (no shell, tracked pid only) — after 30 minutes. Stdout/stderr are kept as a bounded tail (40 lines, 400 chars each).
- **Pinned media.** While a video is referenced by a queued or running job, `DELETE /api/videos/:id` returns `409 VIDEO_BUSY`. The audio is extracted into the job directory before the engine starts.
- **Shutdown.** `SIGINT`/`SIGTERM` stop ASR jobs (killing their process trees) and close idle connections so shutdown does not wait for a long transcription; ASR jobs are cleaned up before the media temp directory.
- `src/subtitle-timing.ts` (pure, shared with the client) expands each raw ASR item into per-code-point timings, splits SRT/transcript text into word tokens with `Intl.Segmenter`, and maps tokens onto the ordered raw characters. A token matching one whole raw item keeps the model bounds (`timingSource: 'model'`); fragments and recombinations get interpolated bounds (`'interpolated'`); unmatched text stays `null` / `'unmatched'` and is never extrapolated. Each timed token also carries `units: { char, start, end }[]` so later split/merge edits can remap timings. Example: raw `字幕工具 [1,2]` maps to `字幕 [1,1.5]` and `工具 [1.5,2]`.

## How SSR works

`index.html` is the single template and contains two placeholders:

- `<!--app-head-->` — replaced with markup returned by the server render (empty by default).
- `<!--app-html-->` — replaced with the server-rendered React markup.

**Development** (`server.ts`): a `node:http` server is created from the Express app and handed to Vite as `server.hmr.server`, so HMR shares the same HTTP server and port. Vite runs in `middlewareMode` with `appType: 'custom'`. `index.html` is re-read from disk on every request, then passed through `vite.transformIndexHtml` to inject HMR/client scripts, and `vite.ssrLoadModule('/src/entry-server.tsx')` renders the app with fresh module state. `vite.ssrFixStacktrace` maps errors back to source.

**Production**: `dist/client` is served statically and `dist/server/entry-server.js` is imported once at startup to render requests.

**HMR for SSR-only modules**: `vite.config.ts` registers a small `hotUpdate` plugin. When a module changes in the `ssr` environment and the client module graph has no matching module (for example `src/entry-server.tsx`), React Fast Refresh cannot apply the update, so the plugin sends a `full-reload` to the client and returns `[]`. Otherwise it returns nothing and React refresh handles the update normally.

**Shutdown**: `SIGINT`/`SIGTERM` close the HTTP server, close the Vite dev server, then remove the media temp directory, with a 10 second timeout that forces exit if shutdown hangs. Listen errors are logged and exit with code 1.

## Project layout

```
index.html               # SSR template with app-head / app-html placeholders
server.ts                # Express 5 + node:http server (dev middleware + prod static/SSR)
media-server.ts          # /api media router: upload, probe, range streaming, delete
asr-server.ts            # /api ASR router: FFmpeg audio extraction + Qwen ASR jobs
src/video-types.ts       # Shared VideoMetadata type
src/subtitle-types.ts    # Shared SubtitleToken / SubtitleSegment types
src/subtitle-timing.ts   # Shared raw-ASR -> token timestamp mapping (pure)
vite.config.ts           # Client build -> dist/client, SSR full-reload HMR plugin
vite.config.ssr.ts       # SSR build -> dist/server
tsconfig.app.json        # Client sources (DOM libs)
tsconfig.node.json       # Vite configs
tsconfig.server.json     # server.ts + media/asr routers + src/entry-server.tsx (Node types)
src/entry-client.tsx     # hydrateRoot
src/entry-server.tsx     # render(url) -> { html, head }
src/App.tsx              # Application root
src/subtitle-timing.test.ts # node:test coverage for the timestamp mapping
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
