#!/usr/bin/env python3
"""Measure CPU inference throughput and project a library completion estimate."""
from __future__ import annotations

import argparse
import resource
import sys
import time
from pathlib import Path

import numpy as np

from sisic_embed.core import CLIP_SAMPLES, GemmaEmbedder


def main(argv=None):
    default_model = Path.home() / "dev/gemini embedding 2/models/embeddinggemma-2"
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=str(default_model))
    ap.add_argument("--clips", type=int, default=8)
    ap.add_argument("--file", help="Audio source decoded as 30-second PCM clips")
    ap.add_argument("--songs", type=int, default=5434)
    ap.add_argument("--mean-minutes", type=float, default=3.72)
    ap.add_argument("--threads", type=int)
    args = ap.parse_args(argv)
    embedder = GemmaEmbedder(args.model, threads=args.threads)
    if args.file:
        from sisic_embed.core import decode_audio, full_offsets, slice_clip
        audio = decode_audio(args.file)
        clips = [slice_clip(audio, o) for o in full_offsets(len(audio) / 16000)]
        clips = [c for c in clips if len(c) >= 80000]
    else:
        rng = np.random.default_rng(71)
        clips = [rng.standard_normal(CLIP_SAMPLES).astype(np.float32) for _ in range(args.clips)]
    embedder.embed_clips([clips[0]])  # warm-up: loads the model so it is not timed
    started = time.perf_counter()
    for clip in clips:
        embedder.embed_clips([clip])
    elapsed = time.perf_counter() - started
    seconds = elapsed / max(len(clips), 1)
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    if sys.platform == "darwin":
        rss /= 1024 * 1024
        rss_unit = "GiB"
    else:
        rss /= 1024
        rss_unit = "MiB"
    first_days = seconds * args.songs * 3 / 86400
    total_clips = args.songs * args.mean_minutes * 60 / 30
    full_days = seconds * total_clips / 86400
    import torch
    print(f"clips={len(clips)} elapsed_seconds={elapsed:.2f} seconds_per_clip={seconds:.3f}")
    print(f"peak_rss={rss:.2f} {rss_unit} threads={torch.get_num_threads()}")
    print(f"library_songs={args.songs} mean_minutes={args.mean_minutes:g}")
    print(f"first_three_days={first_days:.2f} full_coverage_days={full_days:.2f}")


if __name__ == "__main__":
    main()
