import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGalaxy, chooseGalaxySpace, clusterVectors, frameCoordinates, labelCluster } from './galaxyService.js';

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
