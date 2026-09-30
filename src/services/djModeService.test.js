import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseDjCandidate,
  buildSkipObservations,
  chooseDjTransitionTime,
  normaliseMusicalKey,
  predictSkipProbability,
  rankDjCandidates,
  scoreDjTransition,
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
