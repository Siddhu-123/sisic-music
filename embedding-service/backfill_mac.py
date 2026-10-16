#!/usr/bin/env python3
"""Mac backfill: embed the local library with EmbeddingGemma 2 using the shared clip pipeline.

  python backfill_mac.py scan                     # build manifest of audio files
  python backfill_mac.py run --shard 0 --shards 4 # embed (first 3 clips for all, then the rest)
  python backfill_mac.py status                   # aggregate progress from the store
  python backfill_mac.py export                   # write vectors.json / vectors.npy for the web app

Resumable and idempotent: clips are keyed by (file hash, clip offset, model id).
Writes only to the new versioned store (default mac-app/.cache/embeddinggemma2/); the MusiCNN cache is untouched.
"""
from __future__ import annotations

import argparse
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sisic_embed import core, store  # noqa: E402

SISIC_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = SISIC_ROOT / "mac-app" / ".cache" / "embeddinggemma2"
DEFAULT_MODEL = Path.home() / "dev" / "gemini embedding 2" / "models" / "embeddinggemma-2"
EXTS = (".mp3", ".m4a", ".flac", ".wav", ".ogg", ".opus", ".aac")
# ~/Music/Music is the Apple Music library: listing it blocks on a macOS privacy prompt.
SKIP_DIRS = {"Music", "Audio Music Apps"}

STOP = threading.Event()


def _on_signal(signum, _frame):
    print(f"signal {signum}: finishing current song then stopping", flush=True)
    STOP.set()


def scan(root: Path, out: Path) -> list[dict]:
    files = []
    for entry in sorted(os.listdir(root)):
        p = root / entry
        if entry.startswith("."):
            continue
        if p.is_file():
            if entry.lower().endswith(EXTS):
                files.append(p)
            continue
        if entry in SKIP_DIRS:
            continue
        for r, dirs, fs in os.walk(p):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            files += [Path(r) / f for f in fs if f.lower().endswith(EXTS) and not f.startswith("._")]
    manifest = []
    for p in sorted(set(files)):
        st = p.stat()
        manifest.append({"path": str(p), "size": st.st_size, "mtime": int(st.st_mtime)})
    out.mkdir(parents=True, exist_ok=True)
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False))
    return manifest


def probe(path: str) -> dict:
    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration:format_tags", "-of", "json", path],
        capture_output=True, text=True,
    )
    try:
        fmt = json.loads(r.stdout)["format"]
    except Exception:
        return {"duration": 0.0}
    tags = {k.lower(): v for k, v in (fmt.get("tags") or {}).items()}
    stem = Path(path).stem
    artist = tags.get("artist") or tags.get("album_artist") or ""
    title = tags.get("title") or stem
    return {
        "duration": float(fmt.get("duration") or 0.0),
        "artist": artist,
        "title": title,
        "album": tags.get("album") or "",
        "genre": tags.get("genre") or "",
        "year": (tags.get("date") or tags.get("year") or "")[:4],
    }


def write_progress(out: Path, shard: int, payload: dict) -> None:
    tmp = out / f".progress-shard{shard}.tmp"
    tmp.write_text(json.dumps(payload))
    tmp.replace(out / f"progress-shard{shard}.json")


def band(shard: int, done: int, total: int, label: str) -> None:
    try:
        subprocess.run(["progress", f"gemma2-shard{shard}", f"{done}/{total}", label],
                       capture_output=True, timeout=5)
    except Exception:
        pass


def prepare(con, item: dict, phase: str):
    """Decode + identify one file and return the clips still missing for this phase."""
    path = item["path"]
    sig = f"{item['size']}:{item['mtime']}"
    row = con.execute("SELECT file_hash, duration FROM songs WHERE path=? AND file_sig=?", (path, sig)).fetchone()
    if row:
        file_hash, duration = row
    else:
        file_hash = core.file_sha256(path)
        meta = probe(path)
        duration = meta["duration"]
        store.upsert_song(con, file_hash, path=path, file_sig=sig, filename=Path(path).name,
                          song_key=core.song_key(meta.get("artist"), meta.get("title")), **meta)
    have = store.done_offsets(con, file_hash)
    if duration < core.MIN_SECONDS:
        return file_hash, duration, [], None
    wanted = core.first_pass_offsets(duration) if phase == "first" else core.full_offsets(duration)
    have_set = {core.round_offset(o) for o in have}
    missing = [o for o in wanted if core.round_offset(o) not in have_set]
    if not missing:
        return file_hash, duration, [], None
    audio = core.decode_audio(path)
    clips = [core.slice_clip(audio, o) for o in missing]
    keep = [(o, c) for o, c in zip(missing, clips) if len(c) >= core.SAMPLE_RATE * core.MIN_SECONDS]
    return file_hash, duration, [o for o, _ in keep], [c for _, c in keep]


def run(args) -> None:
    out = Path(args.out)
    manifest = json.loads((out / "manifest.json").read_text())
    mine = manifest[args.shard::args.shards]
    con = store.connect(str(out / "clips.sqlite"))
    embedder = core.GemmaEmbedder(args.model, threads=args.threads)
    phases = ["first", "full"] if args.phase == "both" else [args.phase]
    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)
    t0 = time.time()
    clips_done = 0
    for phase in phases:
        q: queue.Queue = queue.Queue(maxsize=2)

        def producer():
            pcon = store.connect(str(out / "clips.sqlite"))
            for item in mine:
                if STOP.is_set():
                    break
                try:
                    q.put((item, prepare(pcon, item, phase), None))
                except Exception as exc:  # keep going on bad files
                    q.put((item, None, exc))
            q.put(None)

        threading.Thread(target=producer, daemon=True).start()
        n = 0
        while True:
            got = q.get()
            if got is None:
                break
            item, prep, err = got
            n += 1
            if err is not None:
                print(f"error {item['path']}: {err}", flush=True)
                continue
            file_hash, _duration, offsets, clips = prep
            try:
                if offsets:
                    vecs = embedder.embed_clips(clips, batch_size=args.batch)
                    store.put_clips(con, file_hash, offsets, vecs, source="mac")
                    clips_done += len(offsets)
                flag = "first_pass_done" if phase == "first" else "full_done"
                con.execute(f"UPDATE songs SET {flag}=1, error=NULL WHERE file_hash=?", (file_hash,))
            except Exception as exc:
                con.execute("UPDATE songs SET error=? WHERE file_hash=?", (str(exc)[:500], file_hash))
                print(f"embed error {item['path']}: {exc}", flush=True)
            elapsed = time.time() - t0
            if n % 5 == 0 or n == len(mine):
                write_progress(out, args.shard, {
                    "shard": args.shard, "shards": args.shards, "phase": phase, "songs": n, "total": len(mine),
                    "clipsThisRun": clips_done, "elapsedSec": round(elapsed),
                    "secPerClip": round(elapsed / clips_done, 3) if clips_done else None, "updatedAt": time.time(),
                })
                band(args.shard, n, len(mine), f"gemma2 {phase} shard {args.shard}")
            if STOP.is_set():
                break
        if STOP.is_set():
            break
    band(args.shard, 1, 1, "done")
    print(f"shard {args.shard} finished: {clips_done} clips in {round(time.time() - t0)} s", flush=True)


def status(args) -> dict:
    out = Path(args.out)
    con = store.connect(str(out / "clips.sqlite"))
    manifest = json.loads((out / "manifest.json").read_text()) if (out / "manifest.json").exists() else []
    songs = con.execute("SELECT COUNT(*), SUM(first_pass_done), SUM(full_done), SUM(error IS NOT NULL) FROM songs").fetchone()
    clips = con.execute("SELECT COUNT(*) FROM clips WHERE model=?", (core.MODEL_ID,)).fetchone()[0]
    shards = []
    for f in sorted(out.glob("progress-shard*.json")):
        try:
            shards.append(json.loads(f.read_text()))
        except Exception:
            pass
    res = {"model": core.MODEL_ID, "manifestFiles": len(manifest), "songsSeen": songs[0] or 0,
           "firstPassDone": songs[1] or 0, "fullDone": songs[2] or 0, "songsWithError": songs[3] or 0,
           "clips": clips, "shards": shards}
    print(json.dumps(res, indent=2))
    return res


def export(args) -> None:
    out = Path(args.out)
    con = store.connect(str(out / "clips.sqlite"))
    keys, mat, counts = store.all_song_vectors(con)
    meta = {r[0]: r for r in con.execute(
        "SELECT file_hash, song_key, filename, artist, title, album, genre, year, duration, path FROM songs")}
    np.save(out / "song_vectors_768.npy", mat)
    index, records = [], []
    for i, fh in enumerate(keys):
        m = meta.get(fh) or (fh, None, None, None, None, None, None, None, None, None)
        offsets, clipm = store.clip_vectors(con, fh)
        start_v = core.truncate(clipm[0], args.boundary_dims) if len(offsets) else None
        end_v = core.truncate(clipm[-1], args.boundary_dims) if len(offsets) else None
        index.append({"fileHash": fh, "songKey": m[1], "path": m[9], "clipCount": counts[i]})
        rec = {
            "songKey": m[1], "fileHash": fh, "filename": m[2], "artist": m[3], "title": m[4], "album": m[5],
            "genre": m[6], "year": m[7], "duration": m[8],
            "model": core.MODEL_ID, "dimensions": args.dims, "clipCount": counts[i],
            "vector": [round(float(x), 5) for x in core.truncate(mat[i], args.dims)],
            "startVector": [round(float(x), 4) for x in start_v] if start_v is not None else None,
            "endVector": [round(float(x), 4) for x in end_v] if end_v is not None else None,
            "startOffset": offsets[0] if offsets else None, "endOffset": offsets[-1] if offsets else None,
        }
        records.append(rec)
    (out / "song_vectors_index.json").write_text(json.dumps(index, ensure_ascii=False))
    payload = {"model": core.MODEL_ID, "dimensions": args.dims, "boundaryDimensions": args.boundary_dims,
               "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "songs": records}
    (out / "vectors.json").write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    print(f"exported {len(records)} songs to {out / 'vectors.json'}")


def main(argv=None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["scan", "run", "status", "export"])
    ap.add_argument("--root", default=str(Path.home() / "Music"))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--model", default=str(DEFAULT_MODEL))
    ap.add_argument("--shard", type=int, default=0)
    ap.add_argument("--shards", type=int, default=1)
    ap.add_argument("--threads", type=int, default=None)
    ap.add_argument("--batch", type=int, default=3)
    ap.add_argument("--phase", choices=["first", "full", "both"], default="both")
    ap.add_argument("--dims", type=int, default=256)
    ap.add_argument("--boundary-dims", type=int, default=128)
    args = ap.parse_args(argv)
    if args.cmd == "scan":
        m = scan(Path(args.root), Path(args.out))
        print(f"manifest: {len(m)} files")
    elif args.cmd == "run":
        run(args)
    elif args.cmd == "status":
        status(args)
    else:
        export(args)


if __name__ == "__main__":
    main()
