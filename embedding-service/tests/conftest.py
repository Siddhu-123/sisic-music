import hashlib
import os
import sys
import time
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("SISIC_EMBED_TOKEN", "test-only-token")


class StubEmbedder:
    def _embed(self, value):
        raw = value if isinstance(value, bytes) else np.ascontiguousarray(value, dtype=np.float32).tobytes()
        seed = int.from_bytes(hashlib.sha256(raw).digest()[:8], "little")
        rng = np.random.default_rng(seed)
        vector = rng.standard_normal(768).astype(np.float32)
        return vector / np.linalg.norm(vector)

    def embed_clips(self, clips, batch_size=4):
        return np.stack([self._embed(c) for c in clips]) if clips else np.zeros((0, 768), np.float32)

    def embed_text(self, text):
        return self._embed(text.encode())


@pytest.fixture
def service(tmp_path, monkeypatch):
    monkeypatch.setenv("SISIC_EMBED_TOKEN", "test-only-token")
    from app import create_app
    from fastapi.testclient import TestClient
    app = create_app(str(tmp_path / "clips.sqlite"), str(tmp_path / "spool"), StubEmbedder())
    with TestClient(app) as client:
        yield client, tmp_path


def post_clip(client, file_hash="a" * 64, offset=0, priority="new", audio=None, **more):
    audio = audio if audio is not None else np.linspace(-0.8, 0.8, 80000, dtype=np.float32)
    import base64
    import json
    payload = {"songKey": "artist::title", "fileHash": file_hash, "offsetSeconds": offset,
               "priority": priority, "sampleRate": 16000,
               "pcm": base64.b64encode(np.asarray(audio, dtype="<f4").tobytes()).decode(), **more}
    return client.post("/clips", headers={"Authorization": "Bearer test-only-token"}, json=payload)


