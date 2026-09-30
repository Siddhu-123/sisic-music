import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSongEmbedding,
  cosineSimilarity,
  findSimilarSongs,
  computeTasteCentroid,
  projectEmbeddingsTo2D,
  projectEmbeddingsTo3D,
  kMeansCluster,
  EMBEDDING_DIMENSIONS,
} from './tasteEmbeddingService.js';

test('computeSongEmbedding produces unit normalized 64D vector', () => {
  const vec = computeSongEmbedding({ artist: 'Daft Punk', track: 'Around The World' });
  assert.strictEqual(vec.length, EMBEDDING_DIMENSIONS);

  // Check L2 norm equals 1.0 +- 0.001
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  assert.ok(Math.abs(norm - 1.0) < 0.001);
});

test('cosineSimilarity calculates exact dot product within [-1, 1]', () => {
  const vec1 = computeSongEmbedding({ artist: 'Radiohead', track: 'Creep' });
  const vec2 = computeSongEmbedding({ artist: 'Radiohead', track: 'Karma Police' });
  const vec3 = computeSongEmbedding({ artist: 'Tchaikovsky', track: 'Swan Lake' });

  const selfSim = cosineSimilarity(vec1, vec1);
  const sameArtistSim = cosineSimilarity(vec1, vec2);
  const diffGenreSim = cosineSimilarity(vec1, vec3);

  assert.ok(Math.abs(selfSim - 1.0) < 0.001);
  assert.ok(sameArtistSim > diffGenreSim, 'Same artist tracks have higher similarity than classical symphony');
});

test('findSimilarSongs returns ranked matches excluding target', () => {
  const target = { songKey: 'daft punk::one more time', artist: 'Daft Punk', track: 'One More Time' };
  const library = [
    { songKey: 'daft punk::one more time', artist: 'Daft Punk', track: 'One More Time' },
    { songKey: 'daft punk::harder better faster', artist: 'Daft Punk', track: 'Harder Better Faster Stronger' },
    { songKey: 'justice::genesis', artist: 'Justice', track: 'Genesis' },
    { songKey: 'beethoven::symphony 5', artist: 'Beethoven', track: 'Symphony No. 5' },
  ];

  const results = findSimilarSongs(target, library, { limit: 2 });
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].songKey, 'daft punk::harder better faster');
  assert.ok(results[0].similarityScore > results[1].similarityScore);
});

test('computeTasteCentroid computes average normalized vector of song list', () => {
  const songs = [
    { artist: 'Artist A', track: 'Track 1' },
    { artist: 'Artist B', track: 'Track 2' },
  ];
  const centroid = computeTasteCentroid(songs);
  assert.strictEqual(centroid.length, EMBEDDING_DIMENSIONS);
  const norm = Math.sqrt(centroid.reduce((sum, v) => sum + v * v, 0));
  assert.ok(Math.abs(norm - 1.0) < 0.001);
});

test('projectEmbeddingsTo2D projects N items into 2D coordinates', () => {
  const songs = [
    { artist: 'Artist A', track: 'Track 1' },
    { artist: 'Artist B', track: 'Track 2' },
    { artist: 'Artist C', track: 'Track 3' },
  ];
  const projected = projectEmbeddingsTo2D(songs);
  assert.strictEqual(projected.length, 3);
  for (const item of projected) {
    assert.ok(typeof item.coordX === 'number');
    assert.ok(typeof item.coordY === 'number');
  }
});

test('cluster view projects songs to 3D and assigns bounded k-means groups', () => {
  const songs = [
    { songKey: 'a', artist: 'Artist A', track: 'Track 1' },
    { songKey: 'b', artist: 'Artist B', track: 'Track 2' },
    { songKey: 'c', artist: 'Artist C', track: 'Track 3' },
    { songKey: 'd', artist: 'Artist D', track: 'Track 4' },
  ];
  const clustered = kMeansCluster(songs, { k: 2, maxClusters: 8 });
  const projected = projectEmbeddingsTo3D(clustered);
  assert.strictEqual(projected.length, songs.length);
  assert.ok(new Set(clustered.map(song => song.clusterId)).size <= 2);
  for (const item of projected) {
    assert.ok(Number.isFinite(item.coordX));
    assert.ok(Number.isFinite(item.coordY));
    assert.ok(Number.isFinite(item.coordZ));
    assert.ok(item.clusterSize >= 1);
  }
});

test('artist identity outweighs unrelated titles and mood markers match whole words', () => {
  const a = computeSongEmbedding({ artist: 'Artist One', track: 'Morning Light' });
  const b = computeSongEmbedding({ artist: 'Artist One', track: 'Completely Different' });
  const c = computeSongEmbedding({ artist: 'Someone Else', track: 'Morning Lights' });
  assert.ok(cosineSimilarity(a, b) > cosineSimilarity(a, computeSongEmbedding({ artist: 'Third', track: 'Completely Different' })));
  assert.ok(cosineSimilarity(a, c) > 0);
  const therapy = computeSongEmbedding({ artist: 'Z', track: 'Therapy' });
  const rap = computeSongEmbedding({ artist: 'Q', track: 'Rap Song' });
  const rap2 = computeSongEmbedding({ artist: 'W', track: 'Another Rap' });
  assert.ok(cosineSimilarity(rap, rap2) > cosineSimilarity(therapy, rap2));
});

test('getSongEmbedding ignores stale v1 and audio vectors but keeps current ones', async () => {
  const { getSongEmbedding, METADATA_EMBEDDING_MODEL } = await import('./tasteEmbeddingService.js');
  const song = { artist: 'A', track: 'T' };
  const fresh = computeSongEmbedding(song);
  const stored = new Array(64).fill(0).map((_, i) => (i === 0 ? 1 : 0));
  assert.deepEqual(getSongEmbedding({ ...song, vector: stored, embeddingModel: 'metadata-ngram-v1' }), fresh);
  assert.deepEqual(getSongEmbedding({ ...song, vector: stored, embeddingProvider: 'sisic-client' }), fresh);
  assert.deepEqual(getSongEmbedding({ ...song, vector: new Array(200).fill(0.07), vectorType: 'learned-audio' }), fresh);
  assert.equal(getSongEmbedding({ ...song, vector: stored, embeddingModel: METADATA_EMBEDDING_MODEL }), stored);
});
