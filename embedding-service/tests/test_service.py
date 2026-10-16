import base64
import time

import numpy as np
from fastapi.testclient import TestClient

from conftest import StubEmbedder, post_clip
from app import create_app


def test_auth_health_and_protected_routes(tmp_path):
    import os
    os.environ["SISIC_EMBED_TOKEN"] = "right"
    app = create_app(str(tmp_path / "db.sqlite"), str(tmp_path / "spool"), StubEmbedder())
    with TestClient(app) as c:
        assert c.get("/health").status_code == 200
        assert c.get("/jobs").status_code == 401
        assert c.get("/jobs", headers={"Authorization": "Bearer wrong"}).status_code == 401
        assert c.get("/jobs", headers={"Authorization": "Bearer right"}).status_code == 200


def test_enqueue_idempotency_priority_and_spool_cleanup(service):
    c, tmp = service
    headers = {"Authorization": "Bearer test-only-token"}
    first = post_clip(c, file_hash="a" * 64).json()
    duplicate = post_clip(c, file_hash="a" * 64).json()
    assert first["state"] == "queued"
    assert duplicate["jobId"] in (first["jobId"], None)
    assert duplicate["state"] in ("queued", "running", "done")
    assert len(list((tmp / "spool").glob("*.f32"))) <= 1
    second = post_clip(c, file_hash="b" * 64, priority="rest").json()
    third = post_clip(c, file_hash="c" * 64, priority="backlog").json()
    deadline = time.time() + 8
    while time.time() < deadline:
        con = __import__("sisic_embed.jobqueue", fromlist=["connect"]).connect(str(tmp / "clips.sqlite"))
        done = con.execute("SELECT count(*) FROM jobs WHERE state='done'").fetchone()[0]
        con.close()
        if done == 3:
            break
        time.sleep(.03)
    con = __import__("sisic_embed.jobqueue", fromlist=["connect"]).connect(str(tmp / "clips.sqlite"))
    assert con.execute("SELECT file_hash FROM jobs ORDER BY rowid").fetchall() == [("a"*64,), ("b"*64,), ("c"*64,)]
    assert con.execute("SELECT state FROM jobs WHERE id=?", (first["jobId"],)).fetchone()[0] == "done"
    con.close()
    assert not list((tmp / "spool").glob("*.f32"))


def test_vectors_since_cursor_and_neighbors_order(service):
    c, _ = service
    a = np.ones(80000, np.float32)
    for fh, audio in [("a"*64, a), ("b"*64, a), ("c"*64, -a)]:
        r = post_clip(c, file_hash=fh, audio=audio, title=fh[:1], artist="artist")
        assert r.status_code == 200
    deadline = time.time() + 8
    while time.time() < deadline and c.get("/jobs", headers={"Authorization": "Bearer test-only-token"}).json()["states"].get("done", 0) < 3:
        time.sleep(.03)
    headers = {"Authorization": "Bearer test-only-token"}
    result = c.get("/vectors?since=0&dims=128", headers=headers).json()
    assert len(result["songs"]) == 3 and result["cursor"] > 0
    assert c.get(f"/vectors?since={result['cursor']}&dims=128", headers=headers).json()["songs"] == []
    near = c.get(f"/neighbors?fileHash={'a'*64}&k=2&dims=128", headers=headers).json()["neighbors"]
    assert near[0]["fileHash"] == "b"*64


def test_query_shape_and_validation(service):
    c, _ = service
    headers = {"Authorization": "Bearer test-only-token"}
    query = c.post("/query", headers=headers, json={"text": "warm synth", "dims": 96})
    assert query.status_code == 200 and len(query.json()["vector"]) == 96
    assert abs(np.linalg.norm(query.json()["vector"]) - 1) < 1e-5
    assert c.post("/query", headers=headers, json={"text": ""}).status_code == 422
    assert c.post("/query", headers=headers, json={"text": "x", "dims": 900}).status_code == 422


def test_clip_input_validation(service):
    c, _ = service
    headers = {"Authorization": "Bearer test-only-token"}
    payload = {"songKey": "x", "fileHash": "f", "offsetSeconds": 0, "sampleRate": 44100,
               "pcm": base64.b64encode(np.zeros(80000, dtype="<f4").tobytes()).decode()}
    assert c.post("/clips", headers=headers, json=payload).status_code == 422
    payload["sampleRate"] = 16000
    payload["pcm"] = base64.b64encode(np.zeros(79999, dtype="<f4").tobytes()).decode()
    assert c.post("/clips", headers=headers, json=payload).status_code == 422
    payload["pcm"] = base64.b64encode(np.zeros(80000, dtype="<f4").tobytes()).decode()
    payload["priority"] = "bogus"
    assert c.post("/clips", headers=headers, json=payload).status_code == 422
