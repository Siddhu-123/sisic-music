import assert from 'node:assert/strict';
import test from 'node:test';
import { db } from '../db.js';
import {
  GEMMA2_DIMENSIONS,
  GEMMA2_MODEL,
  gemmaNeighbors,
  importGemmaVectors,
  matchExportToLibrary,
  queryTextVector,
  syncGemmaVectorsFromService,
} from './gemmaVectors.js';

const vector = (index, dims = GEMMA2_DIMENSIONS) => Array.from({ length: dims }, (_, i) => i === index ? 3 : 0);

test('matches exact song keys first and falls back to artist and title or filename', () => {
  const library = [
    { songKey: 'exact', artist: 'Other', track: 'Other' },
    { songKey: 'normalized', artist: 'SYML', track: "Where's My Love" },
  ];
  const { matches, unmatched } = matchExportToLibrary([
    { songKey: 'exact', artist: 'wrong', title: 'wrong' },
    { songKey: 'tag-format-key', artist: 'SYML', filename: "Where's My Love.flac" },
    { songKey: 'missing', artist: 'No One', title: 'No Song' },
  ], library);
  assert.equal(matches[0].song.songKey, 'exact');
  assert.equal(matches[1].song.songKey, 'normalized');
  assert.equal(unmatched.length, 1);
});

test('validates model and dimensions and imports normalized vectors without touching MusiCNN storage', async () => {
  const originalPut = db.songVectors.put;
  const saved = [];
  db.songVectors.put = async row => saved.push(row);
  try {
    const library = [{ songKey: 'a', artist: 'A', track: 'One' }, { songKey: 'b', artist: 'B', track: 'Two' }];
    const result = await importGemmaVectors({
      model: GEMMA2_MODEL,
      dimensions: GEMMA2_DIMENSIONS,
      songs: [
        { songKey: 'a', model: GEMMA2_MODEL, vector: vector(0), startVector: vector(0, 128), endVector: null, fileHash: 'hash-a', clipCount: 3 },
        { songKey: 'b', model: GEMMA2_MODEL, vector: [0], fileHash: 'invalid' },
        { songKey: 'missing', vector: vector(0) },
      ],
    }, library);
    assert.deepEqual(result, { imported: 1, unmatched: 1, skipped: 1 });
    assert.equal(saved[0].embeddingModel, GEMMA2_MODEL);
    assert.equal(saved[0].fileHash, 'hash-a');
    assert.equal(saved[0].clipCount, 3);
    assert.equal(saved[0].startVector[0], 1);
    assert.equal(saved[0].endVector, null);
    assert.deepEqual(await importGemmaVectors({ model: 'msd-musicnn-1', dimensions: 200, songs: [] }, library), {
      imported: 0, unmatched: 0, skipped: 0,
    });
  } finally {
    db.songVectors.put = originalPut;
  }
});

test('sync pages with bearer auth, persists only the cursor, and never writes token to storage', async () => {
  const originalVectorPut = db.songVectors.put;
  const originalMetadataPut = db.metadata.put;
  const saved = [];
  const metadata = [];
  const storageWrites = [];
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = { setItem: (...args) => storageWrites.push(args) };
  db.songVectors.put = async row => saved.push(row);
  db.metadata.put = async row => metadata.push(row);
  const calls = [];
  const pages = [
    { cursor: 'c1', songs: [{ songKey: 'a', model: GEMMA2_MODEL, vector: vector(0), fileHash: 'a' }] },
    { cursor: 'c2', songs: [] },
  ];
  try {
    const result = await syncGemmaVectorsFromService({
      baseUrl: 'https://vectors.example/api', token: 'private-token', since: 'c0',
      librarySongs: [{ songKey: 'a', artist: 'A', track: 'One' }],
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => pages.shift() };
      },
    });
    assert.deepEqual(result, { cursor: 'c2', imported: 1, unmatched: 0, skipped: 0 });
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /since=c0/);
    assert.match(calls[0].url, /dims=256/);
    assert.equal(calls[0].options.headers.Authorization, 'Bearer private-token');
    assert.deepEqual(metadata.map(row => row.value), ['c1', 'c2']);
    assert.equal(storageWrites.length, 0);
    assert.equal(saved.length, 1);
    const query = await queryTextVector({
      baseUrl: 'https://vectors.example', token: 'private-token', text: 'ambient',
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => ({ vector: vector(0) }) };
      },
    });
    assert.equal(query.vector.length, GEMMA2_DIMENSIONS);
    assert.deepEqual(JSON.parse(calls[2].options.body), { text: 'ambient' });
    assert.equal(storageWrites.length, 0);
  } finally {
    db.songVectors.put = originalVectorPut;
    db.metadata.put = originalMetadataPut;
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
  }
});

test('ranks cosine neighbours by whole-song vector and ignores boundary vectors', () => {
  const rows = [
    { songKey: 'seed', embeddingModel: GEMMA2_MODEL, vector: vector(0), startVector: vector(1, 128) },
    { songKey: 'close', embeddingModel: GEMMA2_MODEL, vector: vector(0), endVector: vector(2, 128) },
    { songKey: 'far', embeddingModel: GEMMA2_MODEL, vector: vector(1) },
    { songKey: 'other-space', embeddingModel: 'msd-musicnn-1', vector: vector(0) },
  ];
  assert.deepEqual(gemmaNeighbors('seed', rows, 5).map(row => row.songKey), ['close', 'far']);
  assert.deepEqual(gemmaNeighbors('unknown', rows), []);
});

test('rejects vectors with null or string entries and keeps only the first record per song', async () => {
  const originalPut = db.songVectors.put;
  const saved = [];
  db.songVectors.put = async row => saved.push(row);
  try {
    const bad = vector(0); bad[5] = null;
    const result = await importGemmaVectors({
      model: GEMMA2_MODEL, dimensions: GEMMA2_DIMENSIONS,
      songs: [
        { songKey: 'a', vector: bad },
        { songKey: 'b', vector: vector(1) },
        { songKey: 'b', vector: vector(2) },
      ],
    }, [{ songKey: 'a', artist: 'A', track: 'One' }, { songKey: 'b', artist: 'B', track: 'Two' }]);
    assert.equal(result.imported, 1);
    assert.equal(result.skipped, 1);
    assert.equal(saved[0].vector[1], 1);
  } finally {
    db.songVectors.put = originalPut;
  }
});

test('sync holds the cursor when a page has rows not yet in the library', async () => {
  const originalGet = db.metadata.get;
  const originalPut = db.metadata.put;
  const originalVectorPut = db.songVectors.put;
  const cursors = [];
  db.metadata.get = async () => null;
  db.metadata.put = async row => cursors.push(row.value);
  db.songVectors.put = async () => {};
  const pages = [
    { songs: [{ songKey: 'known', vector: vector(0) }], cursor: 'c1' },
    { songs: [{ songKey: 'not-loaded-yet', vector: vector(1) }], cursor: 'c2' },
    { songs: [{ songKey: 'known2', vector: vector(2) }], cursor: 'c3' },
    { songs: [], cursor: 'c3' },
  ];
  let call = 0;
  const fetchImpl = async () => ({ ok: true, json: async () => pages[call++] });
  try {
    const result = await syncGemmaVectorsFromService({
      baseUrl: 'https://svc', token: 't', fetchImpl,
      librarySongs: [{ songKey: 'known', artist: 'K', track: 'K' }, { songKey: 'known2', artist: 'L', track: 'L' }],
    });
    assert.equal(result.imported, 2);
    assert.deepEqual(cursors, ['c1']);
  } finally {
    db.metadata.get = originalGet;
    db.metadata.put = originalPut;
    db.songVectors.put = originalVectorPut;
  }
});
