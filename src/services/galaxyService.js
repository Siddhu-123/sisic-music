import { getSongKey } from '../songIdentity.js';
import { getSongEmbedding } from './tasteEmbeddingService.js';
import { resolveEmbeddingMetadata, validateAndNormalizeVector } from './contextualRecommendationService.js';
import { getSongGenres, getSongMoods } from './exploreService.js';

export const GALAXY_MAX_CLUSTERS = 8;
const GENERIC_LABELS = new Set(['Open format', 'Discovery']);

/**
 * Picks ONE vector space for the whole map. Learned-audio embeddings are
 * used when enough songs share the same model and size; otherwise every
 * song uses the metadata embedding. Mixing spaces would make distances meaningless.
 */
export function chooseGalaxySpace(songs = [], { preference = 'auto', minAudioSongs = 12, minAudioShare = 0.25 } = {}) {
  const groups = new Map();
  for (const song of songs) {
    const meta = resolveEmbeddingMetadata(song);
    if (meta?.vectorType !== 'learned-audio') continue;
    const vector = validateAndNormalizeVector(meta.vector, meta.dimensions);
    if (!vector) continue;
    const id = `${meta.model}|${meta.dimensions}`;
    if (!groups.has(id)) groups.set(id, { model: meta.model, dimensions: meta.dimensions, items: [] });
    groups.get(id).items.push({ song, vector });
  }
  const best = [...groups.values()].sort((a, b) => b.items.length - a.items.length)[0];
  const audioAvailable = Boolean(best && best.items.length >= Math.max(minAudioSongs, songs.length * minAudioShare));
  const audio = audioAvailable ? { model: best.model, dimensions: best.dimensions, count: best.items.length } : null;

  if (audioAvailable && preference !== 'metadata') {
    return { mode: 'audio', audio, items: best.items, excluded: songs.length - best.items.length };
  }
  return {
    mode: 'metadata',
    audio,
    items: songs.map(song => ({ song, vector: getSongEmbedding(song) })),
    excluded: 0,
  };
}

// Small deterministic PRNG so the same library always draws the same map.
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function squaredDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const delta = a[i] - b[i];
    sum += delta * delta;
  }
  return sum;
}

/** k-means with k-means++ seeding (seeded, so stable) that stops once assignments settle. */
export function clusterVectors(vectors = [], { k: requestedK, maxClusters = GALAXY_MAX_CLUSTERS, iterations = 24, seed = 7 } = {}) {
  const n = vectors.length;
  if (!n) return { assignments: [], k: 0 };
  const k = Math.max(1, Math.min(n, maxClusters, requestedK || Math.round(Math.sqrt(n / 2)) || 1));
  const random = mulberry32(seed + n);
  const centroids = [Float32Array.from(vectors[Math.floor(random() * n)])];
  const nearest = vectors.map(vector => squaredDistance(vector, centroids[0]));
  while (centroids.length < k) {
    const total = nearest.reduce((sum, value) => sum + value, 0);
    let target = random() * total;
    let index = 0;
    while (index < n - 1 && target > nearest[index]) {
      target -= nearest[index];
      index++;
    }
    if (!total) index = centroids.length % n;
    centroids.push(Float32Array.from(vectors[index]));
    vectors.forEach((vector, i) => { nearest[i] = Math.min(nearest[i], squaredDistance(vector, centroids.at(-1))); });
  }

  const dims = vectors[0].length;
  const assignments = new Array(n).fill(-1);
  for (let iteration = 0; iteration < iterations; iteration++) {
    let changed = false;
    vectors.forEach((vector, i) => {
      let best = 0;
      let bestDistance = Infinity;
      centroids.forEach((centroid, c) => {
        const distance = squaredDistance(vector, centroid);
        if (distance < bestDistance) { bestDistance = distance; best = c; }
      });
      if (assignments[i] !== best) { assignments[i] = best; changed = true; }
    });
    if (!changed) break;
    const sums = centroids.map(() => new Float32Array(dims));
    const counts = new Array(k).fill(0);
    vectors.forEach((vector, i) => {
      counts[assignments[i]]++;
      for (let d = 0; d < dims; d++) sums[assignments[i]][d] += vector[d];
    });
    sums.forEach((sum, c) => {
      if (!counts[c]) return;
      for (let d = 0; d < dims; d++) centroids[c][d] = sum[d] / counts[c];
    });
  }

  // Renumber clusters largest-first so colours and legend order are stable.
  const sizes = new Map();
  assignments.forEach(c => sizes.set(c, (sizes.get(c) || 0) + 1));
  const order = [...sizes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([c]) => c);
  const remap = new Map(order.map((c, index) => [c, index]));
  return { assignments: assignments.map(c => remap.get(c)), k: order.length };
}

function principalAxis(centered, dims, seed, previous) {
  const axis = new Float32Array(dims);
  for (let d = 0; d < dims; d++) axis[d] = Math.sin((d + 1) * seed) + 0.01;
  for (let iteration = 0; iteration < 16; iteration++) {
    for (const prior of previous) {
      let projection = 0;
      for (let d = 0; d < dims; d++) projection += axis[d] * prior[d];
      for (let d = 0; d < dims; d++) axis[d] -= projection * prior[d];
    }
    const next = new Float32Array(dims);
    for (const row of centered) {
      let dot = 0;
      for (let d = 0; d < dims; d++) dot += row[d] * axis[d];
      for (let d = 0; d < dims; d++) next[d] += dot * row[d];
    }
    let norm = 0;
    for (let d = 0; d < dims; d++) norm += next[d] * next[d];
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dims; d++) axis[d] = next[d] / norm;
  }
  return axis;
}

/** PCA to three axes for any vector size (64D metadata or 200D audio). */
export function projectTo3D(vectors = []) {
  if (!vectors.length) return [];
  const dims = vectors[0].length;
  const mean = new Float32Array(dims);
  vectors.forEach(vector => { for (let d = 0; d < dims; d++) mean[d] += vector[d] / vectors.length; });
  const centered = vectors.map(vector => Float32Array.from(vector, (value, d) => value - mean[d]));
  const axes = [];
  for (let axis = 1; axis <= 3; axis++) axes.push(principalAxis(centered, dims, axis, axes));
  return centered.map(row => axes.map(axis => {
    let sum = 0;
    for (let d = 0; d < dims; d++) sum += row[d] * axis[d];
    return sum;
  }));
}

const FRAME_SHELL = 1.2;

/**
 * Centres the 5th-95th percentile box of each axis, pulls far outliers onto
 * a shell, and returns points inside the unit sphere, so the whole cloud
 * stays on screen at any rotation and a few outliers can't squash the rest.
 */
export function frameCoordinates(coords = []) {
  if (!coords.length) return [];
  const frames = [0, 1, 2].map(axis => {
    const values = coords.map(point => point[axis]).sort((a, b) => a - b);
    const low = values[Math.floor((values.length - 1) * 0.05)];
    const high = values[Math.ceil((values.length - 1) * 0.95)];
    return { centre: (low + high) / 2, spread: (high - low) / 2 || 1 };
  });
  return coords.map(point => {
    const scaled = point.map((value, axis) => (value - frames[axis].centre) / frames[axis].spread);
    const length = Math.hypot(...scaled);
    const pull = length > FRAME_SHELL ? FRAME_SHELL / length : 1;
    return scaled.map(value => (value * pull) / FRAME_SHELL);
  });
}

/** Names a cluster after its most common mood/genre, falling back to its top artist. */
export function labelCluster(songs = []) {
  const facets = new Map();
  const artists = new Map();
  for (const song of songs) {
    // Genres come first so a tie between a genre and a mood names the cluster by genre.
    for (const label of [...getSongGenres(song), ...getSongMoods(song)]) {
      if (!GENERIC_LABELS.has(label)) facets.set(label, (facets.get(label) || 0) + 1);
    }
    const artist = String(song.artist || '').split(/\s*(?:,|&|\bfeat\.?|\bft\.?)\s*/i)[0].trim();
    if (artist) artists.set(artist, (artists.get(artist) || 0) + 1);
  }
  const top = map => [...map.entries()].sort((a, b) => b[1] - a[1])[0] || [];
  const [facet, facetCount = 0] = top(facets);
  const [artist, artistCount = 0] = top(artists);
  const strongFacet = facet && facetCount >= Math.max(2, songs.length * 0.25);
  const strongArtist = artist && artistCount >= Math.max(2, songs.length * 0.2);
  if (strongFacet && strongArtist) return `${facet} · ${artist}`;
  if (strongFacet) return facet;
  if (artist) return artistCount > 1 ? artist : 'Mixed';
  return 'Mixed';
}

/** Everything the galaxy view needs: one consistent space, clusters, framed 3D points and labels. */
export function buildGalaxy(songs = [], options = {}) {
  const space = chooseGalaxySpace(songs, options);
  const vectors = space.items.map(item => item.vector);
  const { assignments } = clusterVectors(vectors, options);
  const coords = frameCoordinates(projectTo3D(vectors));
  const points = space.items.map((item, index) => ({
    ...item.song,
    songKey: item.song.songKey || getSongKey(item.song),
    clusterId: assignments[index],
    x: coords[index][0],
    y: coords[index][1],
    z: coords[index][2],
  }));
  const byCluster = new Map();
  points.forEach(point => {
    if (!byCluster.has(point.clusterId)) byCluster.set(point.clusterId, []);
    byCluster.get(point.clusterId).push(point);
  });
  const seenLabels = new Map();
  const clusters = [...byCluster.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([clusterId, clusterSongs]) => {
      const base = labelCluster(clusterSongs);
      const count = (seenLabels.get(base) || 0) + 1;
      seenLabels.set(base, count);
      // Two clusters dominated by the same artist/mood get numbered so the legend stays unambiguous.
      return { clusterId, songs: clusterSongs, label: count > 1 ? `${base} ${count}` : base };
    });
  return { mode: space.mode, audio: space.audio, excluded: space.excluded, points, clusters };
}
