import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEIGHTS,
  outcomeWeight,
  computeAffinities,
  dailyAffinity,
  queueReplaceSignals,
  createSessionSteer,
  pairTransitionStats,
  transitionPenalty,
  pickWithExploration,
  registerSkipPredictor,
  clearSkipPredictor,
  predictSkip,
  SKIP_MODEL_FEATURES,
  buildSkipTrainingRows,
} from './behaviourLearning.js';

const event = (eventType, fields = {}) => ({ eventType, createdAt: '2026-10-16T00:00:00.000Z', ...fields });
const same = (a, b, epsilon = 1e-10) => assert.ok(Math.abs(a - b) < epsilon, `${a} differs from ${b}`);

test('outcome weights cover skip thresholds and engagement events', () => {
  const skip = positionSeconds => outcomeWeight(event('user-skip', { positionSeconds, durationSeconds: 200 }));
  assert.equal(skip(9.9), -1);
  assert.equal(skip(10), -0.5);
  assert.equal(skip(60), -0.5);
  assert.equal(skip(60.1), -0.15);
  assert.equal(skip(159.9), -0.15);
  assert.equal(skip(160), -0.05);
  assert.equal(outcomeWeight(event('playback-complete')), WEIGHTS.complete);
  assert.equal(outcomeWeight(event('user-prev')), 0);
  assert.equal(outcomeWeight(event('playback-replay')), WEIGHTS.replay);
  assert.equal(outcomeWeight(event('song-like')), WEIGHTS.like);
  assert.equal(outcomeWeight(event('song-unlike')), WEIGHTS.unlike);
  assert.equal(outcomeWeight(event('playback-start', { sourceType: 'search' })), 0.8);
  assert.equal(outcomeWeight(event('playback-start', { sourceType: 'queue' })), 0);
  assert.equal(outcomeWeight(event('unknown')), 0);
});

test('user-prev ends a listen without creating a skip or negative affinity', () => {
  const affinity = computeAffinities([
    event('playback-start', { songKey: 'song' }),
    event('user-prev', { songKey: 'song' }),
  ]).get('song');
  assert.equal(affinity.skips, 0);
  assert.equal(affinity.score, 0);
});

test('affinities decay by half-life and daily buckets span 30 days', () => {
  const now = new Date('2026-10-16T00:00:00.000Z');
  const old = new Date(now.getTime() - 21 * 86400000).toISOString();
  const recent = event('playback-complete', { songKey: 'song', createdAt: now.toISOString() });
  const aged = { ...recent, createdAt: old };
  const affinities = computeAffinities([
    event('playback-start', { songKey: 'song', createdAt: now.toISOString() }),
    event('user-skip', { songKey: 'song', positionSeconds: 12, durationSeconds: 100, createdAt: now.toISOString() }),
    recent,
    aged,
  ], { now, halfLifeDays: 21 });
  same(affinities.get('song').score, 0.25);
  assert.equal(affinities.get('song').plays, 1);
  assert.equal(affinities.get('song').skips, 1);
  assert.equal(affinities.get('song').lastAt, now.toISOString());
  const daily = dailyAffinity([recent, event('song-like', { songKey: 'song', createdAt: now.toISOString() })], { now });
  assert.equal(daily.size, 30);
  assert.equal(daily.get('2026-10-16'), 2);
  assert.equal(daily.get('2026-09-17'), 0);
});

test('queue replacements point away from the most recent replaced-queue songs', () => {
  const vectors = { a: [1, 0], b: [0, 1], c: [-1, 0] };
  const events = [
    event('playback-start', { songKey: 'a', queueId: 'old', createdAt: '2026-10-16T00:00:00Z' }),
    event('playback-start', { songKey: 'b', queueId: 'old', createdAt: '2026-10-16T00:01:00Z' }),
    event('playback-start', { songKey: 'c', queueId: 'old', createdAt: '2026-10-16T00:02:00Z' }),
    event('queue-replaced', { queueId: 'new', previousQueueId: 'old', skipsInPreviousQueue: 3, createdAt: '2026-10-16T00:03:00Z' }),
    event('queue-replaced', { previousQueueId: 'old', skipsInPreviousQueue: 1 }),
  ];
  const signals = queueReplaceSignals(events, key => vectors[key]);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].queueId, 'old');
  same(signals[0].weight, 0.6);
  same(Math.hypot(...signals[0].direction), 1);
  same(signals[0].direction[0], 0);
  assert.ok(signals[0].direction[1] > 0);
});

test('session steering follows positive outcomes, avoids negative ones, reranks, and persists', () => {
  const steer = createSessionSteer();
  assert.equal(steer.score([1, 0]), 0);
  steer.observe([1, 0], 1);
  assert.ok(steer.score([1, 0]) > steer.score([0, 1]));
  steer.observe([0, 1], -1);
  assert.ok(steer.score([1, 0]) > 0);
  assert.ok(steer.score([0, 1]) < 0);
  const reordered = createSessionSteer().observe([0, 1], 1).rerank([
    { songKey: 'a', vector: [1, 0], baseScore: 1 },
    { songKey: 'b', vector: [0, 1], baseScore: 0.8 },
  ], { mix: 0.8 });
  assert.equal(reordered[0].songKey, 'b');
  const restored = createSessionSteer.fromJSON(steer.toJSON());
  same(restored.score([1, 0]), steer.score([1, 0]));
});

test('transition statistics smooth a single skip and accumulate early skips', () => {
  const events = [
    event('playback-start', { songKey: 'a', queueId: 'q', createdAt: '2026-10-16T00:00:00Z' }),
    event('playback-start', { songKey: 'b', queueId: 'q', createdAt: '2026-10-16T00:01:00Z' }),
    event('user-skip', { songKey: 'b', queueId: 'q', positionSeconds: 8, createdAt: '2026-10-16T00:01:08Z' }),
  ];
  const stats = pairTransitionStats(events);
  assert.deepEqual(stats.get('a=>b'), { plays: 1, skips: 1, earlySkips: 1 });
  same(transitionPenalty(stats, 'a', 'b'), 0.5);
  same(transitionPenalty(stats, 'b', 'a'), 0);
});

test('exploration is near epsilon over 10,000 seeded picks and selects below top five', () => {
  let seed = 123456789;
  const rng = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296);
  const ranked = Array.from({ length: 30 }, (_, index) => ({ key: index }));
  let explored = 0;
  for (let index = 0; index < 10000; index++) {
    const picked = pickWithExploration(ranked, { epsilon: 0.1, rng });
    if (picked.explore) {
      explored++;
      assert.ok(picked.key >= 5);
    } else assert.equal(picked.key, 0);
  }
  assert.ok(explored > 900 && explored < 1100, `expected about 1000 explorations, got ${explored}`);
});

test('skip predictor hook overrides the documented heuristic and training rows label outcomes', () => {
  clearSkipPredictor();
  const baseline = predictSkip({ affinity: 1 });
  assert.ok(baseline >= 0 && baseline <= 1);
  assert.equal(SKIP_MODEL_FEATURES.includes('transitionPenalty'), true);
  registerSkipPredictor(features => features.affinity * 0.25);
  assert.equal(predictSkip({ affinity: 2 }), 0.5);
  clearSkipPredictor();
  const rows = buildSkipTrainingRows([
    event('user-skip', { songKey: 'a', positionSeconds: 59, sourceType: 'search', positionInQueue: 2 }),
    event('user-skip', { songKey: 'b', positionSeconds: 60 }),
    event('playback-complete', { songKey: 'c' }),
  ], { affinities: new Map([['a', { score: 1.25 }]]), vectorOf: key => [key === 'a' ? 1 : 0, 0] });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].label, 1);
  assert.equal(rows[0].affinity, 1.25);
  assert.equal(rows[0].sourceType, 'search');
  assert.equal(rows[1].label, 0);
});
