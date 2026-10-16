import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import eval_library as ev
from sisic_embed import store


def test_artist_normalization_and_retrieval_known_answer():
    assert ev.normalize_artist("The Band feat. Guest") == "the band"
    assert ev.normalize_artist("Various Artists") == ""
    vectors = np.array([[1, 0], [0.99, 0.01], [0.98, 0.02], [0, 1], [0.01, 0.99], [0.02, 0.98]], dtype=float)
    result = ev.retrieval_metrics(vectors, ["a"] * 3 + ["b"] * 3, k=2)
    assert result["songs"] == 6
    assert result["groups"] == 2
    assert result["p_at_k"] == 1.0
    assert result["hit_at_1"] == 1.0
    assert np.isclose(result["chance_p_at_k"], 0.4)


def test_neighbor_overlap_and_clip_consistency_known_answer():
    a = np.array([[1, 0], [0, 1], [0.9, 0.1], [0.1, 0.9]], dtype=float)
    assert ev.mean_top_k_overlap(a, a, k=2) == 1.0
    groups = [np.array([[1, 0], [1, 0]], dtype=float), np.array([[0, 1], [0, 1]], dtype=float)]
    result = ev.consistency_metrics(groups, pairs=10, seed=3)
    assert result["within_song_mean_cosine"] == 1.0
    assert result["between_song_mean_cosine"] == 0.0
    assert result["between_pairs_sampled"] == 4


def test_end_to_end_cli_outputs_reports_and_escaped_review(tmp_path, capsys):
    db = tmp_path / "clips.sqlite"
    out = tmp_path / "report"
    con = store.connect(str(db))
    vectors = [np.array([1, 0, 0], dtype=np.float32), np.array([0.99, 0.1, 0], dtype=np.float32),
               np.array([0.98, 0.2, 0], dtype=np.float32)]
    for i, vector in enumerate(vectors):
        fh = f"hash-{i}"
        audio = tmp_path / f"song {i} & <mix>.wav"
        audio.write_bytes(b"audio placeholder")
        store.upsert_song(con, fh, song_key=f"artist::{i}", path=str(audio), filename=f"song{i}.wav",
                          artist="A&B <Band>", title=f"Track <{i}>", album="Album & One", year="2024", duration=20.0)
        store.put_clips(con, fh, [0.0], vector[None, :])
    con.close()

    assert ev.main(["--db", str(db), "--out", str(out), "--seeds", "2", "--dims", "3", "--seed", "7"]) == 0
    report = json.loads((out / "eval.json").read_text())
    neighbors = json.loads((out / "neighbors.json").read_text())
    review = (out / "review.html").read_text()
    assert report["coverage"]["songs"] == 3
    assert report["coverage"]["clips"] == 3
    assert report["coverage"]["clip_count_histogram"] == {"1": 3}
    assert report["same_artist"]["p_at_k"] == 1.0
    assert report["same_album"]["p_at_k"] == 1.0
    assert report["variant_comparison"]["skipped"] is True
    assert len(neighbors) == 2  # after distinct artists are exhausted, fill the requested count
    assert "Track &lt;" in review
    assert "A&amp;B &lt;Band&gt;" in review
    assert "file://" in review and "controls preload=\"none\"" in review
    assert "Download ratings JSON" in review
    assert "Evaluated 3 songs" in capsys.readouterr().out
