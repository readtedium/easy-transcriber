"""
Moonshine transcription sidecar — wraps moonshine-voice and exposes a
Deepgram-shaped JSON response so the main server needs no special-casing.
"""

import io
import time
import asyncio
import tempfile
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse

from moonshine_voice import Transcriber, get_model_for_language, TranscriptEventListener, LineCompleted

SAMPLE_RATE = 16000

# Load model once at startup
print("Loading Moonshine model …", flush=True)
_model_path, _model_arch = get_model_for_language("en")
print(f"Moonshine model ready: {_model_path}", flush=True)

app = FastAPI(title="Moonshine Transcription Sidecar")

_progress = {"current": 0, "total": 0, "active": False}


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/progress")
def progress():
    return _progress


def load_audio(data: bytes) -> np.ndarray:
    """Decode audio bytes → 16kHz mono float32. Uses soundfile, falls back to ffmpeg."""
    try:
        with io.BytesIO(data) as buf:
            audio, sr = sf.read(buf, dtype="float32", always_2d=False)
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        if sr != SAMPLE_RATE:
            audio = _resample(audio, sr, SAMPLE_RATE)
        return audio
    except Exception:
        pass

    # ffmpeg fallback (MP3, MP4, webm, etc.)
    with tempfile.NamedTemporaryFile(delete=False, suffix=".tmp") as f:
        f.write(data)
        tmp_in = f.name
    try:
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", tmp_in, "-ar", str(SAMPLE_RATE), "-ac", "1", "-f", "f32le", "pipe:1"],
            capture_output=True,
            check=True,
        )
        return np.frombuffer(result.stdout, dtype=np.float32)
    finally:
        Path(tmp_in).unlink(missing_ok=True)


def _resample(audio: np.ndarray, orig_sr: int, target_sr: int) -> np.ndarray:
    duration = len(audio) / orig_sr
    target_len = int(duration * target_sr)
    return np.interp(
        np.linspace(0, len(audio) - 1, target_len),
        np.arange(len(audio)),
        audio,
    ).astype(np.float32)


def _transcribe_single(audio: np.ndarray, offset_sec: float = 0.0) -> list[dict]:
    """Transcribe a single audio array; timestamps are offset by offset_sec."""
    transcriber = Transcriber(model_path=_model_path, model_arch=_model_arch)
    result = transcriber.transcribe_without_streaming(audio.tolist(), sample_rate=SAMPLE_RATE)
    transcriber.close()

    raw_lines = result.lines or []
    if not raw_lines:
        return []

    out = []
    for line in raw_lines:
        text = getattr(line, "text", None) or ""
        if not text:
            # try assembling from words
            words_attr = getattr(line, "words", None) or []
            text = " ".join(getattr(w, "text", "") for w in words_attr).strip()
        if not text:
            continue
        lstart = offset_sec + getattr(line, "start_time", 0)
        ldur = getattr(line, "duration", 0)
        words = []
        for w in (getattr(line, "words", None) or []):
            wstart = offset_sec + getattr(w, "start_time", getattr(w, "start", 0))
            wdur = getattr(w, "duration", 0)
            words.append({
                "word": getattr(w, "text", "").strip(),
                "start": round(wstart, 3),
                "end": round(wstart + wdur, 3),
                "confidence": 0.9,
            })
        out.append({
            "text": text.strip(),
            "start": round(lstart, 3),
            "end": round(lstart + ldur, 3),
            "speaker": int(getattr(line, "speaker_index", 0) or 0),
            "words": words,
        })
    return out


def transcribe_audio(audio: np.ndarray) -> list[dict]:
    """Full-file transcription split into 30s chunks (used by /transcribe for URL path)."""
    chunk_samples = 30 * SAMPLE_RATE
    total_chunks = max(1, (len(audio) + chunk_samples - 1) // chunk_samples)
    duration_min = len(audio) / SAMPLE_RATE / 60
    print(f"Transcribing {duration_min:.1f} min of audio in {total_chunks} chunk(s)…", flush=True)
    _progress.update({"current": 0, "total": total_chunks, "active": True})

    all_lines = []
    for i, offset in enumerate(range(0, len(audio), chunk_samples)):
        _progress["current"] = i + 1
        chunk_start = offset / SAMPLE_RATE
        print(f"  Chunk {i + 1}/{total_chunks} (t={chunk_start:.0f}s)…", flush=True)
        all_lines.extend(_transcribe_single(audio[offset: offset + chunk_samples], chunk_start))

    _progress.update({"current": total_chunks, "total": total_chunks, "active": False})
    print(f"Transcription complete — {len(all_lines)} line(s).", flush=True)
    return all_lines


def build_deepgram_response(lines: list[dict], duration: float) -> dict:
    """Wrap transcribed lines in a Deepgram Nova-shaped response envelope."""
    all_words = []
    utterances = []
    full_parts = []

    for i, line in enumerate(lines):
        full_parts.append(line["text"])
        speaker = line["speaker"]
        dg_words = [
            {
                "word": w["word"].lower().strip(".,!?;:\"'"),
                "start": w["start"],
                "end": w["end"],
                "confidence": w["confidence"],
                "punctuated_word": w["word"],
                "speaker": speaker,
                "speaker_confidence": 0.9,
            }
            for w in line["words"]
        ]
        all_words.extend(dg_words)
        utterances.append({
            "start": line["start"],
            "end": line["end"],
            "confidence": 0.9,
            "channel": 0,
            "transcript": line["text"],
            "words": dg_words,
            "speaker": speaker,
            "id": str(i),
        })

    full_transcript = " ".join(full_parts)
    return {
        "metadata": {
            "transaction_key": "moonshine",
            "request_id": f"moonshine-{int(time.time() * 1000)}",
            "sha256": "",
            "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "duration": duration,
            "channels": 1,
            "models": ["moonshine/base"],
        },
        "results": {
            "channels": [{
                "alternatives": [{
                    "transcript": full_transcript,
                    "confidence": 0.9,
                    "words": all_words,
                    "paragraphs": {
                        "transcript": full_transcript,
                        "paragraphs": [
                            {
                                "sentences": [{"text": line["text"], "start": line["start"], "end": line["end"]}],
                                "num_words": len(line["text"].split()),
                                "start": line["start"],
                                "end": line["end"],
                                "speaker": line["speaker"],
                            }
                            for line in lines
                        ],
                    },
                }]
            }],
            "utterances": utterances,
        },
    }


@app.post("/transcribe-chunk")
async def transcribe_chunk(file: UploadFile = File(...), offset_sec: float = Form(0.0)):
    """Transcribe a single pre-split audio segment; returns raw lines (no Deepgram envelope)."""
    data = await file.read()
    try:
        audio = await asyncio.get_event_loop().run_in_executor(None, load_audio, data)
    except Exception as e:
        return JSONResponse({"error": f"Audio decode failed: {e}"}, status_code=422)
    try:
        lines = await asyncio.get_event_loop().run_in_executor(
            None, _transcribe_single, audio, float(offset_sec)
        )
    except Exception as e:
        return JSONResponse({"error": f"Transcription failed: {e}"}, status_code=500)
    return {"lines": lines}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    """Full-file transcription — used by URL path in main server."""
    data = await file.read()
    try:
        audio = await asyncio.get_event_loop().run_in_executor(None, load_audio, data)
    except Exception as e:
        return JSONResponse({"error": f"Audio decode failed: {e}"}, status_code=422)

    duration = len(audio) / SAMPLE_RATE
    try:
        lines = await asyncio.get_event_loop().run_in_executor(None, transcribe_audio, audio)
    except Exception as e:
        return JSONResponse({"error": f"Transcription failed: {e}"}, status_code=500)

    return build_deepgram_response(lines, duration)
