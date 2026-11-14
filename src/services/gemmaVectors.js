import { db, getSongVectors, saveSongVectors } from '../db.js';
import { findSimilarSongMatch, getSongKey, tokenSet } from '../songIdentity.js';

export const GEMMA2_MODEL = 'embeddinggemma-2@fp32/clip30/v1';
export const GEMMA2_DIMENSIONS = 256;
export const RECS_V3_MODEL = 'sisic-recs-v3/softwhiten-128d-int8';
export const RECS_V3_DIMENSIONS = 128;
export const RECS_V3_BOUNDARY_DIMENSIONS = 64;
const BOUNDARY_DIMENSIONS = 128;
const CURSOR_KEY = `gemmaVectorsCursor:${GEMMA2_MODEL}`;

function decodeBase64Bytes(b64) {
  if (typeof b64 !== 'string' || !b64) return null;
  try {
    if (typeof globalThis.Buffer !== 'undefined') {
      const buf = globalThis.Buffer.from(b64, 'base64');
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export function decodeInt8Base64Unit(b64, scale = 1, expectedDims = null) {
  const bytes = decodeBase64Bytes(b64);
  if (!bytes || (expectedDims != null && bytes.length !== expectedDims) || bytes.length === 0) return null;
  const s = Number.isFinite(Number(scale)) && Number(scale) > 0 ? Number(scale) : 1;
  const view = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Array(view.length);
  let normSq = 0;
  for (let i = 0; i < view.length; i++) {
    const val = view[i] * s;
    out[i] = val;
    normSq += val * val;
  }
  const norm = Math.sqrt(normSq);
  if (norm <= 0) return null;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

export async function loadPreferredSongVectors() {
  const v3Rows = await getSongVectors(RECS_V3_MODEL);
  if (v3Rows.length > 0) return { model: RECS_V3_MODEL, rows: v3Rows };
  const legacyRows = await getSongVectors(GEMMA2_MODEL);
  return { model: GEMMA2_MODEL, rows: legacyRows };
}

function normalizeVector(vector, dimensions) {
  if (!Array.isArray(vector) || vector.length !== dimensions) return null;
  // Reject null/''/strings instead of letting Number() coerce them to 0.
  if (vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) return null;
  const values = vector;
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? values.map(value => value / norm) : null;
}

function recordSongKey(record) {
  return record?.songKey || (record?.artist && record?.title
    ? getSongKey({ artist: record.artist, track: record.title }) : null);
}

function filenameTitle(filename = '') {
  return String(filename).split(/[\\/]/).pop().replace(/\.[^.]+$/, '').trim();
}

const baseName = name => filenameTitle(name).toLowerCase();

// "Artist - Title.mp3" files with no artist tag: take the artist from the name, as Drive import does.
function recordParts(record) {
  const title = record.title || filenameTitle(record.filename);
  if (record.artist) return { artist: record.artist, track: title };
  const stem = filenameTitle(record.filename);
  const [artist, ...rest] = stem.split(' - ');
  return rest.length ? { artist: artist.trim(), track: rest.join(' - ').trim() } : { artist: '', track: title };
}

export function matchExportToLibrary(records = [], librarySongs = []) {
  const byKey = new Map();
  const byFile = new Map();
  const byArtistToken = new Map(); // 'high' needs artist overlap, so only songs sharing a token can match
  for (const song of librarySongs) {
    const key = song.songKey || getSongKey(song);
    if (key && !byKey.has(key)) byKey.set(key, song);
    const file = song.filename || song.fileName;
    if (file && !byFile.has(baseName(file))) byFile.set(baseName(file), song);
    const tokens = tokenSet(song.artist);
    if (!tokens.size) tokens.add('');
    for (const token of tokens) {
      if (!byArtistToken.has(token)) byArtistToken.set(token, []);
      byArtistToken.get(token).push(song);
    }
  }
  const candidatesFor = artist => {
    const tokens = tokenSet(artist);
    if (!tokens.size) return byArtistToken.get('') || [];
    const seen = new Set();
    for (const token of tokens) for (const song of byArtistToken.get(token) || []) seen.add(song);
    return [...seen];
  };
  const matches = [];
  const unmatched = [];
  const claimed = new Set(); // first record wins; duplicates (other files of the same song) are dropped
  for (const record of records) {
    const key = recordSongKey(record);
    let song = (key ? byKey.get(key) : null) || (record.filename ? byFile.get(baseName(record.filename)) : null) || null;
    if (!song) {
      const parts = recordParts(record);
      // 'high' only: a medium match can attach a live/remix vector to the studio track.
      const match = findSimilarSongMatch(parts, candidatesFor(parts.artist), 'high');
      song = match?.song || null;
    }
    const matchedKey = song && (song.songKey || getSongKey(song));
    if (song && !claimed.has(matchedKey)) { claimed.add(matchedKey); matches.push({ record, song }); }
    else unmatched.push(record);
  }
  return { matches, unmatched };
}

export async function importGemmaVectors(payload, librarySongs = []) {
  const isLegacy = payload?.model === GEMMA2_MODEL && payload?.dimensions === GEMMA2_DIMENSIONS;
  const isV3 = payload?.model === RECS_V3_MODEL && payload?.dimensions === RECS_V3_DIMENSIONS;
  if (!payload || (!isLegacy && !isV3) || !Array.isArray(payload.songs)) {
    return { imported: 0, unmatched: 0, skipped: Array.isArray(payload?.songs) ? payload.songs.length : 0 };
  }
  const targetModel = payload.model;
  const targetDims = payload.dimensions;
  const targetBoundaryDims = isV3
    ? (Number(payload.boundaryDimensions) || RECS_V3_BOUNDARY_DIMENSIONS)
    : BOUNDARY_DIMENSIONS;
  const tagDims = isV3 ? (Number(payload.tagDimensions) || 0) : 0;

  const { matches, unmatched } = matchExportToLibrary(payload.songs, librarySongs);
  let skipped = 0;
  const rows = [];
  for (const { record, song } of matches) {
    if (record.model && record.model !== targetModel) {
      skipped++;
      continue;
    }
    const vector = record.vectorI8
      ? decodeInt8Base64Unit(record.vectorI8, record.vectorScale, targetDims)
      : normalizeVector(record.vector, targetDims);

    const resolveBoundary = (rawVec, rawI8, rawScale) => {
      if (rawI8) return decodeInt8Base64Unit(rawI8, rawScale, targetBoundaryDims);
      if (rawVec == null) return null;
      return Array.isArray(rawVec) && rawVec.length >= targetBoundaryDims
        ? normalizeVector(rawVec.slice(0, targetBoundaryDims), targetBoundaryDims)
        : null;
    };
    const startVector = resolveBoundary(record.startVector, record.startI8, record.startScale);
    const endVector = resolveBoundary(record.endVector, record.endI8, record.endScale);
    const tagVector = isV3 && tagDims > 0
      ? (record.tagI8
        ? decodeInt8Base64Unit(record.tagI8, record.tagScale, tagDims)
        : (Array.isArray(record.tagVector) ? normalizeVector(record.tagVector, tagDims) : null))
      : null;

    const badStart = (record.startVector != null || record.startI8 != null) && !startVector;
    const badEnd = (record.endVector != null || record.endI8 != null) && !endVector;
    if (!vector || badStart || badEnd) {
      skipped++;
      continue;
    }
    rows.push({
      songKey: song.songKey || getSongKey(song),
      embeddingModel: targetModel,
      vector,
      dimensions: targetDims,
      boundaryDimensions: targetBoundaryDims,
      fileHash: record.fileHash || '',
      startVector,
      endVector,
      ...(tagVector ? { tagVector, tagDimensions: tagDims } : {}),
      clipCount: Number.isFinite(Number(record.clipCount)) ? Number(record.clipCount) : 0,
      artist: record.artist || song.artist || '',
      title: record.title || record.track || song.track || '',
      album: record.album || song.album || '',
      genre: record.genre || song.genre || '',
      year: record.year ?? song.year ?? null,
      duration: record.duration ?? song.duration ?? null,
    });
  }
  // One bulkPut per 500 rows instead of a transaction per song (a full export is ~5,000 rows).
  const imported = await saveSongVectors(rows);
  return { imported, unmatched: unmatched.length, skipped };
}

function normalizeServiceBaseUrl(baseUrl) {
  const parsed = new URL(`${String(baseUrl).replace(/\/+$/, '')}/`);
  const isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw new Error('Embedding service baseUrl must use HTTPS (or loopback HTTP).');
  }
  return parsed.toString();
}

export async function exchangeGemmaSessionToken({ baseUrl, token, scope = 'read', ttlSeconds = 900, fetchImpl = fetch } = {}) {
  if (!baseUrl || !token || typeof fetchImpl !== 'function') throw new Error('baseUrl, token, and fetchImpl are required.');
  const normalizedBase = normalizeServiceBaseUrl(baseUrl);
  const response = await fetchImpl(new URL('auth/session', normalizedBase).toString(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, ttlSeconds }),
  });
  if (!response.ok) throw new Error(`Gemma session exchange failed: ${response.status}`);
  return response.json();
}

export async function revokeGemmaSessionToken({ baseUrl, token, fetchImpl = fetch } = {}) {
  if (!baseUrl || !token || typeof fetchImpl !== 'function') throw new Error('baseUrl, token, and fetchImpl are required.');
  const normalizedBase = normalizeServiceBaseUrl(baseUrl);
  const response = await fetchImpl(new URL('auth/revoke', normalizedBase).toString(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!response.ok) throw new Error(`Gemma session revoke failed: ${response.status}`);
  return response.json();
}

export async function syncGemmaVectorsFromService({ baseUrl, token, since, fetchImpl = fetch, librarySongs = [] } = {}) {
  if (!baseUrl || !token || typeof fetchImpl !== 'function') throw new Error('baseUrl, token, and fetchImpl are required.');
  const normalizedBase = normalizeServiceBaseUrl(baseUrl);
  let cursor = since ?? (await db.metadata.get(CURSOR_KEY))?.value ?? '';
  let imported = 0;
  let unmatched = 0;
  let skipped = 0;
  const seen = new Set();
  let holdCursor = false;
  while (!seen.has(String(cursor))) {
    seen.add(String(cursor));
    const url = new URL('vectors', normalizedBase);
    if (cursor) url.searchParams.set('since', cursor);
    url.searchParams.set('dims', String(GEMMA2_DIMENSIONS));
    const response = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Gemma vector sync failed: ${response.status}`);
    const page = await response.json();
    const rows = (page.songs || []).map(row => ({
      ...row,
      dimensions: GEMMA2_DIMENSIONS,
      clipCount: row.clipCount ?? row.clipOffsets?.length ?? 0,
    }));
    const result = await importGemmaVectors({ model: GEMMA2_MODEL, dimensions: GEMMA2_DIMENSIONS, songs: rows }, librarySongs);
    imported += result.imported;
    unmatched += result.unmatched;
    skipped += result.skipped;
    const nextCursor = page.cursor ?? cursor;
    // Stop persisting once a page had unmatched rows, so the next sync (e.g. after the library loads) retries them.
    if (result.unmatched) holdCursor = true;
    if (!holdCursor && nextCursor !== cursor) await db.metadata.put({ key: CURSOR_KEY, value: nextCursor });
    const done = !rows.length || String(nextCursor) === String(cursor);
    cursor = nextCursor;
    if (done) break;
  }
  return { cursor, imported, unmatched, skipped };
}

export async function queryTextVector({ baseUrl, token, text, fetchImpl = fetch } = {}) {
  if (!baseUrl || !token || typeof fetchImpl !== 'function') throw new Error('baseUrl, token, and fetchImpl are required.');
  const normalizedBase = normalizeServiceBaseUrl(baseUrl);
  const response = await fetchImpl(new URL('query', normalizedBase).toString(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) throw new Error(`Gemma text query failed: ${response.status}`);
  return response.json();
}

export function gemmaNeighbors(seedKey, rows, k = 12) {
  const seed = rows.find(row => row.songKey === seedKey && (row.embeddingModel === RECS_V3_MODEL || row.embeddingModel === GEMMA2_MODEL));
  const seedModel = seed?.embeddingModel || GEMMA2_MODEL;
  const dims = seed?.dimensions || seed?.vector?.length || (seedModel === RECS_V3_MODEL ? RECS_V3_DIMENSIONS : GEMMA2_DIMENSIONS);
  const vector = seed && normalizeVector(seed.vector, dims);
  if (!vector) return [];
  return rows.flatMap(row => {
    if (row.songKey === seedKey || row.embeddingModel !== seedModel) return [];
    const candidate = normalizeVector(row.vector, dims);
    if (!candidate) return [];
    const similarityScore = vector.reduce((sum, value, index) => sum + value * candidate[index], 0);
    return [{ ...row, similarityScore }];
  }).sort((a, b) => b.similarityScore - a.similarityScore).slice(0, Math.max(0, k));
}

export { getSongVectors };
