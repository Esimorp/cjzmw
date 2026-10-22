# Qwen3-ASR worker environment

The transcription backend runs the **unmodified** `lib/qwen/qwen_asr_gguf`
source package inside a project-local virtualenv. The package and its models
come from [HaujetZhao/Qwen3-ASR-GGUF](https://github.com/HaujetZhao/Qwen3-ASR-GGUF);
see the README's “lib 放置结构” section for the exact directory layout. The
frozen `lib/qwen/transcribe.exe` and `lib/qwen/internal/` modules are **not**
used and are never copied into the venv.

- Interpreter: `.venv/Scripts/python.exe`
- Worker (tracked): `python/qwen_worker.py`
- Pinned packages: `python/requirements.txt`
- Ignored: `.venv/`, `.python/`, `.cache/`

## Prerequisites

- Windows x64.
- `ffmpeg` on `PATH` (or `FFMPEG_PATH`) — used by Node to extract 16 kHz mono WAV.
- `lib/qwen/` copied in manually (git-ignored): `qwen_asr_gguf/` (source
  package), `model/` (weights from the upstream models release), and the
  llama.cpp DLLs in `qwen_asr_gguf/inference/bin/`.

## Provision the venv

```powershell
# from the repository root
py -3.14 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r python\requirements.txt
.\.venv\Scripts\python.exe -c "import numpy, scipy, onnxruntime, gguf, pydub, srt; print('deps ok')"
```

If no interpreter with binary wheels for the required packages is installed
(this project was validated on Python **3.14.4**, which has `cp314` wheels for
numpy/scipy/onnxruntime/gguf), provision a project-local interpreter with
`uv` instead of touching the system Python:

```powershell
$env:UV_PYTHON_INSTALL_DIR = "$PWD\.python"
$env:UV_CACHE_DIR          = "$PWD\.cache\uv"
uv venv --python 3.12 .venv
.\.venv\Scripts\python.exe -m pip install -r python\requirements.txt
```

Both `.python/` and `.cache/` are git-ignored; global Python, site-packages and
`PATH` are never modified.

## Verify the source runtime imports

```powershell
.\.venv\Scripts\python.exe -c "import sys; sys.path.insert(0, 'lib/qwen'); import qwen_asr_gguf.inference as m; print(m.QwenASREngine, m.QwenForcedAligner)"
```

## Run the worker manually

```powershell
$env:VK_ICD_FILENAMES = "none"
.\.venv\Scripts\python.exe python\qwen_worker.py `
  --mode asr `
  --input .validation\job\input.wav `
  --request .validation\job\request.json `
  --output .validation\job\result.json `
  --runtime-dir lib/qwen
```

`--mode align` uses the same arguments plus a request containing the subtitle
text (see below).

## Request / result files

`--request` (UTF-8 JSON):

| mode | fields |
| --- | --- |
| `asr` | `{"language": "Chinese", "temperature": 0}` |
| `align` | `{"language": "Chinese", "text": "…ordered subtitle text…"}` |

`--output` (UTF-8 JSON), always `raw: [{ text, start, end }]` in seconds:

| mode | fields |
| --- | --- |
| `asr` | `mode, language, transcript, srt, raw` |
| `align` | `mode, language, text, duration, raw` |

Failures exit non-zero with one JSON object on stderr:
`{"code": "...", "message": "..."}` (e.g. `ALIGN_EMPTY_TEXT`,
`ALIGN_EMPTY_RESULT`, or `WORKER_FAILED` with the underlying exception class).

## Alignment limits

There is **no duration cap and no character cap**. The worker loads the whole
audio and hands it plus the supplied text to `QwenForcedAligner.align(...)` in
a single call. The only validation is that the text is non-empty.

Honest caveat: the aligner still runs with its fixed decoder context
(`n_ctx = 2048` in `qwen_asr_gguf`), and the encoder/LLM also need memory for
the audio and the text tokens. With long audio or very long text these real
limits can still produce a low-level failure from the runtime (context
overflow, allocation failure, very slow inference). Such errors are reported as
they occur (`WORKER_FAILED` plus the underlying exception name, with the
traceback in the job log tail) — they are not predicted, pre-empted, silently
truncated, or split into chunks.
Long-input / long-text support has **not** been measured; see the user
verification steps in the removal report.

The HTTP layer still applies its own independent, structural limits (not text
length): at most 400 segments, 4000 tokens, and a 512 kb request body.
