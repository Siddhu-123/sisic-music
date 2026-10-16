"""FastAPI service for clip embeddings. Audio exists only in the temporary spool."""
from __future__ import annotations

import base64
import hmac
import math
import os
import tempfile
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
from fastapi import FastAPI, Header, HTTPException, Query

from sisic_embed import core, jobqueue, store


def _vector(vector: np.ndarray, dims: int) -> list[float]:
    if not 1 <= dims <= core.DIMENSIONS:
        raise HTTPException(422, "dims must be between 1 and 768")
    return [float(x) for x in core.truncate(np.asarray(vector).reshape(-1), dims)]


def create_app(db_path: str, spool_dir: str, embedder):
    token = os.environ.get("SISIC_EMBED_TOKEN")
    if not token and os.environ.get("SISIC_EMBED_ALLOW_NO_AUTH") != "1":
        raise RuntimeError("SISIC_EMBED_TOKEN must be set (or SISIC_EMBED_ALLOW_NO_AUTH=1 for tests)")
    stop = threading.Event()
    wake = threading.Event()
    worker_thread = None
    cache = {"stamp": None, "keys": [], "matrix": np.zeros((0, 256), np.float32)}

    def db():
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        return jobqueue.connect(db_path)

    def worker():
        while not stop.is_set():
            con = db()
            job = jobqueue.claim_next(con)
            con.close()
            if not job:
                wake.wait(1.0)
                wake.clear()
                continue
            path = job["pcm_path"]
            started = time.perf_counter()
            try:
                clip = np.fromfile(path, dtype="<f4")
                if len(clip) < core.SAMPLE_RATE * core.MIN_SECONDS:
                    raise ValueError("spooled clip is shorter than 5 seconds")
                vectors = embedder.embed_clips([clip])
                con = db()
                store.put_clips(con, job["file_hash"], [job["offset_s"]], vectors,
                                model=job["model"], source="vm")
                jobqueue.finish(con, job["id"], "done", duration_s=time.perf_counter() - started)
                con.close()
                cache["stamp"] = None
            except Exception as exc:
                con = db()
                jobqueue.finish(con, job["id"], "error", str(exc), time.perf_counter() - started)
                con.close()
            finally:
                jobqueue.discard_pcm(path)

    @asynccontextmanager
    async def lifespan(_app):
        nonlocal worker_thread
        Path(spool_dir).mkdir(parents=True, exist_ok=True)
        con = db()
        jobqueue.reset_stale(con)
        referenced = {r[0] for r in con.execute("SELECT pcm_path FROM jobs WHERE pcm_path IS NOT NULL")}
        con.close()
        for orphan in Path(spool_dir).glob("*.f32"):
            if str(orphan) not in referenced:
                jobqueue.discard_pcm(str(orphan))
        worker_thread = threading.Thread(target=worker, name="sisic-embed-worker", daemon=True)
        worker_thread.start()
        yield
        stop.set()
        wake.set()
        worker_thread.join(timeout=35)

    api = FastAPI(title="Sisic EmbeddingGemma service", lifespan=lifespan)
    api.state.embedder = embedder

    @api.middleware("http")
    async def auth(request, call_next):
        if request.method == "GET" and request.url.path == "/health":
            return await call_next(request)
        if token is None and os.environ.get("SISIC_EMBED_ALLOW_NO_AUTH") == "1":
            return await call_next(request)
        if token and hmac.compare_digest(request.headers.get("authorization") or "", f"Bearer {token}"):
            return await call_next(request)
        return __import__("starlette.responses", fromlist=["JSONResponse"]).JSONResponse(
            {"detail": "Unauthorized"}, status_code=401, headers={"WWW-Authenticate": "Bearer"})

    @api.post("/clips")
    def clips(payload: dict):
        try:
            sample_rate = payload.get("sampleRate")
            if sample_rate != core.SAMPLE_RATE:
                raise ValueError("sampleRate must be 16000")
            if "pcm" in payload:
                raw = base64.b64decode(payload["pcm"], validate=True)
                if len(raw) % 4:
                    raise ValueError("pcm must contain float32 samples")
                audio = np.frombuffer(raw, dtype="<f4").copy()
            elif "pcm16" in payload:
                raw = base64.b64decode(payload["pcm16"], validate=True)
                if len(raw) % 2:
                    raise ValueError("pcm16 must contain int16 samples")
                audio = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
            else:
                raise ValueError("pcm or pcm16 is required")
            if not np.all(np.isfinite(audio)):
                raise ValueError("PCM samples must be finite")
            seconds = len(audio) / sample_rate
            if not 5 <= seconds <= 30.5:
                raise ValueError("clip length must be between 5 and 30.5 seconds")
            file_hash, song_key = str(payload["fileHash"]), str(payload["songKey"])
            offset = core.round_offset(float(payload["offsetSeconds"]))
            if not file_hash or file_hash == "None" or not song_key or song_key == "None" or not math.isfinite(offset) or offset < 0:
                raise ValueError("fileHash, songKey, and nonnegative offsetSeconds are required")
            priorities = {"new": 0, "backlog": 1, "rest": 2}
            priority = priorities[payload.get("priority", "new")]
            if payload.get("duration") is not None and (not math.isfinite(float(payload["duration"])) or float(payload["duration"]) < 0):
                raise ValueError("duration must be a nonnegative number")
        except (ValueError, KeyError, TypeError) as exc:
            raise HTTPException(422, str(exc)) from exc
        audio = np.ascontiguousarray(audio, dtype="<f4")
        fd, pcm_path = tempfile.mkstemp(prefix="clip-", suffix=".f32", dir=spool_dir)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(audio.tobytes())
            con = db()
            fields = {k: payload.get(k) for k in ("title", "artist", "duration") if payload.get(k) is not None}
            store.upsert_song(con, file_hash, song_key=song_key, **fields)
            job_id, state = jobqueue.enqueue(con, file_hash, song_key, offset, core.MODEL_ID,
                                              priority, pcm_path)
            con.close()
            if state != "queued":
                jobqueue.discard_pcm(pcm_path)
            else:
                wake.set()
            return {"jobId": job_id, "state": state}
        except Exception:
            jobqueue.discard_pcm(pcm_path)
            raise

    @api.get("/jobs")
    def jobs():
        con = db()
        states = {s: n for s, n in con.execute("SELECT state,count(*) FROM jobs GROUP BY state")}
        priorities = {p: n for p, n in con.execute("SELECT priority,count(*) FROM jobs GROUP BY priority")}
        errors = [{"id": r[0], "fileHash": r[1], "error": r[2], "updatedAt": r[3]}
                  for r in con.execute("SELECT id,file_hash,error,updated_at FROM jobs WHERE state='error' "
                                       "ORDER BY updated_at DESC LIMIT 10")]
        times = [r[0] for r in con.execute(
            "SELECT duration_s FROM jobs WHERE state='done' AND duration_s IS NOT NULL "
            "ORDER BY updated_at DESC LIMIT 50")]
        queued = states.get("queued", 0)
        con.close()
        avg = sum(times) / len(times) if times else None
        return {"states": states, "priorities": priorities, "recentErrors": errors,
                "secondsPerClip": avg, "etaSeconds": queued * avg if avg is not None else None}

    @api.get("/vectors")
    def vectors(since: float = 0, dims: int = 256):
        if not 1 <= dims <= core.DIMENSIONS:
            raise HTTPException(422, "dims must be between 1 and 768")
        con = db()
        touched = con.execute("SELECT DISTINCT file_hash FROM clips WHERE model=? AND created_at>?",
                              (core.MODEL_ID, since)).fetchall()
        out, cursor = [], since
        for (fh,) in touched:
            offsets, clipm = store.clip_vectors(con, fh, core.MODEL_ID)
            rows = con.execute("SELECT offset_s,created_at FROM clips WHERE file_hash=? AND model=? AND created_at>? "
                               "ORDER BY offset_s", (fh, core.MODEL_ID, since)).fetchall()
            cursor = max([cursor, *(r[1] for r in rows)])
            meta = con.execute("SELECT song_key FROM songs WHERE file_hash=?", (fh,)).fetchone()
            out.append({"fileHash": fh, "songKey": meta[0] if meta else None, "model": core.MODEL_ID,
                        "clipOffsets": [r[0] for r in rows], "vector": _vector(core.song_vector(clipm, dims), dims),
                        "startVector": _vector(clipm[0], dims) if len(clipm) else None,
                        "endVector": _vector(clipm[-1], dims) if len(clipm) else None})
        con.close()
        return {"songs": out, "cursor": cursor}

    @api.post("/query")
    def query(payload: dict):
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip():
            raise HTTPException(422, "text is required")
        try:
            dims = int(payload.get("dims", 256))
        except (ValueError, TypeError) as exc:
            raise HTTPException(422, "invalid dims") from exc
        return {"model": core.MODEL_ID, "vector": _vector(embedder.embed_text(text), dims)}

    @api.get("/neighbors")
    def neighbors(songKey: str | None = None, fileHash: str | None = None,
                  k: int = Query(10, ge=1, le=1000), dims: int = 256):
        if not 1 <= dims <= core.DIMENSIONS:
            raise HTTPException(422, "dims must be between 1 and 768")
        con = db()
        stamp = con.execute("SELECT COUNT(*),MAX(created_at) FROM clips WHERE model=?", (core.MODEL_ID,)).fetchone()
        if cache["stamp"] != stamp or cache.get("dims") != dims:
            keys, matrix, counts = store.all_song_vectors(con, core.MODEL_ID, dims)
            cache.update(stamp=stamp, dims=dims, keys=keys, matrix=matrix, counts=counts)
        con.close()
        keys, matrix, counts = cache["keys"], cache["matrix"], cache["counts"]
        target = None
        if fileHash:
            if fileHash not in keys:
                raise HTTPException(404, "song vector not found")
            target = fileHash
        elif songKey:
            con = db()
            row = con.execute("SELECT file_hash FROM songs WHERE song_key=? ORDER BY file_hash LIMIT 1", (songKey,)).fetchone()
            con.close()
            if row and row[0] in keys:
                target = row[0]
        if not target:
            raise HTTPException(404, "song vector not found")
        idx = keys.index(target)
        sims = matrix @ matrix[idx]
        order = np.argsort(-sims)
        return {"neighbors": [{"fileHash": keys[i], "similarity": float(sims[i]), "clipCount": counts[i]}
                              for i in order if i != idx][:k]}

    @api.get("/health")
    def health():
        con = db()
        queued = con.execute("SELECT count(*) FROM jobs WHERE state='queued'").fetchone()[0]
        con.close()
        return {"ok": True, "model": core.MODEL_ID, "queued": queued}

    return api


_MODEL_DIR = os.environ.get("SISIC_EMBED_MODEL_DIR", str(Path.home() / "dev/gemini embedding 2/models/embeddinggemma-2"))
app = create_app(os.environ.get("SISIC_EMBED_DB", "embedding-service/clips.sqlite"),
                 os.environ.get("SISIC_EMBED_SPOOL", "/var/lib/sisic-embed/spool"),
                 core.GemmaEmbedder(_MODEL_DIR, device="cpu"))
