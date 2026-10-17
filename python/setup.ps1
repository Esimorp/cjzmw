# Provision the project-local Python environment for the Qwen3-ASR worker.
#
# Creates .venv from the installed Python 3.14 (via the py launcher) and installs
# the pinned, CPU-only requirements from python/requirements.txt.
# Nothing is installed globally: every package goes into .venv.
#
# Usage (from anywhere):
#   powershell -ExecutionPolicy Bypass -File python\setup.ps1
#
# Optional: set $env:QWEN_PY_LAUNCHER to a different launcher spec, e.g. "-3.12".

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$launcher = if ($env:QWEN_PY_LAUNCHER) { $env:QWEN_PY_LAUNCHER } else { '-3.14' }
$venvPython = Join-Path $repoRoot '.venv\Scripts\python.exe'
$requirements = Join-Path $repoRoot 'python\requirements.txt'

function Fail([string]$message, [int]$code) {
    Write-Error $message
    exit $code
}

Write-Host "== creating .venv with py $launcher (project-local only) =="
& py $launcher -m venv .venv
if ($LASTEXITCODE -ne 0) { Fail "venv creation failed (exit $LASTEXITCODE)" 1 }

if (-not (Test-Path $venvPython)) { Fail "venv interpreter missing: $venvPython" 2 }

Write-Host "== upgrading pip inside .venv =="
& $venvPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { Fail "pip upgrade failed (exit $LASTEXITCODE)" 3 }

Write-Host "== installing python\requirements.txt =="
& $venvPython -m pip install -r $requirements
if ($LASTEXITCODE -ne 0) { Fail "requirements install failed (exit $LASTEXITCODE)" 4 }

Write-Host "== verifying imports (source runtime, CPU provider) =="
& $venvPython -c "import sys; sys.path.insert(0,'lib/qwen'); import numpy, scipy, onnxruntime, gguf, srt; from pydub import AudioSegment; import qwen_asr_gguf.inference as m; print('deps ok', numpy.__version__, scipy.__version__, onnxruntime.__version__); print('engine', m.QwenASREngine.__name__, 'aligner', m.QwenForcedAligner.__name__); print('providers', onnxruntime.get_available_providers())"
if ($LASTEXITCODE -ne 0) { Fail "import verification failed (exit $LASTEXITCODE)" 5 }

Write-Host "== done: $venvPython =="
exit 0
