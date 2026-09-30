import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { useAdaptiveDjMode } from '../hooks/useAdaptiveDjMode.js';
import {
  chooseDjCandidate,
  buildSkipObservations,
  chooseDjTransitionTime,
  normaliseMusicalKey,
  pickMixBars,
  planDjMix,
  rememberDjTransition,
  predictSkipProbability,
  rankDjCandidates,
  scoreDjTransition,
  transitionCacheKey,
} from './djModeService.js';

const source = { songKey: 'source', track: 'Source', artist: 'Artist A', genre: 'dance', driveFileId: 'source', bpm: 120, musicalKey: 'C major', energy: .42, loudnessLufs: -10 };
const compatible = { songKey: 'compatible', track: 'Compatible', artist: 'Artist B', genre: 'dance', driveFileId: 'compatible', bpm: 124, musicalKey: 'G major', energy: .45, loudnessLufs: -11 };
const distant = { songKey: 'distant', track: 'Distant', artist: 'Artist C', genre: 'dance', driveFileId: 'distant', bpm: 148, musicalKey: 'F# minor' };
let sequence = 0;
const event = (eventType, songKey, positionSeconds, extra = {}) => ({ id: `event-${++sequence}`, eventType, songKey, positionSeconds, durationSeconds: 180, createdAt: new Date(1788854400000 + sequence * 1000).toISOString(), ...extra });

test('normalises standard musical keys and scores compatible transitions', () => {
  assert.deepEqual(normaliseMusicalKey('Dbm'), { notation: 'C# minor', root: 1, mode: 'minor' });
  assert.deepEqual(normaliseMusicalKey('8B'), normaliseMusicalKey('C MAJOR'));
  const score = scoreDjTransition(source, compatible);
  assert.equal(score.acceptable, true);
  assert.ok(score.score > .6);
  assert.equal(scoreDjTransition(source, distant).acceptable, false);
});

test('skip heuristic raises probability from observed matching skips and exposes reasons', () => {
  const events = Array.from({ length: 8 }, () => [event('playback-start', 'source', 0), event('user-skip', 'source', 25)]).flat();
  const prediction = predictSkipProbability({ song: source, songs: [source], playbackEvents: events, positionSeconds: 15, durationSeconds: 180, currentContext: { hour: 8, deviceType: 'desktop', timeBucket: 'morning' } });
  assert.ok(prediction.probability > .62);
  assert.match(prediction.reasons[0], /track skip rate/);
  assert.equal(prediction.predictedSkipAtSeconds, 25);
  const later = predictSkipProbability({ song: source, songs: [source], playbackEvents: events, positionSeconds: 60, durationSeconds: 180 });
  assert.ok(later.probability < .62);
});

test('skip observations deduplicate sync events, ignore resumes, and censor automatic transitions', () => {
  const events = [event('playback-start', 'source', 0), event('playback-pause', 'source', 4), event('playback-resume', 'source', 4), event('dj-transition', 'source', 12)];
  const observations = buildSkipObservations([...events, ...events]);
  assert.equal(observations.length, 1);
  const prediction = predictSkipProbability({ song: source, observations, positionSeconds: 10 });
  assert.equal(prediction.features.track.windowSamples, 0);
  assert.ok(prediction.probability < .5);
  assert.equal(buildSkipObservations([event('user-skip', 'source', 20)]).length, 0);
});

test('unknown measurements are absent; passage energy invalidates transition scores', () => {
  const unknown = scoreDjTransition({ energy: null, loudnessLufs: null }, { energy: null, loudnessLufs: null });
  assert.equal(unknown.available, 0);
  assert.equal(unknown.acceptable, false);
  const passages = { ...source, djAudioWindows: [{ startSeconds: 0, energy: .02 }, { startSeconds: 20, energy: .45 }] };
  const intro = scoreDjTransition(passages, compatible, 0);
  const chorus = scoreDjTransition(passages, compatible, 22);
  assert.ok(chorus.energyScore > intro.energyScore);
  assert.notEqual(chorus.cacheKey, intro.cacheKey);
});

test('fallback uses contextual order and recent fallbacks are excluded before ranking', () => {
  const choice = chooseDjCandidate([
    { song: compatible, contextualRank: 1, score: .9, transition: { acceptable: false } },
    { song: distant, contextualRank: 0, score: .2, transition: { acceptable: false } },
  ]);
  assert.equal(choice.song.songKey, 'distant');
  const ranked = rankDjCandidates({ source, songs: [source, compatible, distant], history: { candidateKeys: ['distant'] } });
  assert.ok(ranked.every(item => item.song.songKey !== 'distant'));
});

test('near-tie sampling varies tracks within budget and timing always precedes predicted skip', () => {
  const ranked = [compatible, distant].map((song, index) => ({ song, score: 1 - index * .01, transition: { acceptable: true } }));
  const draws = [.1, .9];
  assert.equal(chooseDjCandidate(ranked, { random: () => draws.shift() }).song.songKey, 'distant');
  const prediction = { positionSeconds: 10, predictedSkipAtSeconds: 30 };
  const time = chooseDjTransitionTime(prediction, 180, 4, { timingBuckets: [25] });
  assert.ok(time + 4 <= 30);
  assert.notEqual(Math.floor(time / 5) * 5, 25);
  assert.equal(chooseDjTransitionTime({ positionSeconds: 29, predictedSkipAtSeconds: 30 }, 180, 4), null);
});

test('DJ ranking reuses contextual candidates, honors compatibility, and falls back deterministically', () => {
  const ranked = rankDjCandidates({ source, songs: [source, compatible, distant], playbackEvents: [] });
  const choice = chooseDjCandidate(ranked, { random: () => .9 });
  assert.equal(choice.song.songKey, 'compatible');
  assert.equal(choice.fallback, false);
  const fallback = chooseDjCandidate([{ song: distant, score: 1, transition: scoreDjTransition(source, distant) }]);
  assert.equal(fallback.song.songKey, 'distant');
  assert.equal(fallback.fallback, true);
});

const rhythm = (bpm, extra = {}) => ({ rhythmStatus: 'ready', bpm, firstDownbeat: 0.5, barBeats: 4, gridCoverage: 0.95, downbeatAgreement: 0.9, introBars: 8, outroBars: 8, outroStart: 184.5, abruptEnd: false, ...extra });
const gridded = (songKey, bpm, key, extra) => ({ songKey, track: songKey, artist: songKey, driveFileId: songKey, bpm, musicalKey: key, djRhythm: rhythm(bpm, extra) });

test('with beat grids, tempo is matched by stretch and octave, and the key is judged as it will be heard', () => {
  const near = scoreDjTransition(gridded('a', 128, 'C major'), gridded('b', 130, 'C major'));
  assert.equal(near.beatSync, true);
  assert.equal(near.acceptable, true);
  assert.ok(Math.abs(near.tempoRatio - 128 / 130) < 1e-9);

  const ballad = scoreDjTransition(gridded('a', 140, 'A minor'), gridded('b', 70, 'A minor'));
  assert.equal(ballad.tempoOctave, 1, 'a 70 bpm track locks to a 140 bpm one at two beats per beat');
  assert.equal(ballad.acceptable, true);
  assert.equal(ballad.tempoDelta, 0);

  assert.equal(scoreDjTransition(gridded('a', 128, 'C major'), gridded('b', 90, 'C major')).acceptable, false);

  // +1 semitone of speed-up turns C major into C# major: matching a C# major track is then perfect.
  const shifted = scoreDjTransition(gridded('a', 127.2, 'C# major'), gridded('b', 120, 'C major'));
  assert.ok(Math.abs(shifted.keyShiftSemitones - 1) < 0.01 || shifted.keyShiftSemitones === 1);
  assert.equal(shifted.keyScore, 1);
  const legacy = scoreDjTransition({ ...source, bpm: 127.2, musicalKey: 'C# major', djRhythm: undefined }, { ...compatible, bpm: 120, musicalKey: 'C major', djRhythm: undefined });
  assert.ok(legacy.keyScore < 1, 'without a grid there is no rate change, so the keys stay apart');
});

test('a rubato track falls back to the v1 whole-track tempo instead of pretending to have a grid', () => {
  const rubato = gridded('b', 124, 'G major', { gridCoverage: 0.4 });
  const result = scoreDjTransition(gridded('a', 120, 'C major'), rubato);
  assert.equal(result.beatSync, false);
  assert.equal(result.tempoDelta, 4, 'the plain bpm difference, as in DJ mode v1');
});

test('a beat-synced plan leaves on a bar line, at the outro, for a whole number of bars', () => {
  const out = gridded('a', 120, 'C major');
  const incoming = gridded('b', 122, 'C major');
  const transition = scoreDjTransition(out, incoming, 60);
  const plan = planDjMix({ source: out, candidate: incoming, positionSeconds: 60, duration: 200, prediction: { positionSeconds: 60, predictedSkipAtSeconds: 120 }, transition, random: () => 0.99 });
  assert.equal(plan.beatSync, true);
  assert.ok(Math.abs(((plan.transitionAtSeconds - 0.5) / 2) % 1) < 1e-9 || Math.abs(((plan.transitionAtSeconds - 0.5) / 2) % 1 - 1) < 1e-9, 'on a bar line (2 s bars)');
  assert.equal(plan.crossfadeSeconds, plan.mixBars * 2);
  assert.ok(plan.transitionAtSeconds + plan.crossfadeSeconds <= 120 + 1e-9, 'the mix is finished by the time a skip is predicted');
  assert.ok(plan.transitionAtSeconds >= 61);

  const noSkip = planDjMix({ source: out, candidate: incoming, positionSeconds: 60, duration: 200, prediction: { positionSeconds: 60, predictedSkipAtSeconds: 78 + 400 }, transition, random: () => 0.5 });
  assert.equal(noSkip.transitionAtSeconds, 184.5, 'with no earlier skip it waits for the outro');
  assert.equal(noSkip.outroAligned, true);
  assert.ok(noSkip.transitionAtSeconds + noSkip.crossfadeSeconds <= 200);
});

test('a track that ends abruptly gets a short blend, and a mix that cannot fit falls back to a timed crossfade', () => {
  const abrupt = gridded('a', 120, 'C major', { abruptEnd: true, outroBars: 0, outroStart: 190 });
  const incoming = gridded('b', 120, 'C major');
  const transition = scoreDjTransition(abrupt, incoming, 60);
  const plan = planDjMix({ source: abrupt, candidate: incoming, positionSeconds: 60, duration: 200, prediction: { positionSeconds: 60, predictedSkipAtSeconds: 400 }, transition, random: () => 0 });
  assert.equal(plan.beatSync, true);
  assert.ok(plan.mixBars <= 2);

  const tooLate = planDjMix({ source: abrupt, candidate: incoming, positionSeconds: 199, duration: 200, prediction: { positionSeconds: 199, predictedSkipAtSeconds: 400 }, transition, fadeSeconds: 4 });
  assert.equal(tooLate.beatSync, false);
  assert.equal(tooLate.transitionAtSeconds, null, 'no room left');

  const plain = planDjMix({ source, candidate: compatible, positionSeconds: 30, duration: 180, prediction: { positionSeconds: 30, predictedSkipAtSeconds: 60 }, transition: scoreDjTransition(source, compatible), fadeSeconds: 4 });
  assert.equal(plain.beatSync, false);
  assert.equal(plain.crossfadeSeconds, 1.5);
  assert.equal(plain.style, 'echo-out');
  assert.equal(plain.styleReason, 'tempos cannot be matched');
  assert.equal(plain.transitionAtSeconds, chooseDjTransitionTime({ positionSeconds: 30, predictedSkipAtSeconds: 60 }, 180, 1.5, {}));
});

test('mix length rotates so consecutive transitions are not predictable, and never exceeds what fits', () => {
  assert.equal(pickMixBars(1), 2);
  for (let index = 0; index < 50; index += 1) assert.ok(pickMixBars(4, {}, Math.random) <= 4);
  const seen = new Set();
  for (let index = 0; index < 60; index += 1) seen.add(pickMixBars(16, { mixBars: [8] }, Math.random));
  assert.ok(!seen.has(8), 'the length used last time is avoided when others fit');
  assert.ok(seen.has(16) && seen.has(4));
  assert.equal(pickMixBars(2, { mixBars: [2] }), 2, 'with a single option it repeats rather than fail');
  const history = rememberDjTransition({ candidateKeys: ['x'], timingBuckets: [10] }, 'y', 33, 8);
  assert.deepEqual(history.mixBars, [8]);
  assert.deepEqual(rememberDjTransition(history, 'z', 70, 4).mixBars, [4, 8]);
});

test('a low-confidence key estimate is treated as unknown, so it neither blocks nor approves a mix', () => {
  const a = { ...gridded('a', 120, 'C major'), keyConfidence: 0.2 };
  const clash = { ...gridded('b', 120, 'F# minor'), keyConfidence: 0.9 };
  const unknown = scoreDjTransition(a, clash);
  assert.equal(unknown.harmonicCompatible, null, 'the shaky source key is ignored');
  assert.equal(unknown.acceptable, true);
  const sure = scoreDjTransition({ ...a, keyConfidence: 0.8 }, clash);
  assert.equal(sure.harmonicCompatible, false, 'two confident, clashing keys still reject the mix');
  assert.equal(sure.acceptable, false);
});

test('startBpm is used for incoming, outroBpm for outgoing near outro, introBpm falls back to bpm, and cache key tracks them', () => {
  const out126 = gridded('out', 126, 'C major');
  const inWithStart = gridded('in', 120, 'C major', { startBpm: 126 });
  const scoreWithStart = scoreDjTransition(out126, inWithStart);
  assert.equal(scoreWithStart.tempoDelta, 0);
  assert.equal(scoreWithStart.tempoRatio, 1);

  const outWithOutro = gridded('out2', 120, 'C major', { outroBpm: 124, outroStart: 180 });
  const in124 = gridded('in2', 124, 'C major');
  const scoreNearOutro = scoreDjTransition(outWithOutro, in124, 165);
  assert.equal(scoreNearOutro.tempoDelta, 0);
  assert.equal(scoreNearOutro.tempoRatio, 1);

  const scoreFarFromOutro = scoreDjTransition(outWithOutro, in124, 60);
  assert.ok(Math.abs(scoreFarFromOutro.tempoDelta - 4) < 1e-9);
  assert.ok(Math.abs(scoreFarFromOutro.tempoRatio - 120 / 124) < 1e-9);

  const inWithOldIntroOnly = gridded('in3', 120, 'C major', { introBpm: 128 });
  const scoreOldIntro = scoreDjTransition(out126, inWithOldIntroOnly);
  assert.ok(Math.abs(scoreOldIntro.tempoRatio - 126 / 120) < 1e-9);

  const keyBase = transitionCacheKey(outWithOutro, inWithStart, 165);
  const inDiffStart = { ...inWithStart, djRhythm: { ...inWithStart.djRhythm, startBpm: 128 } };
  assert.notEqual(transitionCacheKey(outWithOutro, inDiffStart, 165), keyBase);

  const outDiffOutro = { ...outWithOutro, djRhythm: { ...outWithOutro.djRhythm, outroBpm: 128 } };
  assert.notEqual(transitionCacheKey(outDiffOutro, inWithStart, 165), keyBase);

  const inDiffIntro = { ...inWithStart, djRhythm: { ...inWithStart.djRhythm, introBpm: 999 } };
  assert.equal(transitionCacheKey(outWithOutro, inDiffIntro, 165), keyBase);
});

test('the hook plans a set then follows it, falls back to greedy when the set is empty, and does not speak when voice is off', async () => {
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const prevH = internals.H;
  const refs = [];
  let cleanup = null;

  const useRunAdaptiveDjHook = (player, songList, events, likedKeys) => {
    if (typeof cleanup === 'function') cleanup();
    cleanup = null;
    let refIdx = 0;
    const effects = [];
    internals.H = {
      useRef(initial) {
        const idx = refIdx++;
        if (refs[idx] === undefined) refs[idx] = { current: initial };
        return refs[idx];
      },
      useMemo(fn) { return fn(); },
      useEffect(fn) { effects.push(fn); },
    };
    try {
      useAdaptiveDjMode(player, songList, events, likedKeys);
      for (const eff of effects) {
        const res = eff();
        if (typeof res === 'function') cleanup = res;
      }
    } finally {
      internals.H = prevH;
    }
  };
  const settleTicks = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };

  const testSongs = [
    { songKey: 's1', track: 'Song 1', artist: 'Daft Punk', bpm: 120, musicalKey: 'C major', energy: 0.5, driveFileId: 'df1', djRhythm: rhythm(120) },
    { songKey: 's2', track: 'Song 2', artist: 'Daft Punk', bpm: 120, musicalKey: 'C major', energy: 0.52, driveFileId: 'df2', djRhythm: rhythm(120) },
    { songKey: 's3', track: 'Song 3', artist: 'Daft Punk', bpm: 121, musicalKey: 'G major', energy: 0.54, driveFileId: 'df3', djRhythm: rhythm(121) },
    { songKey: 's4', track: 'Song 4', artist: 'Daft Punk', bpm: 120, musicalKey: 'A minor', energy: 0.56, driveFileId: 'df4', djRhythm: rhythm(120) },
    { songKey: 's5', track: 'Song 5', artist: 'Justice', bpm: 120, musicalKey: 'C major', energy: 0.58, driveFileId: 'df5', djRhythm: rhythm(120) },
  ];

  const skipEventsFor = (key) =>
    Array.from({ length: 8 }, () => [event('playback-start', key, 0), event('user-skip', key, 25)]).flat();

  let planned = [];
  const player = {
    djModeEnabled: true,
    isPlaying: true,
    currentSongKey: 's1',
    currentSong: testSongs[0],
    progress: (15 / 180) * 100, // 15 seconds into 180s track
    duration: 180,
    crossfadeSeconds: 4,
    djVoiceEnabled: true,
    djPlan: null,
    djHistory: {},
    queueRevision: 0,
    planDjTransition(p) {
      this.djPlan = p;
      planned.push(p);
      return true;
    },
    setDjPrediction() {},
  };

  try {
    // 1. Initial run: hook plans a new set and picks the first song
    useRunAdaptiveDjHook(player, testSongs, skipEventsFor('s1'), []);
    await settleTicks();
    assert.equal(planned.length, 1);
    const plan1 = planned[0];
    assert.equal(plan1.fallback, false);
    assert.ok(plan1.commentaryText); // Spoke intro commentary because voice is enabled
    const nextKey1 = plan1.candidate.songKey;
    assert.ok(['s2', 's3', 's4', 's5'].includes(nextKey1));

    // 2. Transition completed: player moves to nextKey1, set remains in ref and is followed
    player.currentSongKey = nextKey1;
    player.currentSong = testSongs.find(s => s.songKey === nextKey1);
    player.djPlan = null;
    planned = [];

    useRunAdaptiveDjHook(player, testSongs, skipEventsFor(nextKey1), []);
    await settleTicks();
    assert.equal(planned.length, 1);
    const plan2 = planned[0];
    assert.equal(plan2.fallback, false);
    const nextKey2 = plan2.candidate.songKey;
    assert.notEqual(nextKey2, nextKey1);

    // 3. Set is empty / exhausted: falls back to greedy chooseDjCandidate
    // Force set ref to empty set
    refs[1].current = { keys: [] }; // refs[1] is djSetRef
    player.currentSongKey = nextKey2;
    player.currentSong = testSongs.find(s => s.songKey === nextKey2);
    player.djPlan = null;
    planned = [];

    // Empty candidates pool for set planning by keeping only 1 candidate song
    const singleCandidateList = [player.currentSong, testSongs[0]];
    useRunAdaptiveDjHook(player, singleCandidateList, skipEventsFor(nextKey2), []);
    await settleTicks();
    assert.equal(planned.length, 1);
    assert.equal(planned[0].fallback, false); // fallback or greedy choice succeeds

    // 4. When voice is off, hook does not speak (commentaryText is null)
    player.djVoiceEnabled = false;
    player.currentSongKey = 's1';
    player.currentSong = testSongs[0];
    player.djPlan = null;
    planned = [];

    useRunAdaptiveDjHook(player, testSongs, skipEventsFor('s1'), []);
    await settleTicks();
    assert.equal(planned.length, 1);
    assert.equal(planned[0].commentaryText, null);
  } finally {
    if (typeof cleanup === 'function') cleanup();
  }
});

test('rememberDjTransition keeps the last 3 styles in history.styles', () => {
  const h0 = rememberDjTransition({}, 'k1', 20, 4, 'beat-blend');
  assert.deepEqual(h0.styles, ['beat-blend']);

  const h1 = rememberDjTransition(h0, 'k2', 40, 8, 'filter-blend');
  assert.deepEqual(h1.styles, ['filter-blend', 'beat-blend']);

  const h2 = rememberDjTransition(h1, 'k3', 60, 2, 'cut');
  assert.deepEqual(h2.styles, ['cut', 'filter-blend', 'beat-blend']);

  const h3 = rememberDjTransition(h2, 'k4', 80, 4, 'echo-out');
  assert.deepEqual(h3.styles, ['echo-out', 'cut', 'filter-blend']);

  // Call without style preserves styles up to 3
  const hNoStyle = rememberDjTransition(h3, 'k5', 100, 4);
  assert.deepEqual(hNoStyle.styles, ['echo-out', 'cut', 'filter-blend']);
});

test('style choice table: beat-blend for compatible or unknown keys, filter-blend for clashing keys', () => {
  const out = gridded('out', 120, 'C major');
  const compIn = gridded('in_comp', 120, 'C major');
  const clashIn = gridded('in_clash', 124, 'F# minor');
  const unknownKeyIn = { ...gridded('in_unk', 124, 'F# minor'), keyConfidence: 0.1 };

  // Beat-blend: compatible keys
  const transComp = scoreDjTransition(out, compIn, 60);
  assert.equal(transComp.harmonicCompatible, true);
  const planComp = planDjMix({ source: out, candidate: compIn, positionSeconds: 60, duration: 200, prediction: { positionSeconds: 60, predictedSkipAtSeconds: 400 }, transition: transComp });
  assert.equal(planComp.style, 'beat-blend');
  assert.equal(planComp.styleReason, 'keys compatible or unknown');

  // Beat-blend: unknown keys
  const transUnk = scoreDjTransition(out, unknownKeyIn, 60);
  assert.equal(transUnk.harmonicCompatible, null);
  const planUnk = planDjMix({ source: out, candidate: unknownKeyIn, positionSeconds: 60, duration: 200, prediction: { positionSeconds: 60, predictedSkipAtSeconds: 400 }, transition: transUnk });
  assert.equal(planUnk.style, 'beat-blend');
  assert.equal(planUnk.styleReason, 'keys compatible or unknown');

  // Filter-blend: clashing keys
  const transClash = scoreDjTransition(out, clashIn, 60);
  assert.equal(transClash.harmonicCompatible, false);
  const planClash = planDjMix({ source: out, candidate: clashIn, positionSeconds: 60, duration: 200, prediction: { positionSeconds: 60, predictedSkipAtSeconds: 400 }, transition: transClash });
  assert.equal(planClash.style, 'filter-blend');
  assert.equal(planClash.styleReason, 'keys clash');
});

test('style choice table: cut only when outgoing ends abruptly and plan has no usable mix length', () => {
  const incoming = gridded('in', 120, 'C major');

  // 1. abruptEnd: true with no room for 2-bar mix (4s) before duration (98s in a 100s song, downbeat at 98.5)
  const abruptWithNoRoom = gridded('abrupt1', 120, 'C major', { abruptEnd: true, outroBars: 0, firstDownbeat: 0.5 });
  const trans1 = scoreDjTransition(abruptWithNoRoom, incoming, 96);
  // duration 100, positionSeconds 96: earliest = 97.
  // 2-bar mix takes 4s: latestByEnd = 100 - 4 - 0.5 = 95.5 < 97, so eligible length is 0!
  // But a downbeat cut (0.06s) can land on downbeats up to 100 - 0.06 = 99.94 (e.g. 98.5).
  const cutPlan1 = planDjMix({ source: abruptWithNoRoom, candidate: incoming, positionSeconds: 96, duration: 100, prediction: { positionSeconds: 96, predictedSkipAtSeconds: 200 }, transition: trans1 });
  assert.equal(cutPlan1.style, 'cut');
  assert.equal(cutPlan1.styleReason, 'abrupt end with no usable mix length');
  assert.equal(cutPlan1.crossfadeSeconds, 0.06);
  assert.equal(cutPlan1.transitionAtSeconds, 98.5);

  // 2. outroBars: 0 with no room for 2-bar mix also cuts
  const outroZeroWithNoRoom = gridded('abrupt2', 120, 'C major', { abruptEnd: false, outroBars: 0, firstDownbeat: 0.5 });
  const trans2 = scoreDjTransition(outroZeroWithNoRoom, incoming, 96);
  const cutPlan2 = planDjMix({ source: outroZeroWithNoRoom, candidate: incoming, positionSeconds: 96, duration: 100, prediction: { positionSeconds: 96, predictedSkipAtSeconds: 200 }, transition: trans2 });
  assert.equal(cutPlan2.style, 'cut');
  assert.equal(cutPlan2.styleReason, 'abrupt end with no usable mix length');
  assert.equal(cutPlan2.crossfadeSeconds, 0.06);
  assert.equal(cutPlan2.beatSync, true);
  assert.equal(cutPlan2.mixBars, 0);
  assert.equal(cutPlan2.outroAligned, false);

  // Outgoing with two downbeats before duration - 0.06 picks the last one:
  const cutPlanMulti = planDjMix({ source: outroZeroWithNoRoom, candidate: incoming, positionSeconds: 96, duration: 101, prediction: { positionSeconds: 96, predictedSkipAtSeconds: 200 }, transition: trans2 });
  assert.equal(cutPlanMulti.transitionAtSeconds, 100.5);

  // If the last downbeat is at 98.5 and duration is 98.55, 98.55 - 0.06 = 98.49 < 98.5, so it cannot cut and falls back:
  const cutPlanTooClose = planDjMix({ source: outroZeroWithNoRoom, candidate: incoming, positionSeconds: 96, duration: 98.55, prediction: { positionSeconds: 96, predictedSkipAtSeconds: 200 }, transition: trans2 });
  assert.notEqual(cutPlanTooClose.style, 'cut');

  // Boundary 1: When outgoing has abruptEnd/outroBars:0 BUT there IS usable mix length, it blends, does NOT cut
  const abruptWithRoom = gridded('abrupt3', 120, 'C major', { abruptEnd: true, outroBars: 0, outroStart: 180 });
  const trans3 = scoreDjTransition(abruptWithRoom, incoming, 60);
  const blendPlan = planDjMix({ source: abruptWithRoom, candidate: incoming, positionSeconds: 60, duration: 200, prediction: { positionSeconds: 60, predictedSkipAtSeconds: 400 }, transition: trans3 });
  assert.notEqual(blendPlan.style, 'cut');
  assert.equal(blendPlan.style, 'beat-blend');

  // Boundary 2: When outgoing does NOT end abruptly (abruptEnd: false, outroBars: 8) and mix cannot fit, does NOT cut
  const nonAbrupt = gridded('normal', 120, 'C major', { abruptEnd: false, outroBars: 8 });
  const trans4 = scoreDjTransition(nonAbrupt, incoming, 96);
  const nonCutPlan = planDjMix({ source: nonAbrupt, candidate: incoming, positionSeconds: 96, duration: 100, prediction: { positionSeconds: 96, predictedSkipAtSeconds: 200 }, transition: trans4 });
  assert.notEqual(nonCutPlan.style, 'cut');
});

test('style choice table: echo-out when tempos cannot be matched', () => {
  const out120 = gridded('out', 120, 'C major');
  const fast180 = gridded('fast', 180, 'C major'); // stretch 120/180 or 120/90 = 33% > 8%, cannot match
  const transMismatched = scoreDjTransition(out120, fast180, 60);
  assert.equal(transMismatched.beatSync, false);

  // With beat grid on outgoing song: crossfades over 2 beats (1.0s for 120 bpm) and starts at next bar line
  const echoWithGrid = planDjMix({ source: out120, candidate: fast180, positionSeconds: 60, duration: 200, prediction: { positionSeconds: 60, predictedSkipAtSeconds: 100 }, transition: transMismatched });
  assert.equal(echoWithGrid.style, 'echo-out');
  assert.equal(echoWithGrid.styleReason, 'tempos cannot be matched');
  assert.equal(echoWithGrid.beatSync, false);
  assert.equal(echoWithGrid.crossfadeSeconds, 2 * (60 / 120)); // 1.0s
  assert.ok(echoWithGrid.transitionAtSeconds >= 61);
  // Bar line check: downbeat on out120
  assert.ok(Math.abs(((echoWithGrid.transitionAtSeconds - 0.5) / 2) % 1) < 1e-6);

  // Without beat grid on outgoing song: crossfades over 1.5s
  const noGridOut = { songKey: 'nogrid', bpm: 120, musicalKey: 'C major' };
  const echoNoGrid = planDjMix({ source: noGridOut, candidate: fast180, positionSeconds: 60, duration: 200, prediction: { positionSeconds: 60, predictedSkipAtSeconds: 100 }, transition: { beatSync: false } });
  assert.equal(echoNoGrid.style, 'echo-out');
  assert.equal(echoNoGrid.crossfadeSeconds, 1.5);
  assert.equal(echoNoGrid.styleReason, 'tempos cannot be matched');
});

test('rotation with scripted rng rotates between beat-blend and filter-blend with probability 0.7', () => {
  const out = gridded('out', 120, 'C major');
  const compIn = gridded('in_comp', 120, 'C major'); // default: beat-blend
  const clashIn = gridded('in_clash', 124, 'F# minor'); // default: filter-blend
  const transComp = scoreDjTransition(out, compIn, 60);
  const transClash = scoreDjTransition(out, clashIn, 60);

  // 1. Previous was beat-blend, chosen is beat-blend:
  // pickMixBars consumes 1st draw, rotation consumes 2nd draw
  // Scripted rng: 2nd draw = 0.69 (< 0.70) -> rotates to filter-blend
  let rngCalls = [0.1, 0.69];
  const rot1 = planDjMix({
    source: out, candidate: compIn, positionSeconds: 60, duration: 200,
    prediction: { positionSeconds: 60, predictedSkipAtSeconds: 400 },
    transition: transComp,
    history: { styles: ['beat-blend'] },
    random: () => rngCalls.shift(),
  });
  assert.equal(rot1.style, 'filter-blend');
  assert.equal(rot1.styleReason, 'rotation alternative to beat-blend');

  // Scripted rng: 2nd draw = 0.70 (>= 0.70) -> stays beat-blend
  rngCalls = [0.1, 0.70];
  const noRot1 = planDjMix({
    source: out, candidate: compIn, positionSeconds: 60, duration: 200,
    prediction: { positionSeconds: 60, predictedSkipAtSeconds: 400 },
    transition: transComp,
    history: { styles: ['beat-blend'] },
    random: () => rngCalls.shift(),
  });
  assert.equal(noRot1.style, 'beat-blend');
  assert.equal(noRot1.styleReason, 'keys compatible or unknown');

  // 2. Previous was filter-blend, chosen is filter-blend:
  // Scripted rng: 2nd draw = 0.1 (< 0.70) -> rotates to beat-blend
  rngCalls = [0.1, 0.1];
  const rot2 = planDjMix({
    source: out, candidate: clashIn, positionSeconds: 60, duration: 200,
    prediction: { positionSeconds: 60, predictedSkipAtSeconds: 400 },
    transition: transClash,
    history: { styles: ['filter-blend'] },
    random: () => rngCalls.shift(),
  });
  assert.equal(rot2.style, 'beat-blend');
  assert.equal(rot2.styleReason, 'rotation alternative to filter-blend');

  // Scripted rng: 2nd draw = 0.85 (>= 0.70) -> stays filter-blend
  rngCalls = [0.1, 0.85];
  const noRot2 = planDjMix({
    source: out, candidate: clashIn, positionSeconds: 60, duration: 200,
    prediction: { positionSeconds: 60, predictedSkipAtSeconds: 400 },
    transition: transClash,
    history: { styles: ['filter-blend'] },
    random: () => rngCalls.shift(),
  });
  assert.equal(noRot2.style, 'filter-blend');
  assert.equal(noRot2.styleReason, 'keys clash');

  // 3. Chosen does not match previous: no rotation attempted
  rngCalls = [0.1, 0.1];
  const diffStyle = planDjMix({
    source: out, candidate: compIn, positionSeconds: 60, duration: 200,
    prediction: { positionSeconds: 60, predictedSkipAtSeconds: 400 },
    transition: transComp,
    history: { styles: ['filter-blend'] },
    random: () => rngCalls.shift(),
  });
  assert.equal(diffStyle.style, 'beat-blend');
  assert.equal(rngCalls.length, 1); // 2nd draw was not even consumed!

  // 4. Never invent cut or echo-out for songs that do not qualify:
  // echo-out does not rotate to cut or blend
  const transMismatched = scoreDjTransition(out, gridded('fast', 180, 'C major'), 60);
  const echoPlan = planDjMix({
    source: out, candidate: gridded('fast', 180, 'C major'), positionSeconds: 60, duration: 200,
    prediction: { positionSeconds: 60, predictedSkipAtSeconds: 400 },
    transition: transMismatched,
    history: { styles: ['echo-out'] },
    random: () => 0.01,
  });
  assert.equal(echoPlan.style, 'echo-out');
});


