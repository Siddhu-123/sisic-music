"""FastAPI service for clip embeddings. Audio exists only in the temporary spool."""
from __future__ import annotations

import base64
from collections import deque
import hashlib
import hmac
import json
import math
import os
import secrets
import tempfile
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
from fastapi import FastAPI, Header, HTTPException, Query, Request
from starlette.responses import JSONResponse

from sisic_embed import core, jobqueue, store

MAX_Samples_PER_CLIP = int(math.ceil(core.SAMPLE_RATE * 30.5))
MAX_PCM_B64_CHARS = ((MAX_Samples_PER_CLIP * 4 + 2) // 3) * 4 + 64
MAX_PCM16_B64_CHARS = ((MAX_Samples_PER_CLIP * 2 + 2) // 3) * 4 + 64
MAX_HASH_CHARS = 256
MAX_METADATA_CHARS = 512
MAX_SESSION_TTL_SECONDS = 3600
READ_ONLY_PATHS = {"/vectors", "/neighbors", "/jobs", "/query"}


def _vector(vector: np.ndarray, dims: int) -> list[float]:
    if not 1 <= dims <= core.DIMENSIONS:
        raise HTTPException(422, "dims must be between 1 and 768")
    return [float(x) for x in core.truncate(np.asarray(vector).reshape(-1), dims)]


def _spool_bytes_used(spool_dir: str) -> int:
    total = 0
    try:
        for entry in Path(spool_dir).glob("*.f32"):
            try:
                total += entry.stat().st_size
            except OSError:
                pass
    except OSError:
        pass
    return total


def create_app(db_path: str, spool_dir: str, embedder):
    token = os.environ.get("SISIC_EMBED_TOKEN")
    extra_tokens = [t.strip() for t in (os.environ.get("SISIC_EMBED_TOKENS") or "").split(",") if t.strip()]
    read_token = (os.environ.get("SISIC_EMBED_READ_TOKEN") or "").strip() or None
    admin_tokens = [t for t in ([token] if token else []) + extra_tokens if t]
    if not admin_tokens and os.environ.get("SISIC_EMBED_ALLOW_NO_AUTH") != "1":
        raise RuntimeError("SISIC_EMBED_TOKEN must be set (or SISIC_EMBED_ALLOW_NO_AUTH=1 for tests)")

    signing_key = (admin_tokens[0] if admin_tokens else "no-auth-test-key").encode("utf-8")
    revoked_tokens: set[str] = set()
    rate_lock = threading.Lock()
    client_hits: dict[str, deque[float]] = {}
    client_inflight: dict[str, int] = {}

    stop = threading.Event()
    wake = threading.Event()
    worker_thread = None
    cache = {"stamp": None, "keys": [], "matrix": np.zeros((0, 256), np.float32)}

    def _issue_session_token(scope: str = "read", ttl_seconds: int = 900) -> dict:
        if scope not in ("read", "write", "admin"):
            raise HTTPException(422, "scope must be read, write, or admin")
        ttl = max(1, min(int(ttl_seconds), MAX_SESSION_TTL_SECONDS))
        exp = int(time.time()) + ttl
        body = json.dumps(
            {"jti": secrets.token_urlsafe(12), "scope": scope, "exp": exp},
            separators=(",", ":"),
        ).encode("utf-8")
        body_b64 = base64.urlsafe_b64encode(body).decode("ascii").rstrip("=")
        sig = hmac.new(signing_key, body_b64.encode("ascii"), hashlib.sha256).hexdigest()
        return {"token": f"ses.{body_b64}.{sig}", "scope": scope, "expiresAt": exp, "ttlSeconds": ttl}

    def _verify_bearer(raw_token: str) -> str | None:
        if not raw_token or raw_token in revoked_tokens:
            return None
        for candidate in admin_tokens:
            if hmac.compare_digest(raw_token, candidate):
                return "admin"
        if read_token and hmac.compare_digest(raw_token, read_token):
            return "read"
        if raw_token.startswith("ses."):
            parts = raw_token.split(".")
            if len(parts) != 3:
                return None
            _, body_b64, sig = parts
            expected = hmac.new(signing_key, body_b64.encode("ascii"), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(sig, expected):
                return None
            try:
                padded = body_b64 + "=" * (-len(body_b64) % 4)
                claims = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
            except Exception:
                return None
            if not isinstance(claims, dict) or claims.get("exp", 0) <= time.time():
                return None
            if claims.get("jti") in revoked_tokens:
                return None
            scope = claims.get("scope")
            if scope in ("read", "write", "admin"):
                return scope
        return None

    def db():
        parent = Path(db_path).parent
        parent.mkdir(parents=True, exist_ok=True, mode=0o700)
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
        spool_path = Path(spool_dir)
        spool_path.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            os.chmod(spool_path, 0o700)
        except OSError:
            pass
        con = db()
        jobqueue.reset_stale(con)
        referenced = {r[0] for r in con.execute("SELECT pcm_path FROM jobs WHERE pcm_path IS NOT NULL")}
        con.close()
        for orphan in spool_path.glob("*.f32"):
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
    async def auth(request: Request, call_next):
        path = request.url.path
        if request.method == "GET" and path == "/health":
            return await call_next(request)

        scope = None
        raw_bearer = ""
        auth_header = request.headers.get("authorization") or ""
        if auth_header.startswith("Bearer "):
            raw_bearer = auth_header[7:].strip()

        if not admin_tokens and os.environ.get("SISIC_EMBED_ALLOW_NO_AUTH") == "1":
            scope = "admin"
        elif raw_bearer:
            scope = _verify_bearer(raw_bearer)

        if not scope:
            return JSONResponse(
                {"detail": "Unauthorized"}, status_code=401, headers={"WWW-Authenticate": "Bearer"})

        if scope == "read" and path not in READ_ONLY_PATHS and path != "/auth/revoke":
            return JSONResponse({"detail": "Insufficient token scope"}, status_code=403)
        if path == "/auth/session" and scope != "admin":
            return JSONResponse({"detail": "Insufficient token scope"}, status_code=403)
        request.state.bearer_token = raw_bearer
        request.state.auth_scope = scope

        client_key = (request.client.host if request.client else "local") or "local"
        rate_limit = int(os.environ.get("SISIC_EMBED_RATE_LIMIT_PER_MINUTE", "300"))
        max_concurrent = int(os.environ.get("SISIC_EMBED_MAX_CONCURRENT_REQUESTS", "16"))
        now = time.monotonic()
        with rate_lock:
            inflight = client_inflight.get(client_key, 0)
            if max_concurrent > 0 and inflight >= max_concurrent:
                return JSONResponse(
                    {"detail": "Too many concurrent requests"},
                    status_code=429,
                    headers={"Retry-After": "1"},
                )
            hits = client_hits.setdefault(client_key, deque())
            while hits and now - hits[0] >= 60.0:
                hits.popleft()
            if rate_limit > 0 and len(hits) >= rate_limit:
                return JSONResponse(
                    {"detail": "Rate limit exceeded"},
                    status_code=429,
                    headers={"Retry-After": "1"},
                )
            hits.append(now)
            client_inflight[client_key] = inflight + 1

        try:
            if request.method in ("POST", "PUT", "PATCH"):
                max_body = (
                    int(os.environ.get("SISIC_EMBED_MAX_BODY_BYTES", "3200000"))
                    if path == "/clips"
                    else int(os.environ.get("SISIC_EMBED_MAX_QUERY_BODY_BYTES", "16384"))
                )
                content_length = request.headers.get("content-length")
                if content_length is not None:
                    try:
                        if int(content_length) > max_body:
                            return JSONResponse({"detail": "Request body too large"}, status_code=413)
                    except ValueError:
                        return JSONResponse({"detail": "Invalid Content-Length"}, status_code=400)
                buf = bytearray()
                async for chunk in request.stream():
                    buf.extend(chunk)
                    if len(buf) > max_body:
                        return JSONResponse({"detail": "Request body too large"}, status_code=413)
                request._body = bytes(buf)
            return await call_next(request)
        finally:
            with rate_lock:
                remaining = client_inflight.get(client_key, 1) - 1
                if remaining <= 0:
                    client_inflight.pop(client_key, None)
                else:
                    client_inflight[client_key] = remaining

    @api.post("/auth/session")
    def create_session(payload: dict | None = None):
        body = payload or {}
        scope = str(body.get("scope", "read"))
        try:
            ttl = int(body.get("ttlSeconds", 900))
        except (TypeError, ValueError) as exc:
            raise HTTPException(422, "invalid ttlSeconds") from exc
        return _issue_session_token(scope=scope, ttl_seconds=ttl)

    @api.post("/auth/revoke")
    def revoke_session(request: Request, payload: dict | None = None):
        body = payload or {}
        target = str(body.get("token") or getattr(request.state, "bearer_token", "") or "").strip()
        if not target:
            raise HTTPException(422, "token is required")
        revoked_tokens.add(target)
        return {"revoked": True}

    @api.post("/clips")
    def clips(payload: dict):
        try:
            sample_rate = payload.get("sampleRate")
            if sample_rate != core.SAMPLE_RATE:
                raise ValueError("sampleRate must be 16000")
            if "pcm" in payload:
                pcm_b64 = payload["pcm"]
                if not isinstance(pcm_b64, str) or len(pcm_b64) > MAX_PCM_B64_CHARS:
                    raise ValueError("pcm exceeds maximum encoded length")
                raw = base64.b64decode(pcm_b64, validate=True)
                if len(raw) % 4:
                    raise ValueError("pcm must contain float32 samples")
                audio = np.frombuffer(raw, dtype="<f4").copy()
            elif "pcm16" in payload:
                pcm16_b64 = payload["pcm16"]
                if not isinstance(pcm16_b64, str) or len(pcm16_b64) > MAX_PCM16_B64_CHARS:
                    raise ValueError("pcm16 exceeds maximum encoded length")
                raw = base64.b64decode(pcm16_b64, validate=True)
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
            if (not file_hash or file_hash == "None" or len(file_hash) > MAX_HASH_CHARS
                    or not song_key or song_key == "None" or len(song_key) > MAX_METADATA_CHARS
                    or not math.isfinite(offset) or offset < 0):
                raise ValueError("fileHash, songKey, and nonnegative offsetSeconds are required")
            for meta_key in ("title", "artist"):
                if payload.get(meta_key) is not None and len(str(payload.get(meta_key))) > MAX_METADATA_CHARS:
                    raise ValueError(f"{meta_key} exceeds maximum length")
            priorities = {"new": 0, "backlog": 1, "rest": 2}
            priority = priorities[payload.get("priority", "new")]
            if payload.get("duration") is not None and (not math.isfinite(float(payload["duration"])) or float(payload["duration"]) < 0):
                raise ValueError("duration must be a nonnegative number")
        except (ValueError, KeyError, TypeError) as exc:
            raise HTTPException(422, str(exc)) from exc
        audio = np.ascontiguousarray(audio, dtype="<f4")
        max_spool_bytes = int(os.environ.get("SISIC_EMBED_MAX_SPOOL_BYTES", str(512 * 1024 * 1024)))
        max_queued_jobs = int(os.environ.get("SISIC_EMBED_MAX_QUEUED_JOBS", "256"))
        if max_spool_bytes > 0 and _spool_bytes_used(spool_dir) + audio.nbytes > max_spool_bytes:
            raise HTTPException(429, "spool capacity exceeded")
        Path(spool_dir).mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, pcm_path = tempfile.mkstemp(prefix="clip-", suffix=".f32", dir=spool_dir)
        try:
            os.chmod(pcm_path, 0o600)
            with os.fdopen(fd, "wb") as f:
                f.write(audio.tobytes())
            con = db()
            fields = {k: payload.get(k) for k in ("title", "artist", "duration") if payload.get(k) is not None}
            store.upsert_song(con, file_hash, song_key=song_key, **fields)
            try:
                job_id, state = jobqueue.enqueue(
                    con, file_hash, song_key, offset, core.MODEL_ID,
                    priority, pcm_path, max_queued=max_queued_jobs,
                )
            finally:
                con.close()
            if state != "queued":
                jobqueue.discard_pcm(pcm_path)
            else:
                wake.set()
            return {"jobId": job_id, "state": state}
        except jobqueue.QueueFullError as exc:
            jobqueue.discard_pcm(pcm_path)
            raise HTTPException(429, str(exc)) from exc
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
        max_query_chars = int(os.environ.get("SISIC_EMBED_MAX_QUERY_CHARS", "1000"))
        if not isinstance(text, str) or not text.strip():
            raise HTTPException(422, "text is required")
        if len(text) > max_query_chars:
            raise HTTPException(422, f"text must be at most {max_query_chars} characters")
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
