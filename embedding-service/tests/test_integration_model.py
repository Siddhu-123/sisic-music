import os
import time
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import create_app
from sisic_embed.core import GemmaEmbedder
from conftest import post_clip

MODEL_DIR = os.environ.get("SISIC_EMBED_MODEL_DIR", str(Path.home() / "dev/gemini embedding 2/models/embeddinggemma-2"))
pytestmark = pytest.mark.skipif(not Path(MODEL_DIR).is_dir(), reason="local EmbeddingGemma model directory is missing")


def test_service_vector_matches_shared_embedder(tmp_path, monkeypatch):
    monkeypatch.setenv("SISIC_EMBED_TOKEN", "test-only-token")
    embedder = GemmaEmbedder(MODEL_DIR, device="cpu", threads=2)
    app = create_app(str(tmp_path / "db.sqlite"), str(tmp_path / "spool"), embedder)
    clip = np.linspace(-.4, .4, 80000, dtype=np.float32)
    with TestClient(app) as client:
        response = post_clip(client, file_hash="d" * 64, audio=clip)
        assert response.status_code == 200
        deadline = time.time() + 180
        while time.time() < deadline:
            from sisic_embed.jobqueue import connect
            con = connect(str(tmp_path / "db.sqlite"))
            row = con.execute("SELECT vector FROM clips").fetchone()
            con.close()
            if row:
                actual = np.frombuffer(row[0], dtype=np.float32)
                break
            time.sleep(.1)
        else:
            raise AssertionError("embedding worker did not store the vector")
    expected = embedder.embed_clips([clip])[0]
    assert float(actual @ expected) > .9999
