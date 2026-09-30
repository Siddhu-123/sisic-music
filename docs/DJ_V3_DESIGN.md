# DJ v3 design: a Spotify-DJ-class experience, fully in the browser

Goal: after v2's beat-matched mixes, add what makes a DJ feel like a person: curated sets, a spoken link now and then, and transitions that are not always the same trick. No hosted backend, no paid API.

## Behaviour
1. **Sets.** The DJ plans a set of 3-5 songs that share a thread (energy arc, tempo neighbourhood, harmonic path, taste), speaks a short intro at the start of a set and, with probability 0.35, a short link between songs. It never talks over vocals: it speaks during the incoming song's intro (`introEnd` known) or the outgoing outro, and only when that window is at least 4 s.
2. **Set planner** (`src/services/djSetPlanner.js`, pure). Beam search (width 8) over candidate songs maximising the sum of pair scores (`scoreDjTransition().score`, plus taste score) minus penalties: same artist within 4 songs, repeated song, tempo step over 6 %, Camelot key distance over 1, energy jump over 0.3. An energy arc (`build`, `peak`, `cool`) sets a target energy per position. Deterministic given a seed; unpredictability comes from the seed and an epsilon pick among the top 3 beams. Returns items, per-link reasons and the arc.
3. **Commentary** (`src/services/djCommentary.js`, pure). `commentaryFor({ kind, facts, memory, rng })` with kinds `set-intro`, `link`, `callback`. At least 40 templates per kind with slots filled only from known facts (artist, title, tempo relation, key relation, mood word from energy, listening history from the local library, time of day). No invented trivia. Missing facts fall back to shorter templates. Word limits: link 30, set-intro 45. No template repeats within the last 12 lines; the memory object carries that state.
4. **Voice** (`src/services/djVoice.js`). Web Speech API `speechSynthesis` (free, on-device where available). Picks the best English local voice, rate 1.0-1.05. `speak(text, { onStart, onEnd })` ducks the music by 12 dB over 300 ms (through the controller) and restores it after; one utterance at a time; cancelled by pause, skip and seek; silent no-op when speech is unavailable. Setting `djVoiceEnabled`, default off until the user opts in.
5. **Transition styles** (in `planDjMix` and the controller): `beat-blend` (v2), `filter-blend` (low-pass sweep on the outgoing song over the mix, hides key clashes), `echo-out` (feedback delay tail on the outgoing song, cut on the downbeat, for songs whose tempo cannot be matched), `cut` (downbeat cut for abrupt endings). Chosen by compatibility and rotated so two consecutive mixes never share a style.
6. **Quality simulation** (`scripts/simulate-dj.mjs`). Synthetic library (400 songs, realistic tempo, key, energy, taste vectors, seeded). 200 sessions of 30 transitions, v1 greedy against v3 planner. Reports: share of beat-syncable transitions, mean absolute tempo stretch, share key-compatible after the shift, p90 energy jump, artist repeats within 5, predictability (entropy of the next song across sessions from the same start), commentary repeat rate and length. The script asserts thresholds and exits non-zero on regression.

## Non-goals
Offline mode, server-side generation of speech, any use of the user's Drive beyond the existing index.

## Simulation

DJ Quality Simulation (200 sessions, 400 songs, 30 transitions/session)

| Metric                            |       v1 |       v3 | Threshold (v3)            | Status |
|:----------------------------------|---------:|---------:|:--------------------------|:------:|
| Beat-syncable share                |    73.9% |    66.6% | >= v1 - 2.0% (71.9%)      |  FAIL  |
| Mean tempo stretch                 |    0.72% |    0.94% | <= v1 + 0.30% (1.02%)     |  PASS  |
| Key-compatible share               |    99.1% |    92.1% | >= v1 - 2.0% (97.1%)      |  FAIL  |
| P90 energy jump                    |    0.155 |    0.119 | <= v1 (0.155)             |  PASS  |
| Same artist within 4 share         |    48.4% |    34.1% | <= v1 * 0.5 (24.2%)       |  FAIL  |
| Predictability (1 - norm entropy)  |    1.000 |    0.864 | >= 0.500 (taste-driven, not random) |  PASS  |
| Template repeats within 12         |      N/A |        0 | == 0                      |  PASS  |
| Words within limits                |      N/A |     100% | link <= 30, intro <= 45   |  PASS  |

v3 Voice: 3132 spoken lines (52.2% of transitions), mean 11.0 words/line, 0 template repeats within 12.
v1 Mix styles: {"echo-out":1567,"beat-blend":2776,"filter-blend":1657}, mean mix bars: 3.0
v3 Mix styles: {"echo-out":2002,"beat-blend":2399,"filter-blend":1599}, mean mix bars: 2.9

