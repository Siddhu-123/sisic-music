import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildArtistMix, buildDailyMixes, buildDecadeMix, buildDevilMix, buildGenreMix, buildLongMix,
  buildMoodMix, buildNicheMix, buildTextMix, createInfiniteMix,
} from './mixEngine.js';
import { transitionCost } from './flowPath.js';

function fixture(countPerCluster = 6) {
  const songs = [];
  const vectors = new Map();
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let c = 0; c < axes.length; c++) for (let i = 0; i < countPerCluster; i++) {
    const songKey = `c${c}-${i}`;
    const vector = [...axes[c]];
    songs.push({
      songKey, artist: c === 0 ? 'Artist A' : `Artist ${c}`, track: c === 1 ? `Rainy Night ${i}` : `Track ${i}`,
      genre: c === 0 ? 'Rock' : c === 1 ? 'Jazz' : 'Classical', year: c === 0 ? 1984 : c === 1 ? 1995 : 2005,
      bpm: 100 + c, key: `${c + 1}A`, energy: c * 0.2, duration: 180,
    });
    vectors.set(songKey, { vector, startVector: vector, endVector: vector });
  }
  return { songs, gemmaVectors: vectors, date: '2026-10-16' };
}
const keys = songs => songs.map(song => song.songKey);
const majority = (songs, prefix) => songs.filter(song => song.songKey.startsWith(prefix)).length;

test('artist, decade, genre, mood and text mixes expand around their matching Gemma cluster', () => {
  const ctx = fixture();
  assert.ok(majority(buildArtistMix('Artist A', ctx), 'c0-') >= 5);
  assert.ok(majority(buildDecadeMix(1980, ctx), 'c0-') >= 5);
  assert.ok(majority(buildGenreMix('Jazz', ctx), 'c1-') >= 5);
  assert.ok(majority(buildMoodMix('Melancholic', ctx), 'c1-') >= 5);
  assert.ok(majority(buildTextMix([0, 1, 0], ctx), 'c1-') >= 5);
  assert.ok(majority(buildTextMix([0, 1, 0], { ...ctx, textVector: [0, 0, 1] }), 'c2-') >= 5);
});

test('niche mix selects distant neutral songs and daily mixes are deterministic for a date', () => {
  const ctx = fixture(8);
  ctx.affinities = new Map(ctx.songs.map(song => [song.songKey, { score: 0 }]));
  const first = buildDailyMixes(ctx, { count: 3, size: 5 });
  const again = buildDailyMixes(ctx, { count: 3, size: 5 });
  assert.deepEqual(first.map(mix => keys(mix.songs)), again.map(mix => keys(mix.songs)));
  const niche = buildNicheMix(ctx);
  assert.equal(niche.length, 24);
});

test('devil mix includes every vector song once and improves over random order', () => {
  const ctx = fixture(10);
  const ordered = buildDevilMix({ ...ctx, timeBudgetMs: 500 });
  assert.deepEqual(new Set(keys(ordered)).size, ctx.songs.length);
  const opts = {};
  const cost = list => list.slice(1).reduce((sum, song, i) => {
    const before = list[i];
    const beforeVector = ctx.gemmaVectors.get(before.songKey).vector;
    const afterVector = ctx.gemmaVectors.get(song.songKey).vector;
    return sum + transitionCost({ vector: beforeVector, end: beforeVector, bpm: before.bpm, key: before.key, energy: before.energy }, { vector: afterVector, start: afterVector, bpm: song.bpm, key: song.key, energy: song.energy }, opts);
  }, 0);
  const randomOrder = [...ctx.songs].sort((a, b) => (Number(a.songKey.match(/-(\d+)/)?.[1]) * 7 + Number(a.songKey[1]) * 11)
    - (Number(b.songKey.match(/-(\d+)/)?.[1]) * 7 + Number(b.songKey[1]) * 11));
  assert.ok(cost(ordered) < cost(randomOrder));
});

test('6,000 song devil mix stays within five seconds and returns the full library', { timeout: 5000 }, () => {
  const ctx = fixture(2000);
  const start = performance.now();
  const result = buildDevilMix({ ...ctx, timeBudgetMs: 1800, totalBudgetMs: 2200 });
  assert.equal(result.length, 6000);
  assert.ok(performance.now() - start < 5000);
});

test('infinite mix avoids the last 50 songs and an early skip steers away from its direction', () => {
  const songs = [];
  const gemmaVectors = new Map();
  for (let i = 0; i < 70; i++) {
    const songKey = `s${i}`;
    const vector = i < 35 ? [1, 0] : [-1, 0];
    songs.push({ songKey, artist: `A${i}`, bpm: 120, key: '8A', energy: 0.5 });
    gemmaVectors.set(songKey, { vector, startVector: vector, endVector: vector });
  }
  const mix = createInfiniteMix({ songs, gemmaVectors }, { seedKey: 's0', rng: () => 0 });
  const first = mix.next();
  mix.observe({ eventType: 'user-skip', songKey: first.songKey, positionSeconds: 2 });
  const second = mix.next();
  assert.ok(gemmaVectors.get(second.songKey).vector[0] < 0);
  const resultKeys = [first.songKey, second.songKey];
  for (let i = 0; i < 49; i++) resultKeys.push(mix.next().songKey);
  assert.equal(new Set(resultKeys).size, resultKeys.length);
});

test('long mix respects durationSeconds and small-library radio keeps going', () => {
  const unitVec = i => Array.from({ length: 8 }, (_, d) => (d === i % 8 ? 1 : 0.1));
  const songs = Array.from({ length: 10 }, (_, i) => ({ songKey: `d${i}`, artist: `A${i}`, track: `T${i}`, durationSeconds: 3600 }));
  const gemmaVectors = new Map(songs.map((song, i) => [song.songKey, { vector: unitVec(i) }]));
  const long = buildLongMix({ songs, gemmaVectors, events: [] }, { minutes: 180 });
  assert.ok(long.length <= 3, `3 hours of 1-hour songs gave ${long.length}`);
  const radio = createInfiniteMix({ songs, gemmaVectors, events: [] }, { rng: () => 0.5 });
  const picks = Array.from({ length: 25 }, () => radio.next());
  assert.ok(picks.every(Boolean), 'radio stalled on a 10-song library');
});
