import { getSongKey, normalizeText } from '../songIdentity.js';
import { saveSongEmbedding } from '../db.js';
import { hashString } from './artworkService.js';

export const EMBEDDING_DIMENSIONS = 64;
export const EMBEDDING_PROVIDER = 'sisic-client-v2';
export const METADATA_EMBEDDING_MODEL = 'metadata-ngram-v2';

// Block layout: lexical title n-grams [0, 32), mood/style markers [32, 48),
// signed artist identity [48, 64). Each block is normalised on its own and then
// weighted, so a long title can no longer drown out who the artist is.
const LEXICAL_DIMS = 32;
const MOOD_OFFSET = 32;
const ARTIST_OFFSET = 48;
const ARTIST_DIMS = 16;
const BLOCK_WEIGHTS = { lexical: 0.6, mood: 0.5, artist: 0.62 };

const MOOD_MARKERS = [
  ['live', 'concert', 'tour'],
  ['remix', 'club', 'mix', 'dj', 'edit', 'bootleg'],
  ['slowed', 'reverb', 'chill', 'lofi'],
  ['sped', 'speed', 'nightcore'],
  ['acoustic', 'unplugged', 'piano', 'guitar'],
  ['funk', 'montagem', 'phonk', 'bass', 'brazilian'],
  ['rock', 'metal', 'punk', 'grunge'],
  ['hip hop', 'rap', 'trap', 'drill'],
  ['pop', 'dance', 'synth', 'disco'],
  ['instrumental', 'soundtrack', 'theme', 'ost', 'score'],
  ['love', 'heart', 'romance'],
  ['sad', 'cry', 'lonely', 'tears'],
  ['night', 'midnight', 'moon', 'dream'],
  ['electronic', 'edm', 'house', 'techno', 'trance'],
  ['jazz', 'blues', 'soul', 'rnb'],
  ['classical', 'orchestral', 'symphony', 'opera'],
];

function splitArtists(artist = '') {
  return String(artist)
    .split(/\s*(?:,|&|\/|;|\bfeat\.?|\bft\.?|\bfeaturing\b|\bx\b|\bwith\b)\s*/i)
    .map(name => normalizeText(name))
    .filter(Boolean);
}

function addBlock(vector, block, offset, weight) {
  let sumSq = 0;
  for (const value of block) sumSq += value * value;
  const norm = Math.sqrt(sumSq);
  if (!norm) return;
  for (let i = 0; i < block.length; i++) vector[offset + i] = (block[i] / norm) * weight;
}

/**
 * Generates a 64-dimensional feature vector for a song from three weighted
 * blocks: title/album n-grams, whole-word mood markers and artist identity.
 */
export function computeSongEmbedding(song = {}) {
  const vector = new Float32Array(EMBEDDING_DIMENSIONS);
  const track = normalizeText(song.track || '');
  const album = normalizeText(song.album || '');
  const title = `${track} ${album}`.trim();

  // Title n-grams, sqrt-dampened so repeated common bigrams don't dominate.
  const lexical = new Float32Array(LEXICAL_DIMS);
  for (let i = 0; i < title.length - 1; i++) lexical[hashString(title.slice(i, i + 2)) % 20] += 1;
  for (let i = 0; i < title.length - 2; i++) lexical[20 + (hashString(title.slice(i, i + 3)) % 12)] += 1.2;
  addBlock(vector, lexical.map(Math.sqrt), 0, BLOCK_WEIGHTS.lexical);

  // Whole-word mood markers ("rap" must not match "therapy", "live" not "oliver").
  const words = ` ${normalizeText([song.artist, track, album, song.genre].filter(Boolean).join(' '))} `;
  const mood = new Float32Array(MOOD_MARKERS.length);
  MOOD_MARKERS.forEach((terms, index) => {
    if (terms.some(term => words.includes(` ${term} `))) mood[index] = 1;
  });
  addBlock(vector, mood, MOOD_OFFSET, BLOCK_WEIGHTS.mood);

  // Signed artist hash: unrelated artists land near-orthogonal, shared artists
  // (including features) pull songs together.
  const artist = new Float32Array(ARTIST_DIMS);
  const artists = splitArtists(song.artist);
  (artists.length ? artists : ['unknown']).forEach((name, index) => {
    const weight = index === 0 ? 1 : 0.6;
    for (let half = 0; half < 2; half++) {
      const hash = hashString(half ? `${name}#` : name);
      for (let d = 0; d < 8; d++) artist[half * 8 + d] += ((((hash >> (d * 4)) & 0x0f) / 7.5) - 1) * weight;
    }
  });
  addBlock(vector, artist, ARTIST_OFFSET, BLOCK_WEIGHTS.artist);

  // L2 normalise to unit length so cosine similarity is a plain dot product.
  let sumSq = 0;
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) sumSq += vector[i] * vector[i];
  const norm = Math.sqrt(sumSq) || 1.0;
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) vector[i] /= norm;

  return Array.from(vector);
}

const embeddingCache = new Map();
const EMBEDDING_CACHE_LIMIT = 5000;

/**
 * Metadata-space vector for a song: a stored metadata vector when present,
 * otherwise a memoised local embedding. Learned-audio vectors and vectors
 * stored by the older v1 layout are never returned, so spaces never mix.
 */
export function getSongEmbedding(song = {}) {
  const model = song.embeddingModel || song.model;
  const provider = song.embeddingProvider || song.provider;
  const isStale = song.vectorType === 'learned-audio'
    || (song.embeddingType === 'learned-audio')
    || model === 'metadata-ngram-v1'
    || (provider === 'sisic-client' && model !== METADATA_EMBEDDING_MODEL);
  if (!isStale && song.vector?.length === EMBEDDING_DIMENSIONS) return song.vector;
  const cacheKey = `${song.artist || ''}\u0000${song.track || ''}\u0000${song.album || ''}\u0000${song.genre || ''}`;
  let vector = embeddingCache.get(cacheKey);
  if (!vector) {
    vector = computeSongEmbedding(song);
    if (embeddingCache.size >= EMBEDDING_CACHE_LIMIT) embeddingCache.delete(embeddingCache.keys().next().value);
    embeddingCache.set(cacheKey, vector);
  }
  return vector;
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
  const targetVector = getSongEmbedding(targetSong);

  const scored = [];
  for (const song of librarySongs) {
    const key = song.songKey || getSongKey(song);
    if (excludeCurrent && key === targetKey) continue;
    const songVec = getSongEmbedding(song);
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
    const vec = getSongEmbedding(song);

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
    const vec = getSongEmbedding(song);
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

function principalAxis(centered, seedMultiplier, previousAxes = []) {
  const axis = new Float32Array(EMBEDDING_DIMENSIONS);
  for (let j = 0; j < EMBEDDING_DIMENSIONS; j++) axis[j] = Math.sin((j + 1) * seedMultiplier);
  for (let iter = 0; iter < 12; iter++) {
    for (const previous of previousAxes) {
      let projection = 0;
      for (let j = 0; j < EMBEDDING_DIMENSIONS; j++) projection += axis[j] * previous[j];
      for (let j = 0; j < EMBEDDING_DIMENSIONS; j++) axis[j] -= projection * previous[j];
    }
    const next = new Float32Array(EMBEDDING_DIMENSIONS);
    for (const row of centered) {
      let dot = 0;
      for (let j = 0; j < EMBEDDING_DIMENSIONS; j++) dot += row[j] * axis[j];
      for (let j = 0; j < EMBEDDING_DIMENSIONS; j++) next[j] += dot * row[j];
    }
    let norm = 0;
    for (let j = 0; j < EMBEDDING_DIMENSIONS; j++) norm += next[j] * next[j];
    norm = Math.sqrt(norm) || 1;
    for (let j = 0; j < EMBEDDING_DIMENSIONS; j++) axis[j] = next[j] / norm;
  }
  return axis;
}

/** Projects vectors to three PCA axes for the lightweight WebGL cluster view. */
export function projectEmbeddingsTo3D(songs = []) {
  if (songs.length === 0) return [];
  const vectors = songs.map(song => getSongEmbedding(song));
  const mean = new Float32Array(EMBEDDING_DIMENSIONS);
  vectors.forEach(vector => vector.forEach((value, index) => { mean[index] += value; }));
  for (let j = 0; j < EMBEDDING_DIMENSIONS; j++) mean[j] /= vectors.length;
  const centered = vectors.map(vector => Float32Array.from(vector, (value, index) => value - mean[index]));
  const axes = [];
  axes.push(principalAxis(centered, 1));
  axes.push(principalAxis(centered, 2, axes));
  axes.push(principalAxis(centered, 3, axes));

  return songs.map((song, index) => {
    const row = centered[index];
    const coords = axes.map(axis => row.reduce((sum, value, dim) => sum + value * axis[dim], 0));
    return { ...song, coordX: coords[0], coordY: coords[1], coordZ: coords[2] };
  });
}

/**
 * Deterministic k-means over the local song embeddings. The bounded cluster
 * count keeps the view responsive even for large libraries.
 */
export function kMeansCluster(songs = [], options = {}) {
  if (songs.length === 0) return [];
  const vectors = songs.map(song => getSongEmbedding(song));
  const requestedClusters = Number(options.k) || Math.round(Math.sqrt(songs.length / 2));
  const k = Math.min(songs.length, Math.max(1, Math.min(Number(options.maxClusters) || 8, requestedClusters)));
  const dimensions = EMBEDDING_DIMENSIONS;
  const centroids = Array.from({ length: k }, (_, clusterIndex) => Float32Array.from(vectors[Math.floor((clusterIndex * vectors.length) / k)]));
  const assignments = new Array(vectors.length).fill(0);

  for (let iteration = 0; iteration < (Number(options.iterations) || 8); iteration++) {
    for (let index = 0; index < vectors.length; index++) {
      let bestCluster = 0;
      let bestDistance = Infinity;
      for (let clusterIndex = 0; clusterIndex < k; clusterIndex++) {
        let distance = 0;
        for (let dimension = 0; dimension < dimensions; dimension++) {
          const delta = vectors[index][dimension] - centroids[clusterIndex][dimension];
          distance += delta * delta;
        }
        if (distance < bestDistance) {
          bestDistance = distance;
          bestCluster = clusterIndex;
        }
      }
      assignments[index] = bestCluster;
    }

    const sums = Array.from({ length: k }, () => new Float32Array(dimensions));
    const counts = new Array(k).fill(0);
    vectors.forEach((vector, index) => {
      const cluster = assignments[index];
      counts[cluster]++;
      for (let dimension = 0; dimension < dimensions; dimension++) sums[cluster][dimension] += vector[dimension];
    });
    for (let clusterIndex = 0; clusterIndex < k; clusterIndex++) {
      if (!counts[clusterIndex]) continue;
      for (let dimension = 0; dimension < dimensions; dimension++) centroids[clusterIndex][dimension] = sums[clusterIndex][dimension] / counts[clusterIndex];
    }
  }

  const clusterSizes = assignments.reduce((sizes, cluster) => {
    sizes[cluster] = (sizes[cluster] || 0) + 1;
    return sizes;
  }, {});
  return songs.map((song, index) => ({
    ...song,
    clusterId: assignments[index],
    clusterSize: clusterSizes[assignments[index]],
  }));
}

/**
 * Default Sisic embedding provider function for embeddingService.js
 */
export async function defaultSisicEmbeddingProvider({ song }) {
  const vector = computeSongEmbedding(song);
  const songKey = song.songKey || getSongKey(song);
  await saveSongEmbedding(songKey, { vector, provider: EMBEDDING_PROVIDER, model: METADATA_EMBEDDING_MODEL, vectorType: 'metadata' });
  return {
    provider: EMBEDDING_PROVIDER,
    embeddingId: `sisic-vec-${songKey}`,
    vector,
  };
}
