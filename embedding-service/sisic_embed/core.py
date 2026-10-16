"""Shared EmbeddingGemma 2 clip pipeline used by the VM service and the Mac backfill.

Both sides must produce interchangeable vectors, so the model id, clip layout,
decode settings and normalisation live here and nowhere else.
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import unicodedata
from typing import Iterable, Sequence

import numpy as np

MODEL_ID = "embeddinggemma-2@fp32/clip30/v1"
DIMENSIONS = 768
SAMPLE_RATE = 16000
CLIP_SECONDS = 30.0
CLIP_SAMPLES = int(SAMPLE_RATE * CLIP_SECONDS)
FIRST_PASS_FRACTIONS = (0.2, 0.5, 0.8)
MIN_SECONDS = 5.0


def ffmpeg_bin() -> str:
    return os.environ.get("SISIC_FFMPEG") or shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"


def decode_audio(path: str, start: float | None = None, duration: float | None = None) -> np.ndarray:
    """Decode any ffmpeg-readable file to 16 kHz mono float32."""
    cmd = [ffmpeg_bin(), "-v", "quiet", "-nostdin"]
    if start is not None:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-i", path]
    if duration is not None:
        cmd += ["-t", f"{duration:.3f}"]
    cmd += ["-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=False).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def round_offset(seconds: float) -> float:
    return round(float(seconds), 2)


def first_pass_offsets(duration: float) -> list[float]:
    """Start offsets for the 3 priority clips centred at 20/50/80% of the song."""
    if duration <= CLIP_SECONDS:
        return [0.0]
    last = duration - CLIP_SECONDS
    out = []
    for f in FIRST_PASS_FRACTIONS:
        out.append(round_offset(min(max(f * duration - CLIP_SECONDS / 2, 0.0), last)))
    return sorted(set(out))


def full_offsets(duration: float) -> list[float]:
    """Back-to-back 30 s tiling; the last clip is aligned to the song end so the outro is covered."""
    if duration <= CLIP_SECONDS:
        return [0.0]
    n = int(duration // CLIP_SECONDS)
    out = [round_offset(k * CLIP_SECONDS) for k in range(n)]
    tail = round_offset(duration - CLIP_SECONDS)
    if tail - out[-1] > 1.0:
        out.append(tail)
    return out


def remaining_offsets(duration: float, done: Iterable[float]) -> list[float]:
    have = {round_offset(x) for x in done}
    return [o for o in full_offsets(duration) if o not in have]


def slice_clip(audio: np.ndarray, offset: float) -> np.ndarray:
    start = int(round(offset * SAMPLE_RATE))
    clip = audio[start:start + CLIP_SAMPLES]
    return np.ascontiguousarray(clip, dtype=np.float32)


def l2_normalize(v: np.ndarray, axis: int = -1) -> np.ndarray:
    v = np.asarray(v, dtype=np.float64)
    n = np.linalg.norm(v, axis=axis, keepdims=True)
    n[n == 0] = 1.0
    return (v / n).astype(np.float32)


def song_vector(clip_vectors: Sequence[np.ndarray] | np.ndarray, dims: int = DIMENSIONS) -> np.ndarray:
    """Average of L2-normalised clip vectors, Matryoshka-truncated to dims, renormalised."""
    m = np.asarray(clip_vectors, dtype=np.float32)
    if m.ndim == 1:
        m = m[None, :]
    m = l2_normalize(m[:, :dims])
    return l2_normalize(m.mean(axis=0))


def truncate(v: np.ndarray, dims: int) -> np.ndarray:
    return l2_normalize(np.asarray(v, dtype=np.float32)[..., :dims])


def file_sha256(path: str, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while b := f.read(chunk):
            h.update(b)
    return h.hexdigest()


def pcm_sha256(audio: np.ndarray) -> str:
    return hashlib.sha256(np.ascontiguousarray(audio, dtype=np.float32).tobytes()).hexdigest()


_SPACE = re.compile(r"\s+")
_NON_WORD = re.compile(r"[^\w]+", re.UNICODE)


def normalize_text(value: str | None) -> str:
    """Python port of web-app/src/songIdentity.js normalizeText."""
    s = unicodedata.normalize("NFKD", str(value or ""))
    s = "".join(ch for ch in s if not 0x300 <= ord(ch) <= 0x36F).lower().replace("&", " and ")
    s = _NON_WORD.sub(" ", s).replace("_", " ")
    return _SPACE.sub(" ", s).strip()


def song_key(artist: str | None, track: str | None) -> str:
    """Python port of getSongKey({artist, track})."""
    return f"{normalize_text(artist) or 'unknown artist'}::{normalize_text(track) or 'unknown track'}"


class GemmaEmbedder:
    """Loads EmbeddingGemma 2 once (fp32, CPU, no vision tower)."""

    def __init__(self, model_dir: str, device: str = "cpu", threads: int | None = None):
        self.model_dir = model_dir
        self.device = device
        self.threads = threads
        self._model = None

    @property
    def model(self):
        if self._model is None:
            import torch
            from sentence_transformers import SentenceTransformer

            if self.threads:
                torch.set_num_threads(int(self.threads))
            self._model = SentenceTransformer(
                self.model_dir,
                config_kwargs={"vision_config": None},
                model_kwargs={"torch_dtype": torch.float32},
                device=self.device,
            )
        return self._model

    def embed_clips(self, clips: Sequence[np.ndarray], batch_size: int = 4) -> np.ndarray:
        if not clips:
            return np.zeros((0, DIMENSIONS), dtype=np.float32)
        inputs = [{"text": "<|audio|>", "audio": [np.asarray(c, dtype=np.float32)]} for c in clips]
        with np.errstate(all="ignore"):
            out = self.model.encode(inputs, normalize_embeddings=True, batch_size=batch_size)
        return l2_normalize(np.asarray(out, dtype=np.float32))

    def embed_text(self, text: str) -> np.ndarray:
        with np.errstate(all="ignore"):
            out = self.model.encode(text, prompt_name="SearchQuery", normalize_embeddings=True)
        return l2_normalize(np.asarray(out, dtype=np.float32))
