import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCandidateIndex,
  DEFAULT_FULL_SCAN_THRESHOLD,
  selectStage1Candidates,
} from './candidateIndex.js';
import {
  buildContextualTasteProfile,
  rankContextualSongs,
} from './contextualRecommendationService.js';
import { gemmaNeighbors, RECS_V3_MODEL } from './gemmaVectors.js';

function makeClusteredVectors(n, dims, nTopics = 40, spread = 0.22, seed = 1337) {
  let s = seed >>> 0;
  const rand = () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296);
  const gauss = () => {
    const u1 = Math.max(1e-7, rand());
    const u2 = rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  const norm = v => {
    let ss = 0;
    for (let i = 0; i < v.length; i++) ss += v[i] * v[i];
    const inv = 1 / (Math.sqrt(ss) || 1);
    for (let i = 0; i < v.length; i++) v[i] *= inv;
    return v;
  };
  const centers = Array.from({ length: nTopics }, () => {
    const v = new Float32Array(dims);
    for (let d = 0; d < dims; d++) v[d] = gauss();
    return norm(v);
  });
  const vecs = new Array(n);
  for (let i = 0; i < n; i++) {
    const c = centers[i % nTopics];
    const v = new Float32Array(dims);
    for (let d = 0; d < dims; d++) v[d] = c[d] + spread * gauss();
    vecs[i] = norm(v);
  }
  return { centers, vecs };
}

test('libraries below 8,000 tracks stay on full-scan path untouched', () => {
  const { vecs } = makeClusteredVectors(500, 32, 10);
  const songs = vecs.map((v, i) => ({ songKey: `s-${i}`, track: `T${i}`, artist: `A${i}`, vector: v, dimensions: 32 }));
  const res = selectStage1Candidates(songs, {
    queryVectors: [{ vector: vecs[0], weight: 1 }],
    fullScanBelow: DEFAULT_FULL_SCAN_THRESHOLD,
  });
  assert.equal(res.mode, 'full-scan');
  assert.equal(res.candidates.length, 500);
});

test('alwaysIncludeKeys retains liked, recently played, and queued songs regardless of cluster', () => {
  const { vecs } = makeClusteredVectors(600, 32, 20);
  const songs = vecs.map((v, i) => ({ songKey: `s-${i}`, track: `T${i}`, artist: `A${i}`, vector: v, dimensions: 32 }));
  const idx = buildCandidateIndex(songs, { getVector: s => s.vector, nClusters: 24 });
  const forcedKeys = ['s-19', 's-399', 's-555'];
  const stage1 = selectStage1Candidates(idx, {
    queryVectors: [{ vector: vecs[0], weight: 1 }],
    targetSize: 60,
    fullScanBelow: 100,
    alwaysIncludeKeys: forcedKeys,
  });
  assert.equal(stage1.mode, 'ivf-stage1');
  const gotKeys = new Set(stage1.candidates.map(s => s.songKey));
  for (const key of forcedKeys) assert.ok(gotKeys.has(key), `expected alwaysIncludeKey ${key}`);
});

test('Stage-1 candidate recall >= 95% of flat-scan top-60 and Stage-1 latency < 10ms on 55,000 songs', () => {
  const N = 55000;
  const dims = 128;
  // In 128D, per-coordinate sigma=0.055 gives noise L2 norm ~0.62 relative to unit centroids.
  const { centers, vecs } = makeClusteredVectors(N, dims, 80, 0.055, 2026);
  const songs = vecs.map((v, i) => ({
    songKey: `song-${i}`,
    track: `Track ${i}`,
    artist: `Artist ${i % 1200}`,
    driveFileId: `f-${i}`,
    vector: v,
    dimensions: dims,
    playCount: i % 500 === 0 ? 12 : 0,
  }));

  const tBuildStart = performance.now();
  const idx = buildCandidateIndex(songs, { getVector: s => s.vector, maxIters: 6 });
  const buildMs = performance.now() - tBuildStart;
  assert.ok(idx.k >= 235 && idx.k <= 768, `expected ~500 tight clusters, got ${idx.k}`);
  assert.ok(buildMs < 5000, `index build took ${buildMs.toFixed(1)}ms`);

  // Listener with 3 active topic interests + current session + liked songs
  const likedSongKeys = ['song-3', 'song-55', 'song-4012'];
  const events = [
    { eventType: 'playback-complete', songKey: 'song-0', createdAt: '2026-11-10T10:00:00Z' },
    { eventType: 'playback-complete', songKey: 'song-1', createdAt: '2026-11-10T10:04:00Z' },
    { eventType: 'playback-complete', songKey: 'song-2', createdAt: '2026-11-10T10:08:00Z' },
    { eventType: 'playback-complete', songKey: 'song-80', createdAt: '2026-11-10T10:12:00Z' },
    { eventType: 'playback-complete', songKey: 'song-160', createdAt: '2026-11-10T10:16:00Z' },
  ];
  const gemmaMap = new Map(songs.map(s => [s.songKey, { vector: s.vector, embeddingModel: RECS_V3_MODEL }]));
  const now = Date.parse('2026-11-10T10:20:00Z');
  const profile = buildContextualTasteProfile(songs, events, {
    targetSpace: 'gemma',
    targetModel: RECS_V3_MODEL,
    targetDimensions: dims,
    gemmaVectors: gemmaMap,
    likedSongKeys,
    now,
  });

  // Ground truth flat-scan top 60
  const flatTop60 = rankContextualSongs(songs, {
    profile,
    likedSongKeys,
    gemmaVectors: gemmaMap,
    now,
    limit: 60,
    fullScanBelow: Infinity,
  });
  const flatKeys = new Set(flatTop60.map(s => s.songKey));

  // Warm + measure Stage-1 candidate generation on 55K tracks
  const queries = [
    ...(profile.vector ? [{ vector: profile.vector, weight: 1.0 }] : []),
    ...(profile.recentVector ? [{ vector: profile.recentVector, weight: 0.95 }] : []),
    ...((profile.interests || []).map(i => ({ vector: i.vector, weight: Math.max(0.5, i.weight || 0.7) }))),
    { vector: centers[0], weight: 1.0 },
  ];
  selectStage1Candidates(idx, {
    queryVectors: queries,
    targetSize: 3000,
    fullScanBelow: 8000,
    alwaysIncludeKeys: likedSongKeys,
  });

  const times = [];
  let recallRatio = 0;
  for (let trial = 0; trial < 5; trial++) {
    const t0 = performance.now();
    const s1 = selectStage1Candidates(idx, {
      queryVectors: queries,
      targetSize: 3000,
      fullScanBelow: 8000,
      alwaysIncludeKeys: likedSongKeys,
    });
    times.push(performance.now() - t0);
    const s1Set = new Set(s1.candidates.map(s => s.songKey));
    let hits = 0;
    for (const k of flatKeys) if (s1Set.has(k)) hits++;
    recallRatio = hits / flatKeys.size;
  }
  const avgMs = times.reduce((a, b) => a + b, 0) / times.length;
  assert.ok(recallRatio >= 0.95, `expected >= 0.95 Stage-1 recall of flat top-60, got ${recallRatio}`);
  assert.ok(avgMs < 10, `expected Stage-1 < 10ms on 55K songs, got ${avgMs.toFixed(2)}ms`);

  // Verify gemmaNeighbors seamlessly uses Stage 1 at >= 8,000 rows and finds true nearest neighbors
  const rowPool = songs.slice(0, 9000).map(s => ({
    songKey: s.songKey,
    embeddingModel: RECS_V3_MODEL,
    dimensions: dims,
    vector: Array.from(s.vector),
  }));
  const nbrs = gemmaNeighbors('song-0', rowPool, 5, { fullScanBelow: 8000, stage1Limit: 1000 });
  assert.equal(nbrs.length, 5);
  assert.ok(nbrs[0].similarityScore > 0.7);
});
