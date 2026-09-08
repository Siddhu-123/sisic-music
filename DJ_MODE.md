# Adaptive DJ mode

Enable **Playback settings → Adaptive DJ**. DJ mode is opt-in and saved locally. It uses the existing contextual recommendation engine and native two-deck player. Runtime prediction, selection, caching, and transport run in the browser. No hosted API is added.

## Behavior

- Every three seconds of playback, estimate the risk of a user skip within the next 18 seconds. Wait until at least eight seconds into the track. The initial threshold is 0.62.
- The scorer groups existing events into listening attempts. It deduplicates event IDs and does not count pause/resume as multiple plays. Track, artist, genre, hour, device, and skip positions feed smoothed, bounded features and a small logistic formula. Fewer than four observed windows cannot trigger an automatic transition. These are heuristic risk estimates, not calibrated probabilities or a trained model.
- The existing contextual ranker supplies at most 60 playable candidates, retaining its artist-diversity adjustments. Exclude the current track and the six recent DJ selections. If this exhausts a tiny library, retain normal playback instead of forcing repetition.
- Prefer candidates within 8 BPM and, when known, the same key, relative major/minor, or adjacent compatible key. Unknown or low-confidence keys do not disqualify a candidate. Tempo, key, energy, and integrated loudness contribute 52/28/12/8 percent of the transition score, renormalized over available measurements. The transition bonus is added to the existing contextual score.
- If no candidate meets the tempo/key window, take the contextual ranker's original top result after recent-track exclusion, ignoring tempo. The tempo-adjusted sort does not determine this fallback.
- For compatible candidates, sample from up to three near ties within 0.055 of the top score. Random selection is allowed on 55% of decisions; recent selections remain excluded.
- Use the median relevant historical skip position when available. Begin a 2–7 second crossfade early enough to finish by that position. Avoid the four recent five-second timing buckets by moving earlier. If there is insufficient time, retain playback.
- Preload the proposed candidate without editing the queue. Insert it only when the transition starts, and remember successful transitions. Pause, seek, queue edits, disable, repeat-one, and end-of-track sleep cancel or suppress the plan. Failed DJ preloads leave current playback running and restore ordinary preloading.
- Compare audio position, not elapsed wall-clock time, so buffering cannot advance the transition deadline. Crossfade requires both decks ready. An automatic transition emits `dj-transition`, never a false `user-skip` or full `playback-complete` label.

## Audio metadata and backfill

Both serial and parallel worker ingestion call analysis after FFmpeg preparation and before upload. Analysis uses librosa beat tracking and chroma/key-profile correlation, plus FFmpeg integrated LUFS. It emits RMS energy in five-second windows so ranking can compare the outgoing passage with the candidate's opening. LUFS is track-level; it is not mislabeled as passage loudness. Decode/analysis is capped at the first ten minutes; integrated loudness covers the file. Uncertain keys are left empty, and silence may have no BPM or key.

Scalar metadata is stored in Drive audio app properties and `sisic-songs.json`. Window arrays live in the index, not the limited-size app properties. Missing dependencies or analysis failures produce a status and do not block ingestion. The backfill processes oldest/unattempted records first, checkpoints each result, and respects worker cancellation and dry-run mode. A successful analysis with legitimately unknown features is not retried forever.

From the existing Mac worker directory:

```sh
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python worker.py --backfill-dj-metadata --backfill-limit 25
```

Use the same configuration arguments as normal worker runs, such as `--config-file config.json`. Repeat to process the next batch. Add `--force-dj-metadata` to reanalyze completed records or `--dry-run` to inspect a batch without writing Drive metadata. Refresh the web library after a real backfill.

## Dexie v11 schema

The implemented migration adds indexes and a derived cache without removing existing records.

| Record | New data |
| --- | --- |
| `songs` | Indexed `bpm`, `musicalKey`, `djMetadataVersion`; non-indexed `keyConfidence`, `energy`, `loudnessLufs`, `djAudioWindows`, `djMetadataUpdatedAt`, `djAnalysisStatus` |
| `djTransitionScores` | Primary `cacheKey`; indexes `sourceSongKey`, `candidateSongKey`, `updatedAt`; component scores, availability, tempo delta, compatibility, and analysis version |
| Existing local queue snapshot | `djModeEnabled`, `djHistory.candidateKeys`, `djHistory.timingBuckets`; pending plans are deliberately not restored |

Cache keys include the two identities and measurements actually used, including passage energy. Metadata changes naturally invalidate old scores. The cache is capped at 2,000 rows; it is optional, local, and rebuildable. Energy/key/loudness nulls remain unknown rather than becoming zero.

## Verified telemetry and remaining assumptions

The inspected event schema already has `id`/`eventId`, `songKey`, `artist`, `eventType`, `positionSeconds`, `durationSeconds`, `secondsPlayed`, `sessionId`, and `context.hour`/`deviceType`/`timeBucket`. No new guessed telemetry fields are required. Genre is not stored on events: the scorer joins `songKey` to current library metadata. Missing genre or context supplies no matching evidence.

Positions are media positions, not proof of uninterrupted listening. Attempts containing recorded seeks are excluded from the heuristic. Legacy skips lacking a matching start cannot supply a reliable denominator and are ignored. Censored listens, including DJ interventions, only contribute to windows actually observed. Existing timestamps and session IDs establish event order; accuracy depends on the history available on this device/Drive log.

## V1 model recommendation and backend decision

Start with the implemented heuristic. It is small, inspectable, works with sparse local history, and needs neither a model download nor a training service. Its weights and 0.62 threshold need calibration against real listening outcomes; they do not establish prediction accuracy. Automatic early transitions also censor future skip labels, so training must distinguish them from completed listening.

A small logistic model is a reasonable next step once enough representative, uncensored outcomes exist. Train on the Mac worker with a chronological holdout, publish a versioned coefficient/normalization JSON file to Drive, and evaluate the dot product in the browser. Compare calibration and false-interruption rates with the heuristic before enabling it. This still needs no hosted backend. Beat/downbeat/phrase analysis and more detailed loudness envelopes can also run on the existing worker and sync as metadata.

A backend would help with always-on ingestion when the Mac is off, centralized multi-user training, transactional sync across many devices, or a dedicated streaming origin/CDN. None is required for this personal v1. A backend cannot make a suspended mobile browser execute transitions: reliable background DJ mixing may eventually need a native playback layer. Current v1 selects compatible tracks and crossfades; it does not time-stretch, beat-align, or promise sample-accurate gapless mixing.

## Review fixes and verification

Review of `feature/backend-dj-galaxy` found and fixed: tempo-biased fallback; repeated fallback choices; timing variation that could delay beyond a predicted skip; wall-clock scheduling during buffering; stale asynchronous plans; premature queue edits; fake completion labels; duplicated/resumed history counts; unbounded sparse-history confidence; missing mobile context; null metadata becoming zero; unbounded score-cache growth; stale index data overriding new analysis; lost backfill progress; swallowed Drive telemetry failures; and duplicate telemetry retries.

Regression coverage includes scorer/history behavior, fallback/sampling, timing, controller races, queue cancellation, metadata retention, retry propagation, Python signal extraction, silence, and backfill checkpoints. `scripts/verify-player.mjs` covers the existing player; `scripts/verify-dj.mjs` exercises real browser audio, synthetic skip history, IndexedDB cache, early crossfade, telemetry, and desktop/mobile settings.

Audio analysis API reference: [librosa beat tracking](https://librosa.org/doc/0.11.0/generated/librosa.beat.beat_track.html).
