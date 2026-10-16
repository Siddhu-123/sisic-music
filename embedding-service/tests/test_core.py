from sisic_embed import core


def test_clip_offset_layout():
    assert core.first_pass_offsets(20) == [0]
    assert len(core.first_pass_offsets(240)) == 3
    offsets = core.full_offsets(95)
    assert offsets[0] == 0 and offsets[-1] == 65
