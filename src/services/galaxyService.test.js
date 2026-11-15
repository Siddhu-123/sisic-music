import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGalaxy,
  chooseGalaxySpace,
  clusterVectors,
  computeGalaxyTasteOverlay,
  describeGalaxyTrackAndTransition,
  frameCoordinates,
  labelCluster,
} from './galaxyService.js';

function audioVector(index, dims = 200) {
  const vector = new Array(dims).fill(0.01);
  vector[index] = 1;
  return vector;
}

const audioSong = (key, index) => ({
  songKey: key, track: key, artist: 'A', vector: audioVector(index), vectorType: 'learned-audio', model: 'msd-musicnn-1', dimensions: 200,
});

test('galaxy never mixes audio and metadata spaces', () => {
  const audio = Array.from({ length: 14 }, (_, i) => audioSong(`a${i}`, i % 3));
  const plain = Array.from({ length: 6 }, (_, i) => ({ songKey: `m${i}`, track: `Plain ${i}`, artist: 'B' }));
  const auto = chooseGalaxySpace([...audio, ...plain]);
  assert.equal(auto.mode, 'audio');
  assert.equal(auto.items.length, 14);
  assert.equal(auto.excluded, 6);
  assert.ok(auto.items.every(item => item.vector.length === 200));

  const metadata = chooseGalaxySpace([...audio, ...plain], { preference: 'metadata' });
  assert.equal(metadata.mode, 'metadata');
  assert.ok(metadata.items.every(item => item.vector.length === 64));

  const tooFew = chooseGalaxySpace([...audio.slice(0, 3), ...plain]);
  assert.equal(tooFew.mode, 'metadata');
  assert.equal(tooFew.audio, null);
});

test('clustering separates obvious groups and is deterministic', () => {
  const vectors = [...Array.from({ length: 10 }, () => [1, 0, 0]), ...Array.from({ length: 10 }, () => [0, 1, 0])];
  const first = clusterVectors(vectors, { k: 2 });
  const second = clusterVectors(vectors, { k: 2 });
  assert.deepEqual(first, second);
  assert.equal(new Set(first.assignments.slice(0, 10)).size, 1);
  assert.notEqual(first.assignments[0], first.assignments[10]);
});

test('framing centres the cloud and keeps every point inside the unit sphere', () => {
  const coords = [...Array.from({ length: 40 }, (_, i) => [5 + i * 0.01, 5 + (i % 3), 5 - (i % 5)]), [500, 5, 5]];
  const framed = frameCoordinates(coords);
  assert.ok(Math.abs(framed[20][0]) < 0.2);
  assert.ok(framed.every(point => Math.hypot(...point) <= 1 + 1e-9));
  assert.ok(Math.abs(Math.hypot(...framed.at(-1)) - 1) < 1e-9);
});

test('clusters get readable labels and every point is placed', () => {
  assert.equal(labelCluster([{ artist: 'X', track: 'Chill lofi one' }, { artist: 'X', track: 'Chill two' }]), 'Chill · X');
  const galaxy = buildGalaxy(Array.from({ length: 20 }, (_, i) => ({ songKey: `s${i}`, track: `Song ${i}`, artist: `Artist ${i % 4}` })));
  assert.equal(galaxy.points.length, 20);
  assert.ok(galaxy.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)));
  assert.ok(galaxy.clusters.length >= 1 && galaxy.clusters.every(cluster => cluster.label));
});

test('a genre wins a tie against a mood when naming a cluster', () => {
  const songs = [
    { artist: 'A', track: 'Study one', genre: 'Jazz' },
    { artist: 'B', track: 'Study two', genre: 'Jazz' },
    { artist: 'C', track: 'Study three', genre: 'Jazz' },
  ];
  // "Study" also reads as the Focus mood for all three; the genre should still name the cluster.
  assert.equal(labelCluster(songs), 'Jazz');
});

test('galaxy reads vectors from gemmaVectors map and computes focus/shift overlay', () => {
  const songs = Array.from({ length: 16 }, (_, i) => ({
    songKey: `s${i}`,
    track: `Song ${i}`,
    artist: i < 8 ? 'A' : 'B',
  }));
  const gemmaVectors = new Map(songs.map((s, i) => [
    s.songKey,
    {
      songKey: s.songKey,
      embeddingModel: 'sisic-recs-v3/softwhiten-128d-int8',
      dimensions: 32,
      vector: audioVector(i < 8 ? 0 : 1, 32),
    },
  ]));
  const galaxy = buildGalaxy(songs, { gemmaVectors });
  assert.equal(galaxy.mode, 'audio');
  assert.equal(galaxy.audio.count, 16);

  const now = Date.now();
  const events = [
    { songKey: 's8', eventType: 'playback-complete', positionSeconds: 180, durationSeconds: 180, createdAt: now - 1000 * 60 * 60 * 24 * 12 },
    { songKey: 's0', eventType: 'playback-replay', positionSeconds: 180, durationSeconds: 180, createdAt: now - 1000 * 60 * 60 },
    { songKey: 's14', eventType: 'user-skip', positionSeconds: 2, durationSeconds: 180, createdAt: now - 1000 * 30 },
  ];
  const overlay = computeGalaxyTasteOverlay(galaxy.points, {
    mode: galaxy.mode,
    gemmaVectors,
    playbackEvents: events,
    likedSongKeys: ['s0'],
    now,
  });
  assert.equal(overlay.hasSignal, true);
  assert.ok(overlay.edges.length > 0);
  const risingFocus = overlay.metricsByKey.get('s0');
  const skipped = overlay.metricsByKey.get('s14');
  assert.ok(risingFocus.focus > skipped.focus);
  assert.ok(risingFocus.delta > skipped.delta);
  assert.equal(skipped.status, 'skipped');
});

test('describeGalaxyTrackAndTransition extracts traits and seam/sound transition metrics', () => {
  const prevPoint = {
    songKey: 'a', track: 'Warmup', artist: 'Artist A', bpm: 120, energy: 0.45,
    genre: 'Electronic', clusterId: 0,
  };
  const currentPoint = {
    songKey: 'b', track: 'Peak Set', artist: 'Artist B', bpm: 128, musicalKey: 'A minor',
    energy: 0.82, genre: 'Electronic', clusterId: 1,
  };
  const gemmaVectors = new Map([
    ['a', { songKey: 'a', vector: audioVector(0, 16), startVector: audioVector(0, 8), endVector: audioVector(1, 8), dimensions: 16 }],
    ['b', { songKey: 'b', vector: audioVector(0, 16), startVector: audioVector(1, 8), endVector: audioVector(2, 8), dimensions: 16 }],
  ]);
  const info = describeGalaxyTrackAndTransition(currentPoint, {
    prevPoint,
    cluster: { label: 'Electronic · High Energy', songs: [currentPoint, prevPoint] },
    gemmaVectors,
  });
  assert.equal(info.genre, 'Electronic');
  assert.equal(info.bpm, 128);
  assert.equal(info.musicalKey, 'A minor');
  assert.equal(info.energyPct, 82);
  assert.equal(info.clusterLabel, 'Electronic · High Energy');
  assert.equal(info.transition.fromTrack, 'Warmup');
  assert.equal(info.transition.sameCluster, false);
  assert.equal(info.transition.bpmDelta, 8);
  assert.ok(info.transition.soundMatchPct > 90);
  assert.ok(info.transition.seamMatchPct > 90);
});
