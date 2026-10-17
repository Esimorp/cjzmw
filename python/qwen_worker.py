"""Project-local Qwen3-ASR worker.

Runs the unmodified ``lib/qwen/qwen_asr_gguf`` source package inside the
project virtualenv (``.venv``), never the frozen ``transcribe.exe``.

Usage:
    python python/qwen_worker.py --mode asr \\
        --input job/input.wav --request job/request.json \\
        --output job/result.json --runtime-dir lib/qwen

The worker writes UTF-8 JSON and prints human-readable progress to stdout.
Every failure exits non-zero with a single structured JSON object on stderr so
the Node side can localize the error.
"""

import argparse
import json
import os
import sys
import traceback
from pathlib import Path

DEFAULT_LANGUAGE = "Chinese"
CPU_ONLY_ENV = {"VK_ICD_FILENAMES": "none", "GGML_VULKAN": "0"}


class WorkerError(Exception):
    """Structured, user-safe failure raised by the worker."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def configure_environment(runtime_dir: Path) -> None:
    """Prepare env + import paths *before* any inference module is imported."""
    # The project venv must never see the frozen runtime's own site packages.
    internal = os.sep.join(("lib", "qwen", "internal"))
    sys.path[:] = [
        entry
        for entry in sys.path
        if internal not in entry and "qwen" + os.sep + "internal" not in entry
    ]
    sys.dont_write_bytecode = True

    # CPU-only: hide Vulkan ICDs and make sure no GPU path gets selected.
    for key, value in CPU_ONLY_ENV.items():
        os.environ[key] = value

    bin_dir = runtime_dir / "qwen_asr_gguf" / "inference" / "bin"
    if bin_dir.is_dir():
        os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ.get("PATH", "")
        if hasattr(os, "add_dll_directory"):
            os.add_dll_directory(str(bin_dir))

    # ``qwen_asr_gguf`` lives in the runtime root and is imported from source.
    if str(runtime_dir) not in sys.path:
        sys.path.insert(0, str(runtime_dir))


def load_request(path: Path) -> dict:
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        raise WorkerError("REQUEST_MISSING", "缺少识别请求文件。")
    except json.JSONDecodeError:
        raise WorkerError("REQUEST_INVALID", "识别请求文件格式无效。")
    if not isinstance(data, dict):
        raise WorkerError("REQUEST_INVALID", "识别请求文件格式无效。")
    return data


def write_result(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)


def items_to_raw(items) -> list:
    """Convert aligner items to the ``[{text, start, end}]`` shape."""
    raw = []
    for item in items or []:
        text = getattr(item, "text", "")
        start = float(getattr(item, "start_time", 0.0))
        end = float(getattr(item, "end_time", start))
        if text is None or text == "":
            continue
        raw.append({"text": text, "start": round(start, 3), "end": round(end, 3)})
    return raw


def run_asr(input_path: Path, runtime_dir: Path, request: dict) -> dict:
    from qwen_asr_gguf.inference import ASREngineConfig, AlignerConfig, QwenASREngine
    from qwen_asr_gguf.inference import exporters

    model_dir = str(runtime_dir / "model")
    language = request.get("language") or DEFAULT_LANGUAGE
    temperature = float(request.get("temperature", 0.0))

    config = ASREngineConfig(
        model_dir=model_dir,
        use_dml=False,
        enable_aligner=True,
        align_config=AlignerConfig(model_dir=model_dir, use_dml=False),
    )
    engine = None
    try:
        engine = QwenASREngine(config=config)
        result = engine.transcribe(
            audio_file=str(input_path),
            language=language,
            temperature=temperature,
        )
    finally:
        if engine is not None:
            try:
                engine.shutdown()
            except Exception:  # shutdown must never mask the result
                traceback.print_exc()

    # The language switch and numeric cleanup live in the tested exporters, so
    # the transcript and SRT are always regenerated from this run's result
    # instead of relying on files left behind by an earlier attempt.
    transcript_path = input_path.with_suffix(".txt")
    srt_path = input_path.with_suffix(".srt")
    try:
        exporters.export_to_txt(str(transcript_path), result)
        exporters.export_to_srt(str(srt_path), result)
    except Exception:  # exporters are a convenience; raw items still matter
        traceback.print_exc()

    transcript = ""
    srt = ""
    if transcript_path.exists():
        transcript = transcript_path.read_text(encoding="utf-8", errors="replace")
    if srt_path.exists():
        srt = srt_path.read_text(encoding="utf-8", errors="replace")
    if transcript == "":
        transcript = getattr(result, "text", "") or ""

    alignment = getattr(result, "alignment", None)
    items = getattr(alignment, "items", None) if alignment is not None else None
    raw = items_to_raw(items)

    return {
        "mode": "asr",
        "language": language,
        "transcript": transcript,
        "srt": srt,
        "raw": raw,
    }


def run_align(input_path: Path, runtime_dir: Path, request: dict) -> dict:
    from qwen_asr_gguf.inference import AlignerConfig, QwenForcedAligner, load_audio
    from qwen_asr_gguf.inference.utils import normalize_language_name, validate_language

    text = request.get("text")
    if not isinstance(text, str) or text.strip() == "":
        raise WorkerError("ALIGN_EMPTY_TEXT", "没有可对齐的字幕文本。")
    language = request.get("language") or DEFAULT_LANGUAGE
    language = normalize_language_name(language)
    validate_language(language)

    model_dir = str(runtime_dir / "model")

    # No duration or character cap: the whole audio and the supplied text are
    # handed to the aligner, and any low-level failure (context / resource
    # exhaustion) is reported as-is instead of being pre-empted by an
    # artificial limit.
    audio = load_audio(str(input_path))
    duration = float(len(audio)) / 16000.0

    aligner = QwenForcedAligner(config=AlignerConfig(model_dir=model_dir, use_dml=False))
    result = aligner.align(audio, text, language=language)
    raw = items_to_raw(getattr(result, "items", None) if result is not None else None)
    if not raw:
        raise WorkerError("ALIGN_EMPTY_RESULT", "强制对齐没有返回可用结果。")

    return {
        "mode": "align",
        "language": language,
        "text": text,
        "duration": round(duration, 3),
        "raw": raw,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Qwen3-ASR project worker")
    parser.add_argument("--mode", choices=("asr", "align"), required=True)
    parser.add_argument("--input", required=True, help="input WAV path")
    parser.add_argument("--request", required=True, help="UTF-8 JSON request path")
    parser.add_argument("--output", required=True, help="UTF-8 JSON result path")
    parser.add_argument("--runtime-dir", required=True, help="lib/qwen runtime directory")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)

    input_path = Path(args.input).resolve()
    request_path = Path(args.request).resolve()
    output_path = Path(args.output).resolve()
    runtime_dir = Path(args.runtime_dir).resolve()

    try:
        if not runtime_dir.is_dir():
            raise WorkerError("RUNTIME_MISSING", "服务器上未安装语音识别运行时。")
        if not input_path.is_file():
            raise WorkerError("INPUT_MISSING", "缺少待识别的音频文件。")

        configure_environment(runtime_dir)
        request = load_request(request_path)

        if args.mode == "asr":
            payload = run_asr(input_path, runtime_dir, request)
        else:
            payload = run_align(input_path, runtime_dir, request)

        write_result(output_path, payload)
        print(f"worker ok: mode={args.mode} raw={len(payload.get('raw') or [])}")
        return 0
    except WorkerError as error:
        sys.stderr.write(
            json.dumps({"code": error.code, "message": error.message}, ensure_ascii=False) + "\n"
        )
        return 2
    except Exception as error:  # report every failure structurally
        traceback.print_exc()
        sys.stderr.write(
            json.dumps(
                {"code": "WORKER_FAILED", "message": f"识别工作进程失败：{error.__class__.__name__}"},
                ensure_ascii=False,
            )
            + "\n"
        )
        return 3


if __name__ == "__main__":
    import multiprocessing

    multiprocessing.freeze_support()
    sys.exit(main())
