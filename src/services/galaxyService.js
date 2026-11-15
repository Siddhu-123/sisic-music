import { getSongKey } from '../songIdentity.js';
import { outcomeWeight } from './behaviourLearning.js';
import { getSongEmbedding } from './tasteEmbeddingService.js';
import { resolveEmbeddingMetadata, validateAndNormalizeVector } from './contextualRecommendationService.js';
import { getSongGenres, getSongMoods } from './exploreService.js';

export const GALAXY_MAX_CLUSTERS = 8;
const GENERIC_LABELS = new Set(['Open format', 'Discovery']);
const DAY_MS = 24 * 60 * 60 * 1000;

function resolveSongAudioVector(song, gemmaVectors) {
  const inline = resolveEmbeddingMetadata(song);
  if (inline?.vectorType === 'learned-audio') {
    const vector = validateAndNormalizeVector(inline.vector, inline.dimensions);
    if (vector) return { model: inline.model, dimensions: inline.dimensions, vector };
  }
  const key = song?.songKey || getSongKey(song);
  const gemma = key && gemmaVectors?.get?.(key);
  if (gemma?.vector) {
    const dims = gemma.dimensions || gemma.vector.length;
    const vector = validateAndNormalizeVector(gemma.vector, dims);
    if (vector) return { model: gemma.embeddingModel || 'embeddinggemma-2', dimensions: dims, vector };
  }
  return null;
}

/**
 * Picks ONE vector space for the whole map. Learned-audio embeddings are
 * used when enough songs share the same model and size; otherwise every
 * song uses the metadata embedding. Mixing spaces would make distances meaningless.
 */
export function chooseGalaxySpace(songs = [], { preference = 'auto', minAudioSongs = 12, minAudioShare = 0.25, gemmaVectors = null } = {}) {
  const groups = new Map();
  for (const song of songs) {
    const resolved = resolveSongAudioVector(song, gemmaVectors);
    if (!resolved) continue;
    const id = `${resolved.model}|${resolved.dimensions}`;
    if (!groups.has(id)) groups.set(id, { model: resolved.model, dimensions: resolved.dimensions, items: [] });
    groups.get(id).items.push({ song, vector: resolved.vector });
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

function dot(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return Math.max(-1, Math.min(1, sum));
}

function addWeighted(target, vec, weight) {
  if (!vec || !weight || vec.length !== target.length) return;
  for (let i = 0; i < target.length; i++) target[i] += vec[i] * weight;
}

function unitFloat32(arr) {
  let sumSq = 0;
  for (let i = 0; i < arr.length; i++) sumSq += arr[i] * arr[i];
  const norm = Math.sqrt(sumSq);
  if (!(norm > 1e-8)) return null;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i] / norm;
  return out;
}

function percentileRange(values, loP = 0.08, hiP = 0.94) {
  if (!values.length) return { lo: 0, hi: 1 };
  const sorted = [...values].sort((a, b) => a - b);
  const lo = sorted[Math.floor((sorted.length - 1) * loP)];
  const hi = sorted[Math.ceil((sorted.length - 1) * hiP)];
  return { lo, hi: hi > lo + 1e-6 ? hi : lo + 1e-6 };
}

/**
 * Computes per-song taste focus, recent-vs-baseline interest shift, status labels,
 * and constellation neighbor links without mutating or re-clustering 3D geometry.
 */
export function computeGalaxyTasteOverlay(points = [], {
  mode = 'metadata',
  gemmaVectors = null,
  playbackEvents = [],
  likedSongKeys = [],
  currentSong = null,
  recentDays = 7,
  now = Date.now(),
} = {}) {
  if (!points.length) {
    return { metricsByKey: new Map(), edges: [], clusterSummary: new Map(), hasSignal: false };
  }

  const vectors = new Array(points.length);
  const vectorByKey = new Map();
  let dims = 0;
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    const resolved = mode === 'audio' ? resolveSongAudioVector(point, gemmaVectors) : null;
    const vec = resolved?.vector || getSongEmbedding(point);
    vectors[i] = vec;
    if (vec?.length) {
      if (!dims) dims = vec.length;
      vectorByKey.set(point.songKey, vec);
    }
  }

  const likedSet = new Set(likedSongKeys || []);
  const songStats = new Map();
  const ensureStat = key => {
    let row = songStats.get(key);
    if (!row) {
      row = { positive: 0, recentPositive: 0, negative: 0, plays: 0, skips: 0, lastAt: 0 };
      songStats.set(key, row);
    }
    return row;
  };

  let latestEventMs = 0;
  for (const event of playbackEvents || []) {
    const parsed = typeof event?.createdAt === 'number' ? event.createdAt : Date.parse(event?.createdAt);
    if (Number.isFinite(parsed) && parsed > latestEventMs) latestEventMs = parsed;
  }
  const refNow = latestEventMs > 0 ? Math.min(now, latestEventMs) : now;
  const recentCutoff = refNow - (recentDays * DAY_MS);

  const baselineAcc = new Float32Array(dims || 1);
  const recentAcc = new Float32Array(dims || 1);
  let baselineMass = 0;
  let recentMass = 0;

  for (const event of playbackEvents || []) {
    const key = event?.songKey;
    if (!key) continue;
    const stat = ensureStat(key);
    if (event.eventType === 'playback-start' || event.eventType === 'playback-replay') stat.plays += 1;
    if (event.eventType === 'user-skip') stat.skips += 1;
    const ts = typeof event?.createdAt === 'number' ? event.createdAt : Date.parse(event?.createdAt);
    const eventTime = Number.isFinite(ts) ? ts : refNow;
    if (eventTime > stat.lastAt) stat.lastAt = eventTime;

    const w = outcomeWeight(event);
    const vec = vectorByKey.get(key);
    if (w > 0) {
      const decay = Math.pow(0.5, Math.max(0, refNow - eventTime) / (21 * DAY_MS));
      const mass = w * decay;
      stat.positive += mass;
      if (eventTime >= recentCutoff) stat.recentPositive += w;
      if (vec && vec.length === dims) {
        addWeighted(baselineAcc, vec, mass);
        baselineMass += mass;
        if (eventTime >= recentCutoff) {
          addWeighted(recentAcc, vec, w);
          recentMass += w;
        }
      }
    } else if (w < 0) {
      stat.negative += Math.abs(w);
      if (vec && vec.length === dims && eventTime >= recentCutoff) {
        addWeighted(recentAcc, vec, w * 0.45);
      }
    }
  }

  for (const point of points) {
    const key = point.songKey;
    const vec = vectorByKey.get(key);
    const isLiked = likedSet.has(key);
    const curatedCount = Array.isArray(point.playlistKeys)
      ? point.playlistKeys.filter(pk => pk && pk !== '__listening_history__').length
      : 0;
    const bonus = (isLiked ? 0.9 : 0) + (!isLiked && curatedCount ? Math.min(0.45, 0.25 + 0.1 * (curatedCount - 1)) : 0);
    if (bonus > 0) {
      ensureStat(key).positive += bonus;
      if (vec && vec.length === dims) {
        addWeighted(baselineAcc, vec, bonus);
        baselineMass += bonus;
      }
    }
  }

  const currentKey = currentSong ? (currentSong.songKey || getSongKey(currentSong)) : '';
  const currentVec = currentKey ? vectorByKey.get(currentKey) : null;
  if (currentVec && currentVec.length === dims) {
    addWeighted(recentAcc, currentVec, Math.max(1.2, recentMass * 0.35 + 1.2));
    recentMass += 1.2;
  }

  const baselineVec = baselineMass > 0 ? unitFloat32(baselineAcc) : null;
  const recentVec = recentMass > 0 ? unitFloat32(recentAcc) : baselineVec;
  const hasSignal = Boolean(baselineVec || recentVec);

  const rawFocus = new Float32Array(points.length);
  const rawShift = new Float32Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const vec = vectors[i];
    const stat = songStats.get(points[i].songKey);
    const simBase = (baselineVec && vec) ? dot(vec, baselineVec) : 0;
    const simRecent = (recentVec && vec) ? dot(vec, recentVec) : simBase;
    const netPos = stat ? Math.min(1.5, stat.positive - 0.65 * stat.negative) : 0;
    const isSkipped = Boolean(stat && stat.skips > 0 && stat.negative >= stat.positive);
    rawFocus[i] = hasSignal
      ? (0.62 * simRecent) + (0.38 * simBase) + (0.16 * netPos) + (stat?.recentPositive ? 0.14 : 0) - (isSkipped ? 0.32 : 0)
      : 0.5;
    rawShift[i] = hasSignal
      ? (simRecent - simBase) + (stat?.recentPositive ? 0.16 : 0) - (isSkipped ? 0.28 : 0)
      : 0;
  }

  const focusRange = percentileRange(rawFocus, 0.12, 0.94);
  const shiftMag = Math.max(0.08, ...rawShift.map(v => Math.abs(v)));
  const metricsByKey = new Map();
  const clusterSummary = new Map();

  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    const stat = songStats.get(point.songKey);
    const isCurrent = Boolean(currentKey && point.songKey === currentKey);
    const isLiked = likedSet.has(point.songKey);
    const isSkipped = Boolean(stat && stat.skips > 0 && stat.negative > stat.positive);
    const normFocus = hasSignal
      ? Math.max(0.06, Math.min(1, (rawFocus[i] - focusRange.lo) / (focusRange.hi - focusRange.lo)))
      : 0.72;
    const focus = isCurrent ? 1 : (isSkipped ? Math.min(0.22, normFocus * 0.4) : normFocus);
    const delta = hasSignal ? Math.max(-1, Math.min(1, rawShift[i] / shiftMag)) : 0;

    let status = 'core';
    if (isCurrent) status = 'playing';
    else if (isSkipped) status = 'skipped';
    else if (hasSignal && focus < 0.34) status = delta < -0.22 ? 'fading' : 'dim';
    else if (hasSignal && (delta > 0.24 || (stat?.recentPositive > 0 && focus >= 0.55))) status = 'rising';
    else if (hasSignal && delta < -0.26) status = 'fading';

    const matchPct = Math.round(Math.max(5, Math.min(99, focus * 100)));
    const entry = {
      focus,
      delta,
      status,
      matchPct,
      plays: stat?.plays || 0,
      skips: stat?.skips || 0,
      isLiked,
    };
    metricsByKey.set(point.songKey, entry);

    let summary = clusterSummary.get(point.clusterId);
    if (!summary) {
      summary = { sumFocus: 0, count: 0, risingCount: 0, coreCount: 0 };
      clusterSummary.set(point.clusterId, summary);
    }
    summary.sumFocus += focus;
    summary.count += 1;
    if (status === 'rising') summary.risingCount += 1;
    if (focus >= 0.6) summary.coreCount += 1;
  }

  // Constellation bridge links from current playing track (or strongest focus anchor) to top neighbors
  const edges = [];
  let anchorIndex = currentKey ? points.findIndex(p => p.songKey === currentKey) : -1;
  if (anchorIndex < 0 && hasSignal) {
    let bestF = -1;
    for (let i = 0; i < points.length; i++) {
      const f = metricsByKey.get(points[i].songKey)?.focus ?? 0;
      if (f > bestF) { bestF = f; anchorIndex = i; }
    }
  }
  const anchorVec = anchorIndex >= 0 ? vectors[anchorIndex] : null;
  if (anchorVec && anchorVec.length === dims) {
    const scoredNeighbors = [];
    for (let i = 0; i < points.length; i++) {
      if (i === anchorIndex || !vectors[i] || vectors[i].length !== dims) continue;
      const focusBonus = (metricsByKey.get(points[i].songKey)?.focus ?? 0.5) * 0.22;
      scoredNeighbors.push({ index: i, score: dot(anchorVec, vectors[i]) + focusBonus });
    }
    scoredNeighbors.sort((a, b) => b.score - a.score);
    for (const nbr of scoredNeighbors.slice(0, 7)) {
      edges.push([anchorIndex, nbr.index, Math.max(0.2, Math.min(1, nbr.score))]);
    }
  }

  return { metricsByKey, edges, clusterSummary, hasSignal, anchorIndex };
}

/**
 * Summarises a playing star's musical traits (genre, feel, tempo, key, cluster)
 * and computes how a transition path arrived from the previous star.
 */
export function describeGalaxyTrackAndTransition(point, {
  prevPoint = null,
  cluster = null,
  gemmaVectors = null,
} = {}) {
  if (!point) return null;
  const genres = getSongGenres(point).filter(label => !GENERIC_LABELS.has(label));
  const moods = getSongMoods(point).filter(label => !GENERIC_LABELS.has(label));
  const energyVal = Number(point.energy);
  const bpmVal = Number(point.bpm);

  const energyFeel = Number.isFinite(energyVal)
    ? (energyVal >= 0.7 ? 'High energy' : energyVal >= 0.42 ? 'Mid-groove' : 'Low-key chill')
    : '';
  const feelParts = [...moods.slice(0, 2)];
  if (energyFeel && !feelParts.some(m => m.toLowerCase().includes(energyFeel.split(' ')[0].toLowerCase()))) {
    feelParts.push(energyFeel);
  }

  let transition = null;
  if (prevPoint && prevPoint.songKey !== point.songKey) {
    const prevKey = prevPoint.songKey || getSongKey(prevPoint);
    const curKey = point.songKey || getSongKey(point);
    const prevAudio = resolveSongAudioVector(prevPoint, gemmaVectors)?.vector || getSongEmbedding(prevPoint);
    const curAudio = resolveSongAudioVector(point, gemmaVectors)?.vector || getSongEmbedding(point);
    const soundCos = (prevAudio && curAudio && prevAudio.length === curAudio.length) ? dot(prevAudio, curAudio) : null;

    const prevG = gemmaVectors?.get?.(prevKey);
    const curG = gemmaVectors?.get?.(curKey);
    const seamCos = (prevG?.endVector && curG?.startVector && prevG.endVector.length === curG.startVector.length)
      ? dot(prevG.endVector, curG.startVector)
      : null;

    const prevBpm = Number(prevPoint.bpm);
    const bpmDelta = (Number.isFinite(bpmVal) && bpmVal > 0 && Number.isFinite(prevBpm) && prevBpm > 0)
      ? Math.round(bpmVal - prevBpm)
      : null;

    transition = {
      fromTrack: prevPoint.track || 'Previous track',
      fromArtist: prevPoint.artist || '',
      sameCluster: prevPoint.clusterId === point.clusterId,
      soundMatchPct: soundCos !== null ? Math.round(Math.max(0, Math.min(99, ((soundCos + 1) / 2) * 100))) : null,
      seamMatchPct: seamCos !== null ? Math.round(Math.max(0, Math.min(99, ((seamCos + 1) / 2) * 100))) : null,
      bpmDelta,
    };
  }

  return {
    genre: genres[0] || point.genre || 'Open format',
    feel: feelParts.join(' · ') || 'Atmospheric',
    bpm: Number.isFinite(bpmVal) && bpmVal > 0 ? Math.round(bpmVal) : null,
    musicalKey: point.musicalKey || '',
    energyPct: Number.isFinite(energyVal) ? Math.round(Math.max(0, Math.min(100, energyVal * 100))) : null,
    clusterLabel: cluster?.label || 'Cluster',
    clusterSize: cluster?.songs?.length || 0,
    transition,
  };
}
