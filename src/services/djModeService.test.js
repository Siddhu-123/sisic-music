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
  assert.equal(plain.crossfadeSeconds, 4);
  assert.equal(plain.transitionAtSeconds, chooseDjTransitionTime({ positionSeconds: 30, predictedSkipAtSeconds: 60 }, 180, 4, {}));
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


