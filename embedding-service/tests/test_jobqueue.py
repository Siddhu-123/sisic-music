import time

from sisic_embed import jobqueue


def test_priority_fifo_and_idempotent(tmp_path):
    con = jobqueue.connect(str(tmp_path / "q.sqlite"))
    a = jobqueue.enqueue(con, "a", "a::a", 0, "m", 2, "/a")
    b = jobqueue.enqueue(con, "b", "b::b", 0, "m", 0, "/b")
    c = jobqueue.enqueue(con, "c", "c::c", 0, "m", 0, "/c")
    assert jobqueue.enqueue(con, "a", "a::a", 0, "m", 2, "/duplicate")[0] == a[0]
    assert [jobqueue.claim_next(con)["id"] for _ in range(3)] == [b[0], c[0], a[0]]


def test_stale_running_jobs_resume(tmp_path):
    con = jobqueue.connect(str(tmp_path / "q.sqlite"))
    job_id, _ = jobqueue.enqueue(con, "a", "a::a", 0, "m", 0, "/tmp/clip.f32")
    assert jobqueue.claim_next(con)["id"] == job_id
    assert jobqueue.reset_stale(con) == 1
    assert jobqueue.claim_next(con)["id"] == job_id
    assert con.execute("SELECT attempts FROM jobs WHERE id=?", (job_id,)).fetchone()[0] == 2


def test_existing_clip_skips_job(tmp_path):
    from sisic_embed import store
    import numpy as np
    con = jobqueue.connect(str(tmp_path / "q.sqlite"))
    store.put_clips(con, "a", [1], np.ones((1, 768), np.float32), model="m")
    assert jobqueue.enqueue(con, "a", "a::a", 1, "m", 0, "/tmp/unused") == (None, "done")
