# Beat Analysis

This document describes the rhythm and beat analysis pipeline implemented on the Mac worker for beat-synced DJ mode (v2).

## Purpose

The analysis extracts beat times, downbeats, bar structure, constant-tempo grids, and phrase cue points from audio tracks. Instead of storing large per-beat timestamp arrays in the cloud library index, the worker summarizes the tracking results into a compact `djRhythm` record. This record is written to `sisic-songs.json` and Google Drive file properties, providing the web application with the parameters needed for beat-phase locking, phrase-aligned transitions, and tempo matching.

## Fields of `djRhythm`

The `djRhythm` object contains the following fields:

| Field | Type | Description |
| --- | --- | --- |
| `rhythmVersion` | integer | Schema version of the rhythm analysis record (currently 2). |
| `rhythmStatus` | string | Status of beat tracking: `"ready"` on success, or `"no-beats"` if fewer than 8 beats were detected. |
| `beatTracker` | string | Identifier of the model used (e.g., `"beat-this-final0"`). |
| `bpm` | number | Fitted tempo across the track in beats per minute, calculated by `fit_tempo`. |
| `firstBeat` | number | Timestamp in seconds of the first detected beat. |
| `firstDownbeat` | number | Timestamp in seconds of the first downbeat on the dominant bar grid. |
| `barBeats` | integer | Number of beats per bar (meter, determined by `bar_grid`; typically 4). |
| `beatCount` | integer | Total count of beats detected across the analyzed audio. |
| `gridDeviationMs` | number | Root-mean-square deviation in milliseconds between detected beat times and the fitted constant-tempo grid. |
| `gridCoverage` | number | Proportion of detected beats that fall within 20% of a beat period of the regular grid (0.0 to 1.0). |
| `downbeatAgreement` | number | Proportion of downbeats that agree with the dominant bar phase (0.0 to 1.0). |
| `introEnd` | number | Timestamp in seconds where the full-energy track body begins, snapped to a 4-bar phrase boundary by `find_cue_points`. |
| `introBars` | integer | Number of intro bars preceding `introEnd`. |
| `outroStart` | number | Timestamp in seconds where the full-energy track body ends and the quiet outro begins, snapped to a 4-bar phrase boundary. |
| `outroBars` | integer | Number of quiet outro bars following `outroStart` (0 if the track ends abruptly). |
| `abruptEnd` | boolean | True if the track ends at full energy without a quiet outro. |
| `duration` | number | Duration in seconds of the analyzed audio segment. |
| `startBpm` | number | Tempo over the first 32 folded beats: the tempo an incoming track has when a mix starts at its beginning. |
| `outroBpm` | number | Tempo over the folded beats from `outroStart` (at most 64): the tempo an outgoing track has when a mix leaves it. Absent when fewer than 8 beats remain. |
| `introBeats` | integer list | The first 64 folded beats as `[t0_ms, gap1_ms, gap2_ms, ...]`. Only stored when the track has a usable grid (`gridCoverage >= 0.6`). |
| `outroBeats` | integer list | Up to 64 folded beats from the last beat at or before `outroStart`, same encoding. |
| `introVirtual`, `outroVirtual` | integer | How many beats in the matching list were inserted to bridge a gap in detections rather than detected. The player only follows a list whose guessed share is 25 % or less. |
| `beatListVersion` | integer | Encoding version of the beat lists (currently 1). |

`introBpm` (rhythm version 1) is gone: it measured the tempo at the wrong point and on a frame-quantised estimate that could be 3 % off.

### Folding, and why the lists exist

Beat This! sometimes tracks a section at double time, and real recordings are not perfectly steady (a live track measured 81 bpm overall and 78 bpm in its last minute). `fold_beats` walks the detected beats at one metrical level: it follows the running period (limited to 8 % around the global one), skips double-time off-beats and bridges holes of up to 20 s with flagged virtual beats. Tempo, grid coverage and bar grid are then recomputed on the folded beats. The two short beat lists cost about 400 bytes per song and let the player follow the songs' real beats with a phase-locked loop (`followerStep` in `src/services/djBeatMath.js`) instead of assuming one constant tempo.

## Model Files and Installation

Beat tracking relies on the Beat This! model (Foscarin, Schlueter & Widmer, ISMIR 2024), using the `final0` checkpoint exported to ONNX by Musetric.

The model files must be placed in `mac-app/models/beat-this/`:

1. `beat_this.onnx`: The neural network checkpoint in ONNX format.
   - SHA-256 (`modelSha256` in `BEAT_MODEL_INFO`): `d6b41a44dbf555e90593f60dc86aea3689e1f5db427956e4c9036c8dfde970e8`
   - Source: `https://huggingface.co/musetric/beat-this-onnx`
2. `mel-filterbank.bin`: 128-bin mel filterbank matrix (shape 513 x 128, float32 raw binary).
   - SHA-256 (`filterbankSha256` in `BEAT_MODEL_INFO`): `1ee975d96f44ccf2c3bfe37825c1c1f0b089f5703c7a12a84b1f0a3bce004533`
3. `config.json`: Model preprocessing and architecture configuration parameters.

The model requires 22050 Hz mono audio decoded via arithmetic mean (`decode_audio_mean`). Log-mel spectrograms are computed with STFT `n_fft = 1024`, `hop_length = 441`, periodic Hann window, reflect padding, magnitude normalized by `sqrt(n_fft)`, projected onto the 128 mel bins, and scaled via `log1p(1000 * x)`. Inference processes overlapping 513-frame windows with a 6-frame border using `keep_first` aggregation.

## Running Unit Tests

The test suite covers feature extraction, log-mel contract adherence against librosa, peak picking, tempo fitting, cue points, and ONNX model execution:

```sh
cd mac-app && .venv/bin/python -m unittest test_beat_tracker
```

Tests for mathematical routines run without the ONNX model files. When the model files are present, tests also verify synthetic drum tracking accuracy and file checksums against `BEAT_MODEL_INFO`.

## Metadata Backfill and Re-analysis

The Mac worker tracks metadata versions using `DJ_METADATA_VERSION` in `worker.py`.

- Version 1 extracted basic librosa BPM, musical key, RMS energy windows, and LUFS loudness.
- Version 2 adds `djRhythm` from Beat This! beat, downbeat, and cue point analysis.

The backfill command processes tracks in batches:

```sh
cd mac-app
.venv/bin/python worker.py --backfill-dj-metadata --backfill-limit 25
```

In `worker.py`, `backfill_dj_metadata` checks if `safe_int(song.get('djMetadataVersion')) < DJ_METADATA_VERSION`. Any tracks previously analyzed with version 1 (or missing `djAnalysisStatus === 'ready'`) are automatically identified as eligible targets and re-analyzed with `DJ_METADATA_VERSION = 2`.

## Third-Party Export Caveat

The ONNX model `beat_this.onnx` is a third-party export hosted at `huggingface.co/musetric/beat-this-onnx` rather than an official release by the original authors. When loaded in ONNX Runtime (`onnxruntime`), the runtime cleans unused initializers from the model graph. These warnings are expected and do not impair inference accuracy.

## Licensing Considerations

- MSD-MusiCNN (used for learned audio embeddings in `audio_embeddings.py`) is distributed under the Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International license (CC BY-NC-SA 4.0).
- The Beat This! model weights and the third-party ONNX export checkpoint currently lack a verified commercial license.
Both model licenses must be reviewed and verified prior to any commercial use.
