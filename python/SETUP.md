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
  package) and `model/` (weights from the upstream models release). The
  upstream repository ships **no** llama.cpp binaries: download the prebuilt
  Windows package from
  [llama.cpp Releases](https://github.com/ggml-org/llama.cpp/releases) and put
  the DLLs in `qwen_asr_gguf/inference/bin/`.

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
`ALIGN_EMPTY_RESULT`, `ALIGN_AUDIO_TOO_LONG`, or `WORKER_FAILED` with the
underlying exception class).

## Alignment limits

`QwenForcedAligner` needs the whole audio plus all text in **one** llama.cpp
decode batch. It hard-codes `n_batch = 2048` and only forwards `n_ctx`, so long
input used to abort inside llama.cpp
(`GGML_ASSERT(n_tokens_all <= cparams.n_batch)` → Windows exit code
`3221226505`).

`python/qwen_worker.py` now sizes both values from the actual input
(`estimate_align_context`): about 14 audio tokens per second plus a
conservative text budget, rounded up to 512 and capped at **16384** positions.
Measured on the bundled 0.6B aligner: 86 s audio + 434 characters needs 2320
positions, and the estimate reserves 3584 for it.

- Within the budget the alignment runs normally.
- Above it the worker fails before loading the decoder and reports
  `ALIGN_AUDIO_TOO_LONG` with the estimated size, so the API returns a clear
  message instead of a native crash. Split or trim the video for longer input.

The HTTP layer still applies its own independent, structural limits (not text
length): at most 400 segments, 4000 tokens, and a 512 kb request body.
