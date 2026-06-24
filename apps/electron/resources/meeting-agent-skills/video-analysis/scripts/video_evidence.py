#!/usr/bin/env python3
"""Prepare visual/audio evidence from a video."""

from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import sys
from pathlib import Path


def run(command: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=check, text=True, capture_output=True)


def require_tool(name: str) -> None:
    if shutil.which(name) is None:
        raise SystemExit(f"Missing required tool: {name}")


def safe_slug(path: Path) -> str:
    return "".join(char.lower() if char.isalnum() else "-" for char in path.stem).strip("-")[:80]


def probe(video: Path) -> dict:
    result = run(
        [
            "ffprobe",
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(video),
        ]
    )
    return json.loads(result.stdout)


def duration_seconds(metadata: dict) -> float:
    raw = metadata.get("format", {}).get("duration")
    if raw:
        return float(raw)

    for stream in metadata.get("streams", []):
        if stream.get("duration"):
            return float(stream["duration"])

    return 0.0


def default_timestamps(duration: float) -> list[float]:
    if duration <= 0:
        return [0.0]

    if duration <= 20:
        step = max(2, duration / 5)
    elif duration <= 90:
        step = 8
    else:
        step = min(15, max(8, duration / 12))

    points = [0.5]
    current = step
    while current < duration - 1:
        points.append(current)
        current += step
    points.append(max(0.5, duration - 1))
    return sorted(set(round(point, 2) for point in points))


def parse_timestamps(values: str | None, duration: float) -> list[float]:
    if not values:
        return default_timestamps(duration)

    parsed: list[float] = []
    for value in values.split(","):
        value = value.strip()
        if not value:
            continue
        if ":" in value:
            parts = [float(part) for part in value.split(":")]
            if len(parts) == 2:
                parsed.append(parts[0] * 60 + parts[1])
            elif len(parts) == 3:
                parsed.append(parts[0] * 3600 + parts[1] * 60 + parts[2])
            else:
                raise SystemExit(f"Invalid timestamp: {value}")
        else:
            parsed.append(float(value))

    return sorted(set(max(0.0, min(duration, round(item, 2))) for item in parsed))


def extract_contact_sheet(video: Path, output: Path, duration: float) -> None:
    columns = 6
    rows = 8
    cells = columns * rows
    fps = max(0.1, min(1.0, cells / max(duration, 1.0)))
    run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(video),
            "-vf",
            f"fps={fps},scale=180:-1,tile={columns}x{rows}",
            "-frames:v",
            "1",
            str(output),
        ]
    )


def extract_frames(video: Path, frames_dir: Path, timestamps: list[float]) -> list[Path]:
    frames_dir.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    for timestamp in timestamps:
        label = f"{int(math.floor(timestamp)):04d}s"
        frame = frames_dir / f"frame-{label}.jpg"
        run(
            [
                "ffmpeg",
                "-y",
                "-ss",
                str(timestamp),
                "-i",
                str(video),
                "-frames:v",
                "1",
                "-q:v",
                "2",
                str(frame),
            ]
        )
        paths.append(frame)
    return paths


def extract_audio(video: Path, output: Path) -> bool:
    result = run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(video),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            str(output),
        ],
        check=False,
    )
    return result.returncode == 0 and output.exists() and output.stat().st_size > 0


def transcribe(audio: Path, output_dir: Path, model: str) -> Path | None:
    whisper = shutil.which("whisper")
    if whisper is None:
        return None

    result = run(
        [
            whisper,
            str(audio),
            "--model",
            model,
            "--language",
            "Portuguese",
            "--output_dir",
            str(output_dir),
            "--output_format",
            "txt",
        ],
        check=False,
    )
    if result.returncode != 0:
        return None

    generated = output_dir / f"{audio.stem}.txt"
    final = output_dir.parent / "transcript.txt"
    if generated.exists():
        generated.replace(final)
        return final
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--timestamps", help="Comma-separated seconds or MM:SS timestamps.")
    parser.add_argument("--whisper-model", default="tiny")
    parser.add_argument("--no-transcript", action="store_true")
    args = parser.parse_args()

    require_tool("ffmpeg")
    require_tool("ffprobe")

    video = args.video.expanduser().resolve()
    if not video.exists():
        raise SystemExit(f"Video not found: {video}")

    out_dir = args.out or Path("/tmp") / f"video-analysis-{safe_slug(video)}"
    out_dir = out_dir.resolve()
    frames_dir = out_dir / "frames"
    audio_dir = out_dir / "audio"
    out_dir.mkdir(parents=True, exist_ok=True)
    audio_dir.mkdir(parents=True, exist_ok=True)

    metadata = probe(video)
    duration = duration_seconds(metadata)
    timestamps = parse_timestamps(args.timestamps, duration)

    metadata_path = out_dir / "metadata.json"
    metadata_path.write_text(json.dumps(metadata, indent=2, ensure_ascii=False), encoding="utf-8")

    contact_sheet = out_dir / "contact-sheet.jpg"
    extract_contact_sheet(video, contact_sheet, duration)
    frames = extract_frames(video, frames_dir, timestamps)

    audio = audio_dir / "audio.wav"
    transcript = None
    if extract_audio(video, audio) and not args.no_transcript:
      transcript = transcribe(audio, audio_dir, args.whisper_model)

    summary = {
        "video": str(video),
        "output_dir": str(out_dir),
        "duration_seconds": duration,
        "contact_sheet": str(contact_sheet),
        "frames": [str(frame) for frame in frames],
        "audio": str(audio) if audio.exists() else None,
        "transcript": str(transcript) if transcript else None,
    }
    summary_path = out_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")

    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
