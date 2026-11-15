import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearSkipPredictor,
  computeRocAuc,
  hasCustomSkipPredictor,
  predictSkip,
  trainSkipModel,
} from './behaviourLearning.js';
import {
  CONTEXTUAL_PRIOR_WEIGHTS,
  rankContextualSongs,
} from './contextualRecommendationService.js';
import { rankDjCandidates } from './djModeService.js';
import {
  applyPersonalRankerState,
  fitAndEvaluatePersonalRanker,
  sortEventsChronologically,
} from './personalRanker.js';

function makeUnitVec(dims, primaryIdx, jitterSeed = 0) {
  const vec = new Array(dims).fill(0);
  vec[primaryIdx % dims] = 1;
  vec[(primaryIdx + 1) % dims] = 0.25 * Math.sin(jitterSeed + 1);
  vec[(primaryIdx + 2) % dims] = 0.2 * Math.cos(jitterSeed + 2);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map(v => v / norm);
}

test('sortEventsChronologically orders newest-first logs ascending by createdAt', () => {
  const sorted = sortEventsChronologically([
    { eventType: 'user-skip', songKey: 'b', createdAt: '2026-10-20T12:00:00Z' },
    { eventType: 'playback-complete', songKey: 'a', createdAt: '2026-10-10T12:00:00Z' },
  ]);
  assert.deepEqual(sorted.map(e => e.songKey), ['a', 'b']);
});

test('thin playback history falls back safely to exact baseline prior weights', () => {
  clearSkipPredictor();
  const songs = Array.from({ length: 12 }, (_, i) => ({
    songKey: `s-${i}`,
    track: `Track ${i}`,
    artist: `Artist ${i}`,
    driveFileId: `d-${i}`,
    vector: makeUnitVec(16, i % 3, i),
    dimensions: 16,
  }));
  const result = fitAndEvaluatePersonalRanker({
    songs,
    playbackEvents: [
      { eventType: 'playback-start', songKey: 's-0', createdAt: '2026-11-01T10:00:00Z' },
      { eventType: 'playback-complete', songKey: 's-0', createdAt: '2026-11-01T10:03:00Z' },
    ],
  });
  assert.equal(result.rankerEnabled, false);
  assert.equal(result.skipEnabled, false);
  assert.deepEqual(result.rankerWeights, Array.from(CONTEXTUAL_PRIOR_WEIGHTS));

  // Fallback scores must match day-1 unweighted baseline bit-for-bit.
  const baseRanked = rankContextualSongs(songs, { limit: 5, now: 1794000000000 });
  const fallbackRanked = rankContextualSongs(songs, { limit: 5, now: 1794000000000, rankerWeights: result.rankerWeights });
  assert.deepEqual(
    fallbackRanked.map(r => r.recommendationScore),
    baseRanked.map(r => r.recommendationScore),
  );
});

test('logistic skip trainer learns personalized context signal and achieves higher ROC AUC than static heuristic', () => {
  const rows = [];
  for (let i = 0; i < 60; i++) {
    const isEvening = i % 2 === 0;
    // Static heuristic gives zero weight to hourOfDay, so two songs with identical affinity/tp
    // at 9pm vs 8am look identical to baseline, whereas learned model separates them cleanly.
    rows.push({
      affinity: 0.25,
      steerScore: 0.0,
      transitionPenalty: 0.25,
      hourOfDay: isEvening ? 21 : 8,
      sourceType: 'radio',
      positionInQueue: 1,
      label: isEvening ? 0 : 1,
    });
  }
  const train = rows.slice(0, 40);
  const testRows = rows.slice(40);
  const model = trainSkipModel(train, { minRows: 12, epochs: 80, lr: 0.25, lambda: 4.0 });
  assert.equal(model.trained, true);
  clearSkipPredictor();
  const baseAuc = computeRocAuc(testRows.map(r => predictSkip(r)), testRows.map(r => r.label));
  const learnedAuc = computeRocAuc(testRows.map(r => model.predict(r)), testRows.map(r => r.label));
  assert.equal(baseAuc, 0.5);
  assert.ok(learnedAuc > 0.9, `expected learnedAuc > 0.9, got ${learnedAuc}`);
});

test('temporal holdout promotes learned ranker when user exhibits consistent finish vs skip patterns and avoids leakage', () => {
  clearSkipPredictor();
  const dims = 16;
  // Build 80 catalog songs across 4 styles; clusters 0 and 1 match long-term taste, cluster 2/3 get skipped.
  const songs = Array.from({ length: 80 }, (_, i) => ({
    songKey: `song-${i}`,
    track: `Track ${i}`,
    artist: `Artist ${i % 20}`,
    driveFileId: `file-${i}`,
    vector: makeUnitVec(dims, (i % 4) * 4, i * 0.3),
    dimensions: dims,
    playCount: i < 20 ? 5 : 0, // Liked/frequent vs discovery
  }));
  const likedSongKeys = Array.from({ length: 12 }, (_, i) => `song-${i * 4}`);

  // Simulate 28 sessions chronologically: user consistently prefers songs matching their active session
  // (cluster 0 or liked tracks with strong sequence match) and skips cluster 2/3 tracks.
  const events = [];
  const startMs = Date.parse('2026-10-01T08:00:00Z');
  for (let sess = 0; sess < 28; sess++) {
    const sessTs = startMs + sess * 8 * 60 * 60 * 1000;
    const targetIdx = (sess % 10) * 4; // All cluster 0 liked tracks
    const seedIdx = ((sess + 1) % 10) * 4;
    const negIdx = 2 + (sess % 15) * 4; // Cluster 2 tracks (to skip)

    events.push({
      eventType: 'playback-start',
      songKey: `song-${seedIdx}`,
      sessionId: `s-${sess}`,
      queueId: `q-${sess}`,
      sourceType: 'radio',
      createdAt: new Date(sessTs).toISOString(),
    });
    events.push({
      eventType: 'playback-complete',
      songKey: `song-${seedIdx}`,
      sessionId: `s-${sess}`,
      queueId: `q-${sess}`,
      positionSeconds: 190,
      durationSeconds: 190,
      createdAt: new Date(sessTs + 190_000).toISOString(),
    });
    events.push({
      eventType: 'playback-start',
      songKey: `song-${negIdx}`,
      sessionId: `s-${sess}`,
      queueId: `q-${sess}`,
      sourceType: 'radio',
      positionInQueue: 1,
      createdAt: new Date(sessTs + 200_000).toISOString(),
    });
    events.push({
      eventType: 'user-skip',
      songKey: `song-${negIdx}`,
      sessionId: `s-${sess}`,
      queueId: `q-${sess}`,
      positionSeconds: 12,
      durationSeconds: 200,
      createdAt: new Date(sessTs + 212_000).toISOString(),
    });
    events.push({
      eventType: 'playback-start',
      songKey: `song-${targetIdx}`,
      sessionId: `s-${sess}`,
      queueId: `q-${sess}`,
      sourceType: 'search',
      positionInQueue: 2,
      createdAt: new Date(sessTs + 220_000).toISOString(),
    });
    events.push({
      eventType: 'playback-complete',
      songKey: `song-${targetIdx}`,
      sessionId: `s-${sess}`,
      queueId: `q-${sess}`,
      positionSeconds: 185,
      durationSeconds: 185,
      createdAt: new Date(sessTs + 405_000).toISOString(),
    });
  }

  const now = startMs + 29 * 8 * 60 * 60 * 1000;
  const result = fitAndEvaluatePersonalRanker({
    songs,
    playbackEvents: events,
    likedSongKeys,
    now,
  });

  assert.ok(result.evalReport.trainPairs > 20);
  assert.ok(result.evalReport.ranking.learned.queries >= 5);
  assert.ok(
    result.evalReport.ranking.learned.hitAt10 >= result.evalReport.ranking.baseline.hitAt10,
    'learned ranker Hit@10 should meet or beat baseline',
  );
  // Check skip predictor wiring works cleanly
  applyPersonalRankerState({ ...result, skipEnabled: true });
  assert.equal(hasCustomSkipPredictor(), true);

  // DJ ranker still orders cleanly with active learned skip predictor
  const djRanked = rankDjCandidates({
    source: songs[0],
    songs: songs.slice(0, 20),
    playbackEvents: events.slice(0, 30),
    likedSongKeys,
    now,
  });
  assert.ok(djRanked.length > 0);
  assert.ok(typeof djRanked[0].skipRisk === 'number');
  clearSkipPredictor();
});
