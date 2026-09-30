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

## DJ mode v2

DJ mode v1 executed simple time-based crossfades between songs without beat matching or tempo alignment. DJ mode v2 introduces beat-synced mixing, locking the tempos, musical bars, and beat phases of compatible tracks while managing bass energy during transitions.

### Pipeline

The v2 pipeline consists of five stages:

1. **Worker analysis**: During ingestion or backfill on the Mac worker, `analyze_beat_rhythm` runs the Beat This! deep learning model (Foscarin, Schlueter & Widmer, ISMIR 2024) on the track audio decoded at 22050 Hz mono. It fits a regular tempo grid, votes on the bar grid meter and phase, and computes phrase cue points from bar energy envelopes.
2. **Metadata storage (`djRhythm`)**: The extracted rhythm record `djRhythm` is stored in `sisic-songs.json` and cached in Drive song metadata. It includes fitted tempo (`bpm`), meter (`barBeats`), grid quality metrics (`gridCoverage`, `gridDeviationMs`, `downbeatAgreement`), cue points (`introEnd`, `introBars`, `outroStart`, `outroBars`, `abruptEnd`), the tempos at the two mix moments (`startBpm`, `outroBpm`) and two short beat lists (`introBeats`, `outroBeats`, about 400 bytes) holding the tracks' real beat times. See `docs/BEAT_ANALYSIS.md`.
3. **Candidate ranking**: `rankDjCandidates` scores candidate tracks using `scoreDjTransition`. When both tracks have usable beat grids (`hasBeatGrid`), candidate tempo is compared against the source using `tempoMatch`. Candidate key compatibility (`harmonicCompatibility`) is judged after applying the pitch shift (`keyShiftSemitones`) caused by the rate adjustment.
4. **Mix planning**: `planDjMix` schedules the transition point and duration. The transition aligns to an outgoing downbeat (`downbeatsBetween`) near the outro or before a predicted skip. Mix length is selected in whole bars (2, 4, 8, or 16 bars) via `mixBars` and rotated via `pickMixBars`.
5. **Execution**: `PlaybackController.loadAndPlay` preloads the incoming track, matches its playback rate to the outgoing tempo, offsets its initial seek position to match beat phase (`incomingStartPosition`), mutes incoming bass, locks phase before unmuting (`lockBeatPhase`), applies equal-power crossfades (`equalPowerCurve`), performs a bass swap at the midpoint (`setBassCut`), and glides the pitch home (`glidePitchHome`).

### Mix steps in order

When transitioning between two beat-synced tracks, the playback controller executes the following sequence:

1. **Leave on a bar line**: The mix starts on a downbeat at the beginning of the outgoing song's outro (`outroStart`) or earlier if a skip is predicted before the outro (`downbeatsBetween`).
2. **Select mix length**: Mix length is set to 2, 4, 8, or 16 whole bars based on the quiet margins allowed by both tracks (`outroBars` and `introBars`) using `mixBars`. To prevent predictability, `pickMixBars` rotates away from the bar length used in the previous transition.
3. **Rate-match with octave folding**: The incoming track's playback rate is adjusted by `tempoMatch` to match the outgoing tempo within `MAX_TEMPO_STRETCH` (±8%). If the tempos differ by approximately a factor of two, octave folding matches the tracks at double or half speed. Harmonic key compatibility is evaluated after this pitch shift (`semitonesForRate`).
4. **Start on beat phase and lock**: The incoming track starts playback at gain 0, positioned by `incomingStartPosition` to match the outgoing track's beat or bar phase. Once playing, `lockBeatPhase` measures the actual timing difference with `phaseErrorSeconds` over up to four micro-seeks to eliminate startup latency and lock alignment within ~8 ms before audible fading starts. Incoming low-end frequencies below 200 Hz are cut by 30 dB (`setBassCut`).
5. **Follow the real beats**: When both songs carry beat lists (and at most a quarter of each list was guessed rather than detected), a phase-locked loop (`beatFollower`, `followerStep`) compares where the incoming song is with where its beat should be given the outgoing song's beat, every 100 ms, and nudges the incoming playback rate by at most 4 % around the rate implied by the two songs' local beat gaps. A live recording that drifts from 81 to 78 bpm therefore stays in phase; a constant ratio slipped by 60-180 ms on real songs. Without lists the constant ratio is used.
6. **Equal-power fade**: Gains are ramped using `setFade` with `curve: 'equal-power'` over the mix duration. Gains follow sine (fade-in) and cosine (fade-out) curves from `equalPowerCurve`, preventing the 3 dB power dip typical of linear fades.
7. **Bass swap at the midpoint**: Halfway through the crossfade (`crossfade * 0.5`), the bass roles swap. Over the duration of one beat, the incoming deck's low shelf restores to flat (0 dB) while the outgoing deck's low shelf drops to -30 dB (`setBassCut`), avoiding low-frequency phase cancellation or mud.
8. **Pitch eases home**: Once the crossfade finishes and the outgoing track is retired, `glidePitchHome` eases the incoming track's pitch modifier back to the user's base pitch setting over 6 seconds using a smoothstep curve, avoiding an abrupt pitch step.

### Fallbacks

- **Grid fallback**: If either track lacks a rhythm record or has `gridCoverage < 0.6` (`MIN_GRID_COVERAGE`), beat syncing is disabled and `planDjMix` falls back to the v1 timed crossfade (`chooseDjTransitionTime`).
- **Downbeat alignment fallback**: If either track has `downbeatAgreement < 0.6` (`MIN_DOWNBEAT_AGREEMENT`) or meters differ, `alignmentUnit` falls back from bar-level alignment to beat-level alignment.
- **Abrupt end fallback**: If the outgoing song ends at full energy (`abruptEnd` is true or `outroBars === 0`), `mixBars` constrains the transition to a short blend (a minimum of 2 bars).

### Measured

The following numbers have been verified in test runs:
- On a synthetic 120 -> 126 bpm mix in Chromium, the incoming track's beat-phase error was 69.5 ms before the phase lock and 0.5 ms mean / 5 ms max after.
- The fade-in was stuck at full volume before a fix and follows sin/cos afterwards (power sum 0.9999 at the midpoint).
- Beat This on synthetic drums: beat F-measure 0.98-0.99 at 100/128/150 bpm, tempo within 0.03 bpm.
- 3.5 s worker time per song.

On six real songs (three film songs, a rock track, a live acoustic recording; only three pairs have tempos close enough to mix):
- The first version, with one constant tempo ratio, measured 17-179 ms mean beat error against the tracker's own beats. Part of that was the tracker: its raw beats contain double-time stretches (Anbenum: 0.36 s gaps among 0.72 s ones around the outro), which is why beats are now folded to one level before use.
- Anbenum -> Meherbaan through the real player in Chromium with the follower running: median beat error 15.5 ms, 90th percentile 28 ms over the 205 samples where both songs were audible, playback rate steering between 1.027 and 1.048 around the 1.0375 constant ratio. A 0.35 s cluster of about 336 ms readings sits where the raw beats have a spurious extra beat, not in the mix. Anbenum -> Rex Orange County: median 16 ms, with the same kind of artifact cluster.
- Independent of the tracker, cross-correlating the onset envelopes of the two rendered songs in 3 s windows (`mix_check.py`), the follower held the lag between the songs within about +-5 ms in the middle of Anbenum -> Meherbaan where the constant ratio wandered 10-35 ms. On the steadier pair (Anbenum -> Rex) both stayed within about 25 ms. The four mixes that leave a song far before its outro use the constant ratio (25-35 ms mean error against the tracker).

### Honest limits

- Downbeat agreement was 0.30-0.74 on the five sample songs, so alignment falls back to beat level when below 0.6.
- Rubato film songs had grid coverage 0.41-0.64 and therefore use the v1 fallback.
- The follower only runs when the mix leaves within 8 s of the stored outro beat list (the last beats of the song). A mix that leaves earlier, before a predicted skip, uses the constant ratio.
- Two mixes (Meherbaan -> Anbenum and Meherbaan -> Rex) measured a steady 215 ms and 134-296 ms offset between the songs' onsets even though the tracker's beats line up (27-35 ms). Either the songs' drum patterns are syncopated so the onset envelopes do not peak on the beat, or the tracker places beats at a different point of the pulse in each song. Only a listening test settles it.
- No listening test with real people has been done.
- `tests/browser/dj-mix.html` measures the app's own clocks, not recorded audio output.
- The pane used for measurement throttles animation frames, so the pitch glide was seen as steps there.


## DJ mode v3: sets, voice, transition styles
Design and measured numbers: `docs/DJ_V3_DESIGN.md`. Nothing here has been heard by a person yet.
- **Sets.** DJ mode plans 3 to 5 songs at a time (`djSetPlanner.js`, beam search over taste, tempo step, Camelot key distance, an energy arc, an artist-repeat penalty, and the mixer's own `scoreDjTransition` so links are beat-matchable). `djSetDirector.js` follows the set and re-plans when it is used up or a song is missing; it falls back to the old greedy pick if planning fails. The hook passes the last three played artists so a set does not start on an artist just heard.
- **Voice (off by default).** Settings > "DJ voice". Short template lines (`djCommentary.js`: 110 templates, no repeat within 12) are spoken with the browser's `speechSynthesis` only when a mix has at least 4 s of instrumental material, at set starts always and between songs 35 % of the time. The music ducks 12 dB while it talks. Nothing leaves the device.
- **Styles.** `beat-blend`, `filter-blend`, `echo-out`, `cut`, chosen per pair and rotated so two mixes in a row rarely share a style.
- **Checks.** `npm run simulate:dj` (seeded, 12 seeds pass), mutation gate on the planning and style code (88 % to 100 %), and a real-browser run that found and fixed a dead voice toggle.
- **Limits.** The simulation uses synthetic data and measures mixability, variety and repetition, not sound. The voice is a synthetic system voice reading templates, not a generated host. No listening test has been run.
