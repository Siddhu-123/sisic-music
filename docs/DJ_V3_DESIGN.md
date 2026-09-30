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

## Transition styles (implemented)
`planDjMix` returns `style` and `styleReason`; `history.styles` keeps the last 3.
- `cut`: the outgoing song ends abruptly and there is no usable mix length. Downbeat cut, 60 ms fade.
- `echo-out`: tempos cannot be matched. Echo tail on the outgoing song, short fade, incoming starts at a bar line.
- `beat-blend`: beat-synced, keys compatible or unknown. Equal-power blend with bass swap and beat lock.
- `filter-blend`: beat-synced and keys clash, or the rotation alternative to `beat-blend` (70 % when the previous mix used the same style). Outgoing low-pass sweep 20 kHz to 250 Hz, incoming high-pass sweep 400 Hz to off.
- Plans without a `style` behave as before (plain linear fade, or `beat-blend` when beat-synced). Every style is cleaned up in `finishFade` and on abort.

## Simulation
`npm run simulate:dj [--seed N --size N --sessions N --json path]` compares the old greedy picker (v1) with the set planner (v3) on a seeded synthetic library (defects injected: half/double-time tempo readings, rubato, unknown keys). It exits 1 when a threshold fails. The metrics are proxies: they say nothing about how a mix sounds, only that the choices are mixable, varied and not repetitive.

```
DJ Quality Simulation (200 sessions, 400 songs, 30 transitions/session)

| Metric                            |       v1 |       v3 | Threshold (v3)            | Status |
|:----------------------------------|---------:|---------:|:--------------------------|:------:|
| Beat-syncable share                |    73.9% |    98.0% | >= v1 - 2.0% (71.9%)      |  PASS  |
| Mean tempo stretch                 |    0.72% |    0.93% | <= v1 + 0.50% (1.22%)     |  PASS  |
| Key-compatible share               |    99.1% |    99.8% | >= v1 - 2.0% (97.1%)      |  PASS  |
| P90 energy jump                    |    0.155 |    0.142 | <= v1 + 0.02 (0.175)      |  PASS  |
| Same artist within 4 share         |    48.4% |     0.5% | <= v1 * 0.5 (24.2%)       |  PASS  |
| Predictability (1 - norm entropy)  |    1.000 |    0.760 | >= 0.500 (taste-driven, not random) |  PASS  |
| Template repeats within 12         |      N/A |        0 | == 0                      |  PASS  |
| Words within limits                |      N/A |     100% | link <= 30, intro <= 45   |  PASS  |

v3 Voice: 3158 spoken lines (52.6% of transitions), mean 10.9 words/line, 0 template repeats within 12.
v1 Mix styles: {"echo-out":1567,"beat-blend":2776,"filter-blend":1657}, mean mix bars: 3.0
v3 Mix styles: {"echo-out":117,"beat-blend":3510,"filter-blend":2373}, mean mix bars: 3.0
```

What the first run showed (seed 1): the planner was worse than greedy on beat-syncable share (66.6 % vs 73.9 %), key-compatible share (92.1 % vs 99.1 %) and artist repeats (34.1 % vs 48.4 %, needs at most half). Causes: links were scored by the planner's own tempo/key heuristic instead of the mixer's `scoreDjTransition`, and the artists played before a set were forgotten at the set boundary. Fixes: `transitionPairScore` feeds the real mix score (beat-syncable and key-clash links lose 0.5 each), and `planNextSet` takes `recentArtists` (the hook passes the last three played). Checked on seeds 1 to 12: all pass.

Threshold notes: predictability must be at least 0.5 (taste-driven, not random); v1 is fully deterministic (1.0), so matching it would mean no variety. Mean tempo stretch allows v1 + 0.5 points and p90 energy jump v1 + 0.02, because v3 beat-syncs about 24 points more transitions (each needs a small stretch) and the per-seed gap to v1 is noise-level (0.25 to 0.45 points; 0.01 to 0.02). Limits: synthetic data only, artist share of 0 to 3 % means artist-themed sets are now rare, no listening test yet.
