"""SQLite vector store shared by the Mac backfill and the VM service.

clips is keyed by (file_hash, offset_s, model) so re-running is idempotent.
songs holds metadata per file hash; song_key is the web app's getSongKey().
"""
from __future__ import annotations

import sqlite3
import time
from typing import Iterable

import numpy as np

from .core import DIMENSIONS, MODEL_ID, song_vector

SCHEMA = """
CREATE TABLE IF NOT EXISTS songs (
  file_hash TEXT PRIMARY KEY,
  song_key TEXT,
  path TEXT,
  file_sig TEXT,
  filename TEXT,
  artist TEXT,
  title TEXT,
  album TEXT,
  genre TEXT,
  year TEXT,
  duration REAL,
  first_pass_done INTEGER DEFAULT 0,
  full_done INTEGER DEFAULT 0,
  error TEXT,
  updated_at REAL
);
CREATE INDEX IF NOT EXISTS songs_key ON songs(song_key);
CREATE INDEX IF NOT EXISTS songs_path ON songs(path);
CREATE TABLE IF NOT EXISTS clips (
  file_hash TEXT NOT NULL,
  offset_s REAL NOT NULL,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vector BLOB NOT NULL,
  source TEXT,
  created_at REAL NOT NULL,
  PRIMARY KEY (file_hash, offset_s, model)
);
CREATE INDEX IF NOT EXISTS clips_created ON clips(created_at);
"""


def connect(path: str) -> sqlite3.Connection:
    con = sqlite3.connect(path, timeout=60, isolation_level=None, check_same_thread=False)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    con.executescript(SCHEMA)
    return con


def upsert_song(con: sqlite3.Connection, file_hash: str, **fields) -> None:
    fields = {k: v for k, v in fields.items() if v is not None}
    fields["updated_at"] = time.time()
    cols = ["file_hash", *fields]
    sets = ", ".join(f"{k}=excluded.{k}" for k in fields)
    con.execute(
        f"INSERT INTO songs ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))}) "
        f"ON CONFLICT(file_hash) DO UPDATE SET {sets}",
        [file_hash, *fields.values()],
    )


def done_offsets(con: sqlite3.Connection, file_hash: str, model: str = MODEL_ID) -> list[float]:
    rows = con.execute("SELECT offset_s FROM clips WHERE file_hash=? AND model=?", (file_hash, model))
    return [r[0] for r in rows]


def put_clips(con: sqlite3.Connection, file_hash: str, offsets: Iterable[float], vectors: np.ndarray,
              model: str = MODEL_ID, source: str = "mac") -> int:
    now = time.time()
    rows = [
        (file_hash, float(o), model, int(v.shape[-1]), np.asarray(v, dtype=np.float32).tobytes(), source, now)
        for o, v in zip(offsets, vectors)
    ]
    con.execute("BEGIN IMMEDIATE")
    try:
        con.executemany("INSERT OR IGNORE INTO clips VALUES (?,?,?,?,?,?,?)", rows)
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    return len(rows)


def blob_to_vec(blob: bytes) -> np.ndarray:
    return np.frombuffer(blob, dtype=np.float32)


def clip_vectors(con: sqlite3.Connection, file_hash: str, model: str = MODEL_ID) -> tuple[list[float], np.ndarray]:
    rows = con.execute(
        "SELECT offset_s, vector FROM clips WHERE file_hash=? AND model=? ORDER BY offset_s", (file_hash, model)
    ).fetchall()
    if not rows:
        return [], np.zeros((0, DIMENSIONS), dtype=np.float32)
    return [r[0] for r in rows], np.stack([blob_to_vec(r[1]) for r in rows])


def all_song_vectors(con: sqlite3.Connection, model: str = MODEL_ID, dims: int = DIMENSIONS):
    """Return (file_hashes, matrix[n, dims], clip_counts) of averaged song vectors."""
    groups: dict[str, list[np.ndarray]] = {}
    for fh, blob in con.execute("SELECT file_hash, vector FROM clips WHERE model=? ORDER BY file_hash, offset_s", (model,)):
        groups.setdefault(fh, []).append(blob_to_vec(blob))
    keys = sorted(groups)
    if not keys:
        return [], np.zeros((0, dims), dtype=np.float32), []
    mat = np.stack([song_vector(groups[k], dims) for k in keys])
    return keys, mat, [len(groups[k]) for k in keys]
