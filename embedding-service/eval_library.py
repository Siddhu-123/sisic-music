#!/usr/bin/env python3
"""Evaluate a local EmbeddingGemma clip store and build a listening review page."""
from __future__ import annotations

import argparse
import html
import json
import math
import random
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

from sisic_embed import core
from sisic_embed import store


def normalize_artist(value: str | None) -> str:
    """Return the leading artist name used to group collaborations consistently."""
    name = str(value or "").strip().lower()
    for marker in (",", "&", " feat", " ft.", " x "):
        pos = name.find(marker)
        if pos >= 0:
            name = name[:pos]
    name = " ".join(name.split())
    return "" if name in {"", "unknown", "various artists"} else name


def cosine_matrix(vectors: np.ndarray) -> np.ndarray:
    """Cosine similarities for rows of vectors; zero vectors remain zero."""
    x = np.asarray(vectors, dtype=np.float64)
    if x.ndim != 2:
        raise ValueError("vectors must be a 2D array")
    norms = np.linalg.norm(x, axis=1, keepdims=True)
    x = x / np.where(norms == 0, 1.0, norms)
    with np.errstate(all="ignore"):  # spurious Accelerate warnings on this macOS; values are correct
        return x @ x.T


def retrieval_metrics(vectors: np.ndarray, labels: list[str | None], k: int = 5) -> dict:
    """P@k, hit@1 and expected chance P@k for labels represented >=3 times."""
    sims = cosine_matrix(vectors)
    if len(labels) != len(sims):
        raise ValueError("labels and vectors must have equal length")
    counts = Counter(label for label in labels if label)
    eligible = [i for i, label in enumerate(labels) if label and counts[label] >= 3]
    if len(eligible) < 3:
        return {"songs": len(eligible), "groups": 0, "p_at_k": None, "hit_at_1": None, "chance_p_at_k": None}
    precisions, hits, chances = [], [], []
    for i in eligible:
        candidates = [j for j in eligible if j != i]
        candidates.sort(key=lambda j: (-sims[i, j], j))
        take = candidates[:min(k, len(candidates))]
        matches = sum(labels[j] == labels[i] for j in take)
        precisions.append(matches / len(take))
        hits.append(float(bool(take) and labels[take[0]] == labels[i]))
        chances.append((counts[labels[i]] - 1) / (len(eligible) - 1))
    return {"songs": len(eligible), "groups": len({labels[i] for i in eligible}),
            "p_at_k": float(np.mean(precisions)), "hit_at_1": float(np.mean(hits)),
            "chance_p_at_k": float(np.mean(chances))}


def mean_top_k_overlap(vectors_a: np.ndarray, vectors_b: np.ndarray, k: int = 10) -> float | None:
    """Mean per-row Jaccard-like overlap fraction, with each top-k set size as denominator."""
    a, b = cosine_matrix(vectors_a), cosine_matrix(vectors_b)
    if a.shape != b.shape or a.shape[0] < 2:
        return None
    overlaps = []
    for i in range(len(a)):
        aa = sorted((j for j in range(len(a)) if j != i), key=lambda j: (-a[i, j], j))[:k]
        bb = sorted((j for j in range(len(b)) if j != i), key=lambda j: (-b[i, j], j))[:k]
        if aa and bb:
            overlaps.append(len(set(aa) & set(bb)) / min(k, len(a) - 1))
    return float(np.mean(overlaps)) if overlaps else None


def consistency_metrics(clip_groups: list[np.ndarray], *, pairs: int = 20_000, seed: int = 7) -> dict:
    """Compare within-song clip cosine with a deterministic sample of between-song pairs."""
    groups = [np.asarray(g, dtype=np.float32) for g in clip_groups if len(g) >= 2]
    within = []
    for group in groups:
        sim = cosine_matrix(group)
        within.extend(sim[i, j] for i in range(len(group)) for j in range(i + 1, len(group)))
    possible = sum(len(clip_groups[i]) * len(clip_groups[j]) for i in range(len(clip_groups)) for j in range(i + 1, len(clip_groups)))
    between = []
    rng = random.Random(seed)
    if possible:
        # Sampling song indices first avoids materialising a potentially huge pair list.
        sizes = [len(g) for g in clip_groups]
        valid_songs = [i for i, size in enumerate(sizes) if size]
        if len(valid_songs) >= 2:
            for _ in range(min(pairs, possible)):
                i, j = rng.sample(valid_songs, 2)
                vi = np.asarray(clip_groups[i])[rng.randrange(sizes[i])]
                vj = np.asarray(clip_groups[j])[rng.randrange(sizes[j])]
                den = float(np.linalg.norm(vi) * np.linalg.norm(vj))
                between.append(float(np.dot(vi, vj) / den) if den else 0.0)
    return {"songs_with_multiple_clips": len(groups),
            "within_song_mean_cosine": float(np.mean(within)) if within else None,
            "between_song_mean_cosine": float(np.mean(between)) if between else None,
            "between_pairs_sampled": len(between)}


def _safe_float(value):
    if value is None:
        return None
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def _vector_rows(con: sqlite3.Connection, dims: int):
    songs = {}
    for row in con.execute("SELECT file_hash,song_key,path,filename,artist,title,album,genre,year,duration FROM songs"):
        songs[row[0]] = dict(zip(("file_hash", "song_key", "path", "filename", "artist", "title", "album", "genre", "year", "duration"), row))
    clips = defaultdict(list)
    for fh, offset, blob, stored_dims in con.execute(
            "SELECT file_hash,offset_s,vector,dims FROM clips WHERE model=? ORDER BY file_hash,offset_s", (core.MODEL_ID,)):
        vec = store.blob_to_vec(blob)
        if len(vec) >= min(dims, stored_dims):
            clips[fh].append((float(offset), core.l2_normalize(vec[:dims])))
    records = []
    for fh in sorted(clips):
        meta = songs.get(fh, {"file_hash": fh})
        if not clips[fh]:
            continue
        matrix = np.stack([v for _, v in clips[fh]])
        vec = core.song_vector(matrix, dims)
        record = {**meta, "clips": clips[fh], "vector": vec}
        records.append(record)
    return songs, clips, records


def _full_coverage(record) -> bool:
    duration = _safe_float(record.get("duration"))
    if duration is None or duration <= 0:
        return False
    expected = core.full_offsets(duration)
    have = [round(o, 2) for o, _ in record["clips"]]
    return all(any(abs(round(o, 2) - target) <= 0.01 for o in have) for target in expected)


def _first_pass_vector(record, dims: int) -> np.ndarray:
    offsets = [o for o, _ in record["clips"]]
    vectors = [v for _, v in record["clips"]]
    targets = core.first_pass_offsets(float(record.get("duration") or 0))
    chosen = []
    for target in targets:
        idx = min(range(len(offsets)), key=lambda i: (abs(offsets[i] - target), offsets[i]))
        if idx not in chosen:
            chosen.append(idx)
    if not chosen:
        return core.song_vector(vectors, dims)
    return core.song_vector([vectors[i] for i in chosen], dims)


def _read_musicnn(path: str, dims: int):
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError("MusiCNN JSON must contain a list")
    found = {}
    for item in raw:
        if not isinstance(item, dict) or not item.get("fileHash"):
            continue
        vector = next((item.get(k) for k in ("vector", "embedding", "embeddings", "audioEmbedding") if item.get(k) is not None), None)
        if isinstance(vector, dict):
            vector = vector.get("vector") or vector.get("embedding")
        try:
            arr = np.asarray(vector, dtype=np.float32).reshape(-1)
        except (TypeError, ValueError):
            continue
        if arr.size:
            found[str(item["fileHash"])] = core.l2_normalize(arr[:dims])
    return found


def _middle_audio(record):
    path = record.get("path")
    if not path:
        return None
    uri = Path(path).expanduser().resolve().as_uri()
    offset = float(record["clips"][len(record["clips"]) // 2][0]) + core.CLIP_SECONDS / 2
    duration = _safe_float(record.get("duration"))
    if duration is not None:
        offset = min(offset, duration)
    return f"{uri}#t={offset:.2f}"


def _display(record):
    return {key: record.get(key) for key in ("file_hash", "song_key", "artist", "title", "album", "year", "duration", "path")}


def build_neighbors(records, seeds: int, seed: int):
    """Choose artist-stratified seeds and their nearest ten neighbours."""
    if not records:
        return []
    rng = random.Random(seed)
    order = list(range(len(records)))
    rng.shuffle(order)
    order.sort(key=lambda i: (not bool(normalize_artist(records[i].get("artist"))), rng.random()))
    selected, artists = [], set()
    for i in order:
        artist = normalize_artist(records[i].get("artist"))
        if artist and artist not in artists:
            selected.append(i)
            artists.add(artist)
            if len(selected) >= seeds:
                break
    if len(selected) < seeds:
        selected.extend(i for i in order if i not in selected and len(selected) < seeds)
    vectors = np.stack([r["vector"] for r in records])
    sims = cosine_matrix(vectors)
    output = []
    for i in selected:
        neigh = sorted((j for j in range(len(records)) if j != i), key=lambda j: (-sims[i, j], j))[:10]
        seed_row = {**_display(records[i]), "similarity": 1.0, "audio": _middle_audio(records[i]), "is_seed": True}
        neighbors = [{**_display(records[j]), "similarity": float(sims[i, j]), "audio": _middle_audio(records[j]), "is_seed": False} for j in neigh]
        output.append({"seed": seed_row, "neighbors": neighbors})
    return output


def render_review(neighbor_data) -> str:
    """Build a self-contained, escaped HTML listening and rating page."""
    cards = []
    for ci, group in enumerate(neighbor_data):
        rows = [group["seed"], *group["neighbors"]]
        trs = []
        for ri, row in enumerate(rows):
            uid = f"r{ci}_{ri}"
            def cell(key):
                value = row.get(key)
                return html.escape("" if value is None else str(value))
            audio = ""
            if row.get("audio"):
                audio = f'<audio controls preload="none" src="{html.escape(row["audio"], quote=True)}"></audio>'
            label = "Seed" if ri == 0 else f"#{ri}"
            trs.append(f'''<tr><td>{label}</td><td>{cell('artist')}</td><td>{cell('title')}</td><td>{cell('album')}</td><td>{cell('year')}</td><td>{cell('duration')}</td><td>{float(row.get('similarity') or 0):.4f}</td><td>{audio}</td><td><label><input type="radio" name="{uid}" value="good"> good</label> <label><input type="radio" name="{uid}" value="bad"> bad</label></td></tr>''')
        cards.append(f'''<section><h2>{html.escape(str(group['seed'].get('title') or 'Untitled'))} <small>— {html.escape(str(group['seed'].get('artist') or 'Unknown artist'))}</small></h2><div class="table-wrap"><table><thead><tr><th>Row</th><th>Artist</th><th>Title</th><th>Album</th><th>Year</th><th>Seconds</th><th>Cosine</th><th>Listen</th><th>Rating</th></tr></thead><tbody>{''.join(trs)}</tbody></table></div></section>''')
    body = "".join(cards) if cards else "<p>No songs with vectors were found.</p>"
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Library listening review</title><style>
:root{{color-scheme:light dark;--bg:#fff;--fg:#17202a;--line:#c7cdd3;--card:#f4f6f8}}@media(prefers-color-scheme:dark){{:root{{--bg:#15191e;--fg:#e9edf1;--line:#454d56;--card:#20262d}}}}*{{box-sizing:border-box}}body{{margin:0;padding:1rem;font:15px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg)}}main{{max-width:1500px;margin:auto}}h1{{font-size:1.5rem}}section{{margin:1rem 0 1.5rem;padding:.8rem;background:var(--card);border-radius:.7rem}}h2{{font-size:1.1rem;margin:.3rem 0 .7rem}}small{{font-weight:400}}.table-wrap{{overflow-x:auto}}table{{border-collapse:collapse;width:100%;min-width:900px}}th,td{{text-align:left;padding:.45rem;border-bottom:1px solid var(--line);vertical-align:middle}}audio{{width:220px;max-width:45vw}}button{{padding:.65rem 1rem;font:inherit;cursor:pointer}}@media(max-width:600px){{body{{padding:.55rem}}}}
</style></head><body><main><h1>Library listening review</h1><p>Listen to each seed and its nearest neighbours, then rate rows. Ratings download as JSON.</p>{body}<button id="download">Download ratings JSON</button></main><script>
document.getElementById('download').addEventListener('click',()=>{{const ratings=[];document.querySelectorAll('input[type=radio]:checked').forEach(x=>ratings.push({{row:x.name,rating:x.value}}));const blob=new Blob([JSON.stringify({{createdAt:new Date().toISOString(),ratings}},null,2)],{{type:'application/json'}});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='ratings.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}});
</script></body></html>'''


def evaluate(db_path: str, out_dir: str, *, seeds: int = 30, dims: int = 768, seed: int = 7,
             musicnn_json: str | None = None) -> dict:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    con = store.connect(db_path)
    try:
        songs, clips, records = _vector_rows(con, dims)
    finally:
        con.close()
    counts = Counter(len(clips.get(fh, [])) for fh in songs)
    covered = [r for r in records if _full_coverage(r)]
    artist_records = [r for r in records if normalize_artist(r.get("artist"))]
    artist_labels = [normalize_artist(r.get("artist")) for r in artist_records]
    album_records = [r for r in records if str(r.get("album") or "").strip()]
    album_labels = [str(r.get("album")).strip().lower() for r in album_records]
    variant = {"songs": len(covered), "mean_cosine": None, "mean_top10_neighbor_overlap": None, "skipped": len(covered) < 20}
    if len(covered) >= 20:
        full = np.stack([r["vector"] for r in covered])
        first = np.stack([_first_pass_vector(r, dims) for r in covered])
        variant["mean_cosine"] = float(np.mean(np.sum(core.l2_normalize(first) * core.l2_normalize(full), axis=1)))
        variant["mean_top10_neighbor_overlap"] = mean_top_k_overlap(first, full, 10)
    all_clip_groups = [np.stack([v for _, v in clips[fh]]) for fh in sorted(clips)]
    consistency = consistency_metrics(all_clip_groups, seed=seed)
    report = {
        "model": core.MODEL_ID,
        "dimensions": dims,
        "coverage": {"songs": len(songs), "clips": sum(k * v for k, v in counts.items()), "songs_with_at_least_3_clips": sum(n >= 3 for n in counts.values()),
                     "songs_with_full_coverage": len(covered), "clip_count_histogram": {str(k): counts[k] for k in sorted(counts)}},
        "same_artist": retrieval_metrics(np.stack([r["vector"] for r in artist_records]) if artist_records else np.zeros((0, dims)), artist_labels),
        "same_album": retrieval_metrics(np.stack([r["vector"] for r in album_records]) if album_records else np.zeros((0, dims)), album_labels),
        "variant_comparison": variant,
        "same_song_consistency": consistency,
    }
    if musicnn_json:
        old = _read_musicnn(musicnn_json, dims)
        matched = [r for r in artist_records if r["file_hash"] in old]
        labels = [normalize_artist(r.get("artist")) for r in matched]
        musicnn_vectors = np.stack([old[r["file_hash"]] for r in matched]) if matched else np.zeros((0, dims))
        report["musicnn_comparison"] = {"matched_songs": len(matched), "embeddinggemma": retrieval_metrics(np.stack([r["vector"] for r in matched]) if matched else np.zeros((0, dims)), labels),
                                        "musicnn": retrieval_metrics(musicnn_vectors, labels)}
    neighbors = build_neighbors(records, max(0, seeds), seed)
    (out / "eval.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    (out / "neighbors.json").write_text(json.dumps(neighbors, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    (out / "review.html").write_text(render_review(neighbors), encoding="utf-8")
    print(f"Evaluated {len(songs)} songs, {report["coverage"]["clips"]} clips; {len(covered)} full coverage; artist P@5={report['same_artist']['p_at_k']}")
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--seeds", type=int, default=30)
    parser.add_argument("--dims", type=int, default=768)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--musicnn-json")
    args = parser.parse_args(argv)
    if args.dims < 1 or args.seeds < 0:
        parser.error("--dims must be positive and --seeds nonnegative")
    evaluate(args.db, args.out, seeds=args.seeds, dims=args.dims, seed=args.seed, musicnn_json=args.musicnn_json)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
