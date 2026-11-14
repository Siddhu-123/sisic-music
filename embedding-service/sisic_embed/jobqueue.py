"""Durable SQLite queue sharing the clip store database."""
from __future__ import annotations

import os
import sqlite3
import time
import uuid

from . import store

JOB_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
 id TEXT PRIMARY KEY, file_hash TEXT NOT NULL, song_key TEXT, offset_s REAL NOT NULL,
 model TEXT NOT NULL, priority INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','running','done','error')),
 attempts INTEGER NOT NULL DEFAULT 0, error TEXT, pcm_path TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL,
 duration_s REAL,
 UNIQUE(file_hash, offset_s, model)
);
CREATE INDEX IF NOT EXISTS jobs_order ON jobs(state, priority, created_at);
"""


def connect(path: str) -> sqlite3.Connection:
    con = store.connect(path)
    con.executescript(JOB_SCHEMA)
    cols = {r[1] for r in con.execute("PRAGMA table_info(jobs)")}
    if "duration_s" not in cols:
        con.execute("ALTER TABLE jobs ADD COLUMN duration_s REAL")
    return con


def reset_stale(con: sqlite3.Connection) -> int:
    cur = con.execute("UPDATE jobs SET state='queued', updated_at=? WHERE state='running'", (time.time(),))
    return cur.rowcount


class QueueFullError(RuntimeError):
    """Raised when the job queue has reached its configured capacity."""


def enqueue(con: sqlite3.Connection, file_hash: str, song_key: str, offset_s: float,
            model: str, priority: int, pcm_path: str,
            max_queued: int | None = None) -> tuple[str | None, str]:
    """Add a clip unless its vector or a matching queued job already exists."""
    con.execute("BEGIN IMMEDIATE")
    try:
        if con.execute("SELECT 1 FROM clips WHERE file_hash=? AND offset_s=? AND model=?",
                       (file_hash, offset_s, model)).fetchone():
            con.execute("COMMIT")
            return None, "done"
        row = con.execute("SELECT id, state FROM jobs WHERE file_hash=? AND offset_s=? AND model=?",
                          (file_hash, offset_s, model)).fetchone()
        if row and row[1] != "error":
            con.execute("COMMIT")
            return row[0], row[1]
        if max_queued is not None and max_queued > 0:
            active = con.execute("SELECT count(*) FROM jobs WHERE state IN ('queued','running')").fetchone()[0]
            if active >= int(max_queued):
                con.execute("ROLLBACK")
                raise QueueFullError(f"job queue is full (max {int(max_queued)} queued jobs)")
        if row and row[1] == "error":  # a resubmitted clip gets another try with the fresh PCM
            con.execute("UPDATE jobs SET state='queued',error=NULL,pcm_path=?,priority=MIN(priority,?),updated_at=? "
                        "WHERE id=?", (pcm_path, int(priority), time.time(), row[0]))
            con.execute("COMMIT")
            return row[0], "queued"
        job_id, now = uuid.uuid4().hex, time.time()
        con.execute("INSERT INTO jobs (id,file_hash,song_key,offset_s,model,priority,state,attempts,error,pcm_path,created_at,updated_at) "
                    "VALUES (?,?,?,?,?,?,'queued',0,NULL,?,?,?)",
                    (job_id, file_hash, song_key, float(offset_s), model, int(priority), pcm_path, now, now))
        con.execute("COMMIT")
        return job_id, "queued"
    except Exception:
        if con.in_transaction:
            con.execute("ROLLBACK")
        raise


def claim_next(con: sqlite3.Connection):
    con.execute("BEGIN IMMEDIATE")
    try:
        row = con.execute("SELECT id,file_hash,song_key,offset_s,model,priority,attempts,pcm_path FROM jobs "
                          "WHERE state='queued' ORDER BY priority,created_at,rowid LIMIT 1").fetchone()
        if row:
            con.execute("UPDATE jobs SET state='running',attempts=attempts+1,updated_at=? WHERE id=?",
                        (time.time(), row[0]))
        con.execute("COMMIT")
        if not row:
            return None
        names = ("id", "file_hash", "song_key", "offset_s", "model", "priority", "attempts", "pcm_path")
        return dict(zip(names, row))
    except Exception:
        con.execute("ROLLBACK")
        raise


def finish(con: sqlite3.Connection, job_id: str, state: str, error: str | None = None,
           duration_s: float | None = None) -> None:
    con.execute("UPDATE jobs SET state=?,error=?,updated_at=?,duration_s=? WHERE id=?",
                (state, error[:500] if error else None, time.time(), duration_s, job_id))


def discard_pcm(path: str | None) -> None:
    if path:
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
