import { getSongKey, normalizeText } from '../songIdentity.js';
import { saveSongEmbedding } from '../db.js';
import { hashString } from './artworkService.js';

export const EMBEDDING_DIMENSIONS = 64;

/**
 * Generates a 64-dimensional feature vector for a song.
 * Uses semantic token hashing, metadata attributes, and acoustic markers.
 */
export function computeSongEmbedding(song = {}) {
  const vector = new Float32Array(EMBEDDING_DIMENSIONS);
  const artist = normalizeText(song.artist || '');
  const track = normalizeText(song.track || '');
  const album = normalizeText(song.album || '');
  const combined = `${artist} ${track} ${album}`.trim();

  // 1. Semantic N-gram Hashing (Dimensions 0..27)
  for (let i = 0; i < combined.length - 1; i++) {
    const bigram = combined.slice(i, i + 2);
    const hash = hashString(bigram);
    const dim = hash % 28;
    vector[dim] += 1.0;
  }
  for (let i = 0; i < combined.length - 2; i++) {
    const trigram = combined.slice(i, i + 3);
    const hash = hashString(trigram);
    const dim = 28 + (hash % 16);
    vector[dim] += 1.2;
  }

  // 2. Music/Acoustic Mood Markers (Dimensions 44..55)
  const text = combined.toLowerCase();
  if (text.includes('live') || text.includes('concert') || text.includes('tour')) vector[44] += 2.0;
  if (text.includes('remix') || text.includes('club') || text.includes('mix') || text.includes('dj')) vector[45] += 2.0;
  if (text.includes('slowed') || text.includes('reverb') || text.includes('chill') || text.includes('lofi')) vector[46] += 2.0;
  if (text.includes('acoustic') || text.includes('unplugged') || text.includes('piano')) vector[47] += 2.0;
  if (text.includes('funk') || text.includes('montagem') || text.includes('phonk') || text.includes('bass')) vector[48] += 2.0;
  if (text.includes('rock') || text.includes('metal') || text.includes('punk')) vector[49] += 2.0;
  if (text.includes('hip hop') || text.includes('rap') || text.includes('trap')) vector[50] += 2.0;
  if (text.includes('pop') || text.includes('dance') || text.includes('synth')) vector[51] += 2.0;
  if (text.includes('instrumental') || text.includes('soundtrack') || text.includes('theme')) vector[52] += 2.0;

  // 3. Artist Cluster Seed Hash (Dimensions 56..63)
  const artistHash = hashString(artist || 'unknown');
  for (let d = 0; d < 8; d++) {
    const val = ((artistHash >> (d * 4)) & 0x0f) / 15.0;
    vector[56 + d] += val * 1.5;
  }

  // L2 Normalize to Unit Length: ||vector|| = 1.0
  let sumSq = 0;
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
    sumSq += vector[i] * vector[i];
  }
  const norm = Math.sqrt(sumSq) || 1.0;
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
    vector[i] /= norm;
  }

  return Array.from(vector);
}

/**
 * Computes Cosine Similarity between two feature vectors: dot(a, b).
 */
export function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dot = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
  }
  return Math.max(-1.0, Math.min(1.0, dot));
}

/**
 * Finds the top N most musically similar songs in the library.
 */
export function findSimilarSongs(targetSong, librarySongs = [], options = {}) {
  const { limit = 8, excludeCurrent = true } = options;
  if (!targetSong || librarySongs.length === 0) return [];

  const targetKey = targetSong.songKey || getSongKey(targetSong);
  const targetVector = targetSong.vector || computeSongEmbedding(targetSong);

  const scored = [];
  for (const song of librarySongs) {
    const key = song.songKey || getSongKey(song);
    if (excludeCurrent && key === targetKey) continue;
    const songVec = song.vector || computeSongEmbedding(song);
    const score = cosineSimilarity(targetVector, songVec);
    scored.push({ song, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(item => ({ ...item.song, similarityScore: item.score }));
}

/**
 * Computes user taste centroid vector from play history and likes.
 */
export function computeTasteCentroid(songs = [], playbackStarts = []) {
  if (songs.length === 0) return null;

  const playCountByKey = new Map();
  for (const event of playbackStarts) {
    if (event.songKey) {
      playCountByKey.set(event.songKey, (playCountByKey.get(event.songKey) || 0) + 1);
    }
  }

  const centroid = new Float32Array(EMBEDDING_DIMENSIONS);
  let totalWeight = 0;

  for (const song of songs) {
    const key = song.songKey || getSongKey(song);
    const plays = Math.max(Number(song.playCount || 0), playCountByKey.get(key) || 0);
    const weight = 1.0 + Math.min(5.0, plays * 0.5);
    const vec = song.vector || computeSongEmbedding(song);

    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
      centroid[i] += vec[i] * weight;
    }
    totalWeight += weight;
  }

  if (totalWeight === 0) return null;

  // L2 Normalize
  let sumSq = 0;
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
    centroid[i] /= totalWeight;
    sumSq += centroid[i] * centroid[i];
  }
  const norm = Math.sqrt(sumSq) || 1.0;
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
    centroid[i] /= norm;
  }

  return Array.from(centroid);
}

/**
 * Auto-DJ Recommendation: returns smart track continuation based on taste centroid.
 */
export function getAutoDJNextSongs(recentlyPlayed = [], librarySongs = [], count = 5) {
  if (librarySongs.length === 0) return [];
  const recentKeys = new Set(recentlyPlayed.map(s => s.songKey || getSongKey(s)));
  const candidates = librarySongs.filter(s => !recentKeys.has(s.songKey || getSongKey(s)));
  const effectivePool = candidates.length > 0 ? candidates : librarySongs;

  // Derive target vector from the last 3 played songs
  const recentTracks = recentlyPlayed.slice(-3);
  let targetVec = null;
  if (recentTracks.length > 0) {
    targetVec = computeTasteCentroid(recentTracks);
  }
  if (!targetVec && librarySongs.length > 0) {
    targetVec = computeSongEmbedding(librarySongs[0]);
  }

  return findSimilarSongs({ vector: targetVec }, effectivePool, { limit: count, excludeCurrent: false });
}

/**
 * 2D Principal Component Analysis (PCA) projection for interactive Constellation/Galaxy view.
 */
export function projectEmbeddingsTo2D(songs = []) {
  if (songs.length === 0) return [];
  const N = songs.length;
  const D = EMBEDDING_DIMENSIONS;

  // Compute Mean Vector
  const mean = new Float32Array(D);
  const matrix = songs.map(song => {
    const vec = song.vector || computeSongEmbedding(song);
    for (let j = 0; j < D; j++) mean[j] += vec[j];
    return vec;
  });
  for (let j = 0; j < D; j++) mean[j] /= N;

  // Center Data
  const centered = matrix.map(vec => {
    const c = new Float32Array(D);
    for (let j = 0; j < D; j++) c[j] = vec[j] - mean[j];
    return c;
  });

  // Power Iteration for 1st Principal Component
  let pc1 = new Float32Array(D);
  for (let j = 0; j < D; j++) pc1[j] = Math.sin(j + 1);
  for (let iter = 0; iter < 12; iter++) {
    const next = new Float32Array(D);
    for (const row of centered) {
      let dot = 0;
      for (let j = 0; j < D; j++) dot += row[j] * pc1[j];
      for (let j = 0; j < D; j++) next[j] += dot * row[j];
    }
    let norm = 0;
    for (let j = 0; j < D; j++) norm += next[j] * next[j];
    norm = Math.sqrt(norm) || 1;
    for (let j = 0; j < D; j++) pc1[j] = next[j] / norm;
  }

  // Power Iteration for 2nd Principal Component (Orthogonal to PC1)
  let pc2 = new Float32Array(D);
  for (let j = 0; j < D; j++) pc2[j] = Math.cos(j + 1);
  for (let iter = 0; iter < 12; iter++) {
    // Deflate
    let dot1 = 0;
    for (let j = 0; j < D; j++) dot1 += pc2[j] * pc1[j];
    for (let j = 0; j < D; j++) pc2[j] -= dot1 * pc1[j];

    const next = new Float32Array(D);
    for (const row of centered) {
      let dot = 0;
      for (let j = 0; j < D; j++) dot += row[j] * pc2[j];
      for (let j = 0; j < D; j++) next[j] += dot * row[j];
    }
    let norm = 0;
    for (let j = 0; j < D; j++) norm += next[j] * next[j];
    norm = Math.sqrt(norm) || 1;
    for (let j = 0; j < D; j++) pc2[j] = next[j] / norm;
  }

  // Project points
  return songs.map((song, i) => {
    const row = centered[i];
    let x = 0;
    let y = 0;
    for (let j = 0; j < D; j++) {
      x += row[j] * pc1[j];
      y += row[j] * pc2[j];
    }
    return {
      ...song,
      coordX: x,
      coordY: y,
    };
  });
}

/**
 * Default Sisic embedding provider function for embeddingService.js
 */
export async function defaultSisicEmbeddingProvider({ song }) {
  const vector = computeSongEmbedding(song);
  const songKey = song.songKey || getSongKey(song);
  await saveSongEmbedding(songKey, { vector, provider: 'sisic-client' });
  return {
    provider: 'sisic-client',
    embeddingId: `sisic-vec-${songKey}`,
    vector,
  };
}
