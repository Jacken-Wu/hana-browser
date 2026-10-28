#!/usr/bin/env python3
"""SenseVoiceSmall 单次转写：读一个 16k 单声道 WAV，把文字打到 stdout，然后退出。

设计成一次性进程，是这一层最重要的取舍：
- 没有常驻服务、没有端口、没有守护进程，闲时占用严格为零。
- 代价是每次重新加载模型，SenseVoice int8 大约 1 到 2 秒。
- 上层（lib/asr.js）只认 stdout，所以换引擎只要换这个脚本或换命令行。

依赖：pip install sherpa-onnx
模型：任意目录，里面要有 model.int8.onnx（或 model.onnx）和 tokens.txt，
      例如 csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17。

用法：
    python sensevoice_oneshot.py --model <模型目录> --input <wav> [--language zh] [--threads 4]
"""

from __future__ import annotations

import argparse
import os
import sys
import time
import wave

WINDOW_SECONDS = 30.0

# SenseVoice 的输入典型长度是 30 秒左右，超过就自己切。
# 不能硬切：从词中间下刀会让模型丢掉上下文，实测拼接处会吐出乱码。
# 做法是先读满一窗，再在尾部几秒里找能量最低的位置下刀，让切口落在停顿上。


def lower_priority() -> None:
    """把进程降到低于正常优先级：前台忙的时候，它应该先让路。"""
    try:
        if sys.platform == "win32":
            import ctypes

            BELOW_NORMAL_PRIORITY_CLASS = 0x00004000
            handle = ctypes.windll.kernel32.GetCurrentProcess()
            ctypes.windll.kernel32.SetPriorityClass(handle, BELOW_NORMAL_PRIORITY_CLASS)
        else:
            os.nice(10)
    except Exception:
        # 提权失败不该影响转写本身。
        pass


def die(message: str, code: int = 2) -> "None":
    print(message, file=sys.stderr)
    raise SystemExit(code)


def pick_model(model_dir: str) -> tuple[str, str]:
    if not os.path.isdir(model_dir):
        die(f"模型目录不存在：{model_dir}")
    candidates = ["model.int8.onnx", "model.onnx", "sensevoice.int8.onnx", "sensevoice.onnx"]
    model_path = ""
    for name in candidates:
        candidate = os.path.join(model_dir, name)
        if os.path.isfile(candidate):
            model_path = candidate
            break
    if not model_path:
        die(
            f"模型目录里没找到 onnx 权重：{model_dir}\n"
            f"期望文件名之一：{', '.join(candidates)}"
        )
    tokens = os.path.join(model_dir, "tokens.txt")
    if not os.path.isfile(tokens):
        die(f"缺少 tokens.txt：{tokens}")
    return model_path, tokens


def build_recognizer(model_dir: str, threads: int, language: str):
    try:
        import sherpa_onnx
    except ImportError:
        die("没装 sherpa-onnx。先跑：pip install sherpa-onnx")

    model_path, tokens = pick_model(model_dir)
    try:
        return sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=model_path,
            tokens=tokens,
            num_threads=max(1, threads),
            use_itn=True,
            debug=False,
            language=language or "auto",
        )
    except TypeError:
        # 旧版本没有 language 参数，退一步照样能跑（自动判语种）。
        return sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=model_path,
            tokens=tokens,
            num_threads=max(1, threads),
            use_itn=True,
            debug=False,
        )


def iter_chunks(path: str, window_seconds: float):
    """按能量最低点下刀切块，避免从词中间切断。"""
    import numpy as np

    with wave.open(path, "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        if width != 2:
            die(f"只接受 16 位 PCM WAV，当前位宽 {width * 8} 位")
        if channels != 1:
            die(f"只接受单声道 WAV，当前 {channels} 声道")
        if rate != 16000:
            die(f"只接受 16 kHz 采样率，当前 {rate} Hz")

        window = int(rate * window_seconds)
        # 在窗口尾部这段里找停顿，找到就把切口放那儿。
        search = int(rate * min(5.0, window_seconds * 0.2))
        frame = max(1, int(rate * 0.02))  # 20ms 一个能量单元

        buffer = np.zeros(0, dtype=np.float32)

        def cut_index(samples):
            """返回窗口内能量最低的切点；尾部 search 范围内不再向前退。"""
            tail = samples[window - search:window]
            if tail.size < frame * 2:
                return window
            usable = (tail.size // frame) * frame
            energy = np.abs(tail[:usable]).reshape(-1, frame).mean(axis=1)
            best = int(np.argmin(energy))
            return window - search + best * frame

        while True:
            raw = handle.readframes(window * 2)
            if not raw:
                break
            piece = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
            buffer = np.concatenate([buffer, piece]) if buffer.size else piece
            while buffer.size >= window:
                cut = cut_index(buffer)
                yield rate, buffer[:cut]
                buffer = buffer[cut:]

        if buffer.size:
            yield rate, buffer


def main() -> int:
    parser = argparse.ArgumentParser(description="SenseVoiceSmall 单次转写")
    parser.add_argument("--model", required=True, help="模型目录")
    parser.add_argument("--input", required=True, help="16k 单声道 WAV 路径")
    parser.add_argument("--language", default="zh", help="语言代码，auto 表示自动判断")
    parser.add_argument("--threads", type=int, default=4, help="线程数上限")
    parser.add_argument("--window", type=float, default=WINDOW_SECONDS, help="分块秒数")
    args = parser.parse_args()

    if not os.path.isfile(args.input):
        die(f"音频文件不存在：{args.input}")

    lower_priority()
    started = time.time()
    recognizer = build_recognizer(args.model, args.threads, args.language)

    pieces: list[str] = []
    total = 0
    for rate, samples in iter_chunks(args.input, args.window):
        stream = recognizer.create_stream()
        stream.accept_waveform(rate, samples)
        recognizer.decode_stream(stream)
        text = (stream.result.text or "").strip()
        if text:
            pieces.append(text)
            total += len(text)
            print(f"[{len(pieces)}] {len(text)} 字，累计 {total}", file=sys.stderr, flush=True)

    transcript = "\n".join(pieces).strip()
    if not transcript:
        die("没有识别出任何文字，音频可能是纯音乐或静音", 3)

    elapsed = time.time() - started
    print(f"完成：{len(transcript)} 字，用时 {elapsed:.1f}s", file=sys.stderr, flush=True)
    sys.stdout.write(transcript)
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
