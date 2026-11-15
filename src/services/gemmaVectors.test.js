import assert from 'node:assert/strict';
import test from 'node:test';
import { db } from '../db.js';
import { getPreferredVectorSpace, loadLearnedAudioEmbeddings } from './embeddingService.js';
import { transitionCost } from './flowPath.js';
import {
  GEMMA2_DIMENSIONS,
  GEMMA2_MODEL,
  RECS_V3_BOUNDARY_DIMENSIONS,
  RECS_V3_DIMENSIONS,
  RECS_V3_MODEL,
  decodeInt8Base64Unit,
  gemmaNeighbors,
  importGemmaVectors,
  loadPreferredSongVectors,
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
  const originalBulkPut = db.songVectors.bulkPut;
  db.songVectors.bulkPut = async rows => { saved.push(...rows); };
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
    db.songVectors.bulkPut = originalBulkPut;
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
  const originalBulkPut = db.songVectors.bulkPut;
  db.songVectors.bulkPut = async rows => { saved.push(...rows); };
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
    db.songVectors.bulkPut = originalBulkPut;
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
  const originalBulkPut = db.songVectors.bulkPut;
  db.songVectors.bulkPut = async rows => { saved.push(...rows); };
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
    db.songVectors.bulkPut = originalBulkPut;
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
  const originalBulkPut = db.songVectors.bulkPut;
  db.songVectors.bulkPut = async () => {};
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
    db.songVectors.bulkPut = originalBulkPut;
  }
});

test('matchExportToLibrary uses filenames for untagged files and pruning keeps every fuzzy match', async () => {
  const { findSimilarSongMatch, getSongKey } = await import('../songIdentity.js');
  const library = [
    { songKey: getSongKey({ artist: 'Rihanna', track: 'S&M' }), artist: 'Rihanna', track: 'S&M', filename: 'Rihanna - S&M.mp3' },
    { songKey: getSongKey({ artist: 'Teddy Swims', track: 'Lose Control' }), artist: 'Teddy Swims', track: 'Lose Control', filename: 'x.mp3' },
    { songKey: getSongKey({ artist: 'Hans Zimmer', track: 'Time' }), artist: 'Hans Zimmer', track: 'Time', filename: 'Hans Zimmer - Time (From Inception).m4a' },
  ];
  const records = [
    { songKey: 'unknown artist::hans zimmer time from inception', artist: '', title: 'Hans Zimmer - Time (From Inception)', filename: 'Hans Zimmer - Time (From Inception).m4a' },
    { songKey: 'unknown artist::teddy swims lose control', artist: '', title: 'Teddy Swims - Lose Control', filename: 'Teddy Swims - Lose Control.mp3' },
    { songKey: 'rihana::s and m', artist: 'Rihanna feat. Nobody', title: 'S&M', filename: 'other.mp3' },
  ];
  const { matches, unmatched } = matchExportToLibrary(records, library);
  assert.deepEqual(matches.map(m => m.song.track), ['Time', 'Lose Control', 'S&M']);
  assert.equal(unmatched.length, 0);
  // Pruned candidate search must agree with a scan of the whole library.
  for (const record of records.slice(2)) {
    const full = findSimilarSongMatch({ artist: record.artist, track: record.title }, library, 'high');
    assert.equal(full?.song, matches.find(m => m.record === record)?.song);
  }
});

test('matchExportToLibrary strips import-source and Unknown Artist filename prefixes safely', () => {
  const library = [
    { songKey: 'k1', artist: 'Rex Orange County', track: 'Pluto Projector', filename: 'sisic-import-source-30cac848-7871-4f6b-97ed-f1c852632e74-Rex Orange County - Pluto Projector.mp3' },
    { songKey: 'k2', artist: 'Unknown Artist', track: 'Pathikichu', filename: 'Unknown Artist - Pathikichu.mp3' },
    { songKey: 'unknown artist::martin 1', artist: 'Unknown Artist', track: 'Martin 1', filename: 'Unknown Artist - Martin 1.mp3' },
    { songKey: 'unknown artist::martin 3', artist: 'Unknown Artist', track: 'Martin 3', filename: 'Unknown Artist - Martin 3.mp3' },
  ];
  const records = [
    { songKey: 'other1', artist: '', title: 'Pluto Projector', filename: 'Rex Orange County - Pluto Projector.mp3' },
    { songKey: 'other2', artist: 'Anirudh Ravichander', title: 'Pathikichu', filename: 'Pathikichu.mp3' },
    { songKey: 'unknown artist::martin 3', artist: '', title: 'Martin 3', filename: 'Martin 3.mp3' },
    { songKey: 'unknown artist::martin 1', artist: '', title: 'Martin 1', filename: 'Martin 1.mp3' },
  ];
  const { matches, unmatched } = matchExportToLibrary(records, library);
  const bySong = Object.fromEntries(matches.map(m => [m.song.songKey, m.record.songKey]));
  assert.equal(bySong.k1, 'other1');
  assert.equal(bySong.k2, 'other2');
  assert.equal(bySong['unknown artist::martin 1'], 'unknown artist::martin 1');
  assert.equal(bySong['unknown artist::martin 3'], 'unknown artist::martin 3');
  assert.equal(unmatched.length, 0);
});

test('imports Recommender v3 int8 base64 vectors and boundary vectors with high cosine fidelity', async () => {
  const originalBulkPut = db.songVectors.bulkPut;
  const originalPut = db.songVectors.put;
  const saved = [];
  db.songVectors.bulkPut = async rows => { saved.push(...rows); };
  db.songVectors.put = async row => { saved.push(row); };

  const encodeI8 = (arr) => {
    const maxAbs = Math.max(...arr.map(Math.abs), 1e-8);
    const scale = maxAbs / 127;
    const i8 = Int8Array.from(arr.map(v => Math.max(-127, Math.min(127, Math.round(v / scale)))));
    return {
      b64: globalThis.Buffer.from(i8.buffer).toString('base64'),
      scale,
    };
  };

  try {
    const rawVec = Array.from({ length: RECS_V3_DIMENSIONS }, (_, i) => (i === 0 ? 0.8 : (i === 1 ? 0.6 : 0)));
    const startVec = Array.from({ length: RECS_V3_BOUNDARY_DIMENSIONS }, (_, i) => (i === 2 ? 1 : 0));
    const endVec = Array.from({ length: RECS_V3_BOUNDARY_DIMENSIONS }, (_, i) => (i === 3 ? 1 : 0));
    const vEnc = encodeI8(rawVec);
    const sEnc = encodeI8(startVec);
    const eEnc = encodeI8(endVec);

    const direct = decodeInt8Base64Unit(vEnc.b64, vEnc.scale, RECS_V3_DIMENSIONS);
    assert.ok(Math.abs(direct[0] - 0.8) < 0.02 && Math.abs(direct[1] - 0.6) < 0.02);

    const res = await importGemmaVectors({
      model: RECS_V3_MODEL,
      dimensions: RECS_V3_DIMENSIONS,
      boundaryDimensions: RECS_V3_BOUNDARY_DIMENSIONS,
      encoding: 'int8-b64',
      songs: [
        {
          songKey: 'v3-song',
          fileHash: 'fh-1',
          vectorI8: vEnc.b64,
          vectorScale: vEnc.scale,
          startI8: sEnc.b64,
          startScale: sEnc.scale,
          endI8: eEnc.b64,
          endScale: eEnc.scale,
        },
      ],
    }, [{ songKey: 'v3-song', artist: 'A', track: 'One' }]);

    assert.deepEqual(res, { imported: 1, unmatched: 0, skipped: 0 });
    assert.equal(saved[0].embeddingModel, RECS_V3_MODEL);
    assert.equal(saved[0].dimensions, RECS_V3_DIMENSIONS);
    assert.equal(saved[0].startVector.length, RECS_V3_BOUNDARY_DIMENSIONS);
    assert.ok(saved[0].endVector[3] > 0.99);
    assert.equal(typeof loadPreferredSongVectors, 'function');

    const space = getPreferredVectorSpace(saved);
    assert.equal(space.model, RECS_V3_MODEL);
    assert.equal(space.dimensions, RECS_V3_DIMENSIONS);

    const viaLoader = await loadLearnedAudioEmbeddings({
      model: RECS_V3_MODEL,
      dimensions: RECS_V3_DIMENSIONS,
      boundaryDimensions: RECS_V3_BOUNDARY_DIMENSIONS,
      encoding: 'int8-b64',
      songs: [{ songKey: 'v3-song', vectorI8: vEnc.b64, vectorScale: vEnc.scale }],
    }, [{ songKey: 'v3-song', artist: 'A', track: 'One' }]);
    assert.equal(viaLoader.imported, 1);

    // Mismatched 64d end vs 128d full fallback vector falls back cleanly to 128d vector cosine
    const global128A = new Array(128).fill(0);
    global128A[100] = 1;
    const global128B = new Array(128).fill(0);
    global128B[100] = 1;
    const end64A = new Array(64).fill(0);
    end64A[0] = 1;
    const costMatchGlobal = transitionCost(
      { vector: global128A, end: end64A, bpm: 120, key: '8A', energy: 0.5 },
      { vector: global128B, start: null, bpm: 120, key: '8A', energy: 0.5 },
    );
    assert.ok(Math.abs(costMatchGlobal - 0) < 1e-6);
  } finally {
    db.songVectors.bulkPut = originalBulkPut;
    db.songVectors.put = originalPut;
  }
});
