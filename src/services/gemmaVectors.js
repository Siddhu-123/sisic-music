import { db, getSongVectors, saveSongVector } from '../db.js';
import { findSimilarSongMatch, getSongKey } from '../songIdentity.js';

export const GEMMA2_MODEL = 'embeddinggemma-2@fp32/clip30/v1';
export const GEMMA2_DIMENSIONS = 256;
const BOUNDARY_DIMENSIONS = 128;
const CURSOR_KEY = `gemmaVectorsCursor:${GEMMA2_MODEL}`;

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

export function matchExportToLibrary(records = [], librarySongs = []) {
  const byKey = new Map();
  for (const song of librarySongs) {
    const key = song.songKey || getSongKey(song);
    if (key && !byKey.has(key)) byKey.set(key, song);
  }
  const matches = [];
  const unmatched = [];
  const claimed = new Set(); // first record wins; duplicates (other files of the same song) are dropped
  for (const record of records) {
    const key = recordSongKey(record);
    let song = key ? byKey.get(key) : null;
    if (!song) {
      const title = record.title || filenameTitle(record.filename);
      // 'high' only: a medium match can attach a live/remix vector to the studio track.
      const match = findSimilarSongMatch({ artist: record.artist, track: title }, librarySongs, 'high');
      song = match?.song || null;
    }
    const matchedKey = song && (song.songKey || getSongKey(song));
    if (song && !claimed.has(matchedKey)) { claimed.add(matchedKey); matches.push({ record, song }); }
    else unmatched.push(record);
  }
  return { matches, unmatched };
}

export async function importGemmaVectors(payload, librarySongs = []) {
  if (!payload || payload.model !== GEMMA2_MODEL || payload.dimensions !== GEMMA2_DIMENSIONS || !Array.isArray(payload.songs)) {
    return { imported: 0, unmatched: 0, skipped: Array.isArray(payload?.songs) ? payload.songs.length : 0 };
  }
  const { matches, unmatched } = matchExportToLibrary(payload.songs, librarySongs);
  let imported = 0;
  let skipped = 0;
  for (const { record, song } of matches) {
    if (record.model && record.model !== GEMMA2_MODEL) {
      skipped++;
      continue;
    }
    const vector = normalizeVector(record.vector, GEMMA2_DIMENSIONS);
    // Boundary vectors may arrive at full song dims (service) or 128 (Mac export); Matryoshka-truncate to 128.
    const boundary = value => (Array.isArray(value) && value.length >= BOUNDARY_DIMENSIONS
      ? normalizeVector(value.slice(0, BOUNDARY_DIMENSIONS), BOUNDARY_DIMENSIONS) : null);
    const startVector = record.startVector == null ? null : boundary(record.startVector);
    const endVector = record.endVector == null ? null : boundary(record.endVector);
    if (!vector || (record.startVector != null && !startVector) || (record.endVector != null && !endVector)) {
      skipped++;
      continue;
    }
    await saveSongVector(song.songKey || getSongKey(song), GEMMA2_MODEL, {
      vector,
      dimensions: GEMMA2_DIMENSIONS,
      fileHash: record.fileHash || '',
      startVector,
      endVector,
      clipCount: Number.isFinite(Number(record.clipCount)) ? Number(record.clipCount) : 0,
      artist: record.artist || song.artist || '',
      title: record.title || record.track || song.track || '',
      album: record.album || song.album || '',
      genre: record.genre || song.genre || '',
      year: record.year ?? song.year ?? null,
      duration: record.duration ?? song.duration ?? null,
    });
    imported++;
  }
  return { imported, unmatched: unmatched.length, skipped };
}

export async function syncGemmaVectorsFromService({ baseUrl, token, since, fetchImpl = fetch, librarySongs = [] } = {}) {
  if (!baseUrl || !token || typeof fetchImpl !== 'function') throw new Error('baseUrl, token, and fetchImpl are required.');
  let cursor = since ?? (await db.metadata.get(CURSOR_KEY))?.value ?? '';
  let imported = 0;
  let unmatched = 0;
  let skipped = 0;
  const seen = new Set();
  let holdCursor = false;
  while (!seen.has(String(cursor))) {
    seen.add(String(cursor));
    const url = new URL('vectors', `${String(baseUrl).replace(/\/+$/, '')}/`);
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
  const response = await fetchImpl(new URL('query', `${String(baseUrl).replace(/\/+$/, '')}/`).toString(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) throw new Error(`Gemma text query failed: ${response.status}`);
  return response.json();
}

export function gemmaNeighbors(seedKey, rows, k = 12) {
  const seed = rows.find(row => row.songKey === seedKey && row.embeddingModel === GEMMA2_MODEL);
  const vector = seed && normalizeVector(seed.vector, GEMMA2_DIMENSIONS);
  if (!vector) return [];
  return rows.flatMap(row => {
    if (row.songKey === seedKey || row.embeddingModel !== GEMMA2_MODEL) return [];
    const candidate = normalizeVector(row.vector, GEMMA2_DIMENSIONS);
    if (!candidate) return [];
    const similarityScore = vector.reduce((sum, value, index) => sum + value * candidate[index], 0);
    return [{ ...row, similarityScore }];
  }).sort((a, b) => b.similarityScore - a.similarityScore).slice(0, Math.max(0, k));
}

export { getSongVectors };
