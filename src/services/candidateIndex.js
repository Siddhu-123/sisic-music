import { getSongKey } from '../songIdentity.js';

export const DEFAULT_FULL_SCAN_THRESHOLD = 8000;
export const DEFAULT_STAGE1_LIMIT = 4500;

const indexCache = new WeakMap();

function toNormalizedFloat32(vec, expectedDims = 0) {
  if (!vec || (!Array.isArray(vec) && !ArrayBuffer.isView(vec))) return null;
  const len = vec.length;
  if (!len || (expectedDims > 0 && len !== expectedDims)) return null;
  let normSq = 0;
  for (let i = 0; i < len; i++) {
    const v = Number(vec[i]);
    if (!Number.isFinite(v)) return null;
    normSq += v * v;
  }
  const norm = Math.sqrt(normSq);
  if (norm <= 0) return null;
  const out = new Float32Array(len);
  const inv = 1 / norm;
  for (let i = 0; i < len; i++) out[i] = Number(vec[i]) * inv;
  return out;
}

function l2NormalizeInPlace(buf, offset, dims) {
  let normSq = 0;
  for (let d = 0; d < dims; d++) {
    const v = buf[offset + d];
    normSq += v * v;
  }
  if (normSq <= 0) return false;
  const inv = 1 / Math.sqrt(normSq);
  for (let d = 0; d < dims; d++) buf[offset + d] *= inv;
  return true;
}

function fitFlatSphericalKmeans(flatVecs, indices, dims, k, maxIters = 8, seed = 42, secondaryThreshold = 0) {
  const count = indices.length;
  const actualK = Math.max(1, Math.min(k, count));
  const centroids = new Float32Array(actualK * dims);

  let state = (seed >>> 0) || 1;
  const nextRand = () => ((state = (1664525 * state + 1013904223) >>> 0) / 4294967296);

  const stride = Math.max(1, Math.floor(count / actualK));
  for (let c = 0; c < actualK; c++) {
    const srcIdx = indices[(c * stride + Math.floor(nextRand() * Math.min(stride, count))) % count];
    const srcOff = srcIdx * dims;
    const dstOff = c * dims;
    for (let d = 0; d < dims; d++) centroids[dstOff + d] = flatVecs[srcOff + d];
  }

  const trainCap = Math.min(count, Math.max(1024, actualK * 18));
  const trainStep = Math.max(1, Math.floor(count / trainCap));
  const sampleIndices = [];
  for (let i = 0; i < count && sampleIndices.length < trainCap; i += trainStep) {
    sampleIndices.push(indices[i]);
  }

  const nextSums = new Float32Array(actualK * dims);
  const counts = new Int32Array(actualK);

  for (let iter = 0; iter < maxIters; iter++) {
    nextSums.fill(0);
    counts.fill(0);
    for (let s = 0; s < sampleIndices.length; s++) {
      const idx = sampleIndices[s];
      const vOff = idx * dims;
      let bestC = 0;
      let bestDot = -Infinity;
      for (let c = 0; c < actualK; c++) {
        const cOff = c * dims;
        let dot = 0;
        for (let d = 0; d < dims; d++) dot += flatVecs[vOff + d] * centroids[cOff + d];
        if (dot > bestDot) {
          bestDot = dot;
          bestC = c;
        }
      }
      counts[bestC]++;
      const sumOff = bestC * dims;
      for (let d = 0; d < dims; d++) nextSums[sumOff + d] += flatVecs[vOff + d];
    }

    for (let c = 0; c < actualK; c++) {
      const off = c * dims;
      if (counts[c] > 0) {
        for (let d = 0; d < dims; d++) centroids[off + d] = nextSums[off + d];
        l2NormalizeInPlace(centroids, off, dims);
      } else {
        const fallbackIdx = sampleIndices[(c * 31) % sampleIndices.length];
        const srcOff = fallbackIdx * dims;
        for (let d = 0; d < dims; d++) centroids[off + d] = flatVecs[srcOff + d];
      }
    }
  }

  const assignments = new Int32Array(count);
  const secondaryAssignments = secondaryThreshold > 0 ? new Int32Array(count).fill(-1) : null;
  for (let i = 0; i < count; i++) {
    const idx = indices[i];
    const vOff = idx * dims;
    let bestC = 0;
    let bestDot = -Infinity;
    let secondC = -1;
    let secondDot = -Infinity;
    for (let c = 0; c < actualK; c++) {
      const cOff = c * dims;
      let dot = 0;
      for (let d = 0; d < dims; d++) dot += flatVecs[vOff + d] * centroids[cOff + d];
      if (dot > bestDot) {
        secondDot = bestDot;
        secondC = bestC;
        bestDot = dot;
        bestC = c;
      } else if (dot > secondDot) {
        secondDot = dot;
        secondC = c;
      }
    }
    assignments[i] = bestC;
    if (secondaryAssignments && secondC >= 0 && bestDot > 0 && secondDot >= bestDot * secondaryThreshold) {
      secondaryAssignments[i] = secondC;
    }
  }

  return { k: actualK, centroids, assignments, secondaryAssignments };
}

/**
 * Coarse-to-fine 2-level spherical k-means keeps pure-JS index construction O(N * sqrt(K))
 * instead of O(N * K), with optional boundary dual-assignment to cut Voronoi edge misses.
 */
function fitSphericalKmeansFast(flatVecs, validIndices, dims, targetK, maxIters = 8, seed = 42) {
  const count = validIndices.length;
  const totalSlots = flatVecs.length / dims;
  const clusterIds = new Int32Array(totalSlots).fill(-1);
  const secondaryIds = new Int32Array(totalSlots).fill(-1);

  if (targetK <= 64 || count < 1024) {
    const flat = fitFlatSphericalKmeans(flatVecs, validIndices, dims, targetK, maxIters, seed, 0.85);
    for (let i = 0; i < count; i++) {
      clusterIds[validIndices[i]] = flat.assignments[i];
      if (flat.secondaryAssignments) secondaryIds[validIndices[i]] = flat.secondaryAssignments[i];
    }
    return { k: flat.k, centroids: flat.centroids, clusterIds, secondaryIds };
  }

  // Assign each boundary point to top-2 coarse buckets if second centroid is within 85% cosine.
  const k1 = Math.max(8, Math.min(32, Math.round(Math.sqrt(targetK))));
  const coarse = fitFlatSphericalKmeans(flatVecs, validIndices, dims, k1, Math.min(6, maxIters), seed, 0.85);
  const coarseBuckets = Array.from({ length: coarse.k }, () => []);
  for (let i = 0; i < count; i++) {
    coarseBuckets[coarse.assignments[i]].push(validIndices[i]);
    if (coarse.secondaryAssignments && coarse.secondaryAssignments[i] >= 0) {
      coarseBuckets[coarse.secondaryAssignments[i]].push(validIndices[i]);
    }
  }

  const leafCentroidsList = [];
  const leafRanges = [];
  for (let b = 0; b < coarse.k; b++) {
    const bucketIndices = coarseBuckets[b];
    if (!bucketIndices.length) continue;
    const desiredSubK = Math.max(1, Math.round((bucketIndices.length / (count * 1.3)) * targetK));
    const fine = fitFlatSphericalKmeans(
      flatVecs,
      bucketIndices,
      dims,
      desiredSubK,
      Math.max(4, maxIters - 2),
      seed + b + 1,
      0.88,
    );
    const leafBase = leafCentroidsList.length;
    for (let c = 0; c < fine.k; c++) {
      leafCentroidsList.push(fine.centroids.subarray(c * dims, (c + 1) * dims));
    }
    leafRanges.push({ bucketIndices, leafBase, fine });
  }

  for (const { bucketIndices, leafBase, fine } of leafRanges) {
    for (let i = 0; i < bucketIndices.length; i++) {
      const itemIdx = bucketIndices[i];
      const primaryLeaf = leafBase + fine.assignments[i];
      if (clusterIds[itemIdx] < 0) clusterIds[itemIdx] = primaryLeaf;
      else if (secondaryIds[itemIdx] < 0 && primaryLeaf !== clusterIds[itemIdx]) secondaryIds[itemIdx] = primaryLeaf;

      if (fine.secondaryAssignments && fine.secondaryAssignments[i] >= 0) {
        const altLeaf = leafBase + fine.secondaryAssignments[i];
        if (secondaryIds[itemIdx] < 0 && altLeaf !== clusterIds[itemIdx]) secondaryIds[itemIdx] = altLeaf;
      }
    }
  }

  const totalK = leafCentroidsList.length;
  const centroids = new Float32Array(totalK * dims);
  for (let c = 0; c < totalK; c++) centroids.set(leafCentroidsList[c], c * dims);
  return { k: totalK, centroids, clusterIds, secondaryIds };
}

/**
 * Builds an IVF cluster index (~sqrt(N) clusters) over items with unit-normalized vectors.
 * Accepts precomputed pack centroids + clusterIds for instant O(N) setup, or fits fast
 * spherical k-means clusters in-memory.
 */
export function buildCandidateIndex(items = [], {
  getKey = item => item?.songKey || getSongKey(item),
  getVector = item => item?.vector || null,
  getClusterId = item => (Number.isInteger(item?.clusterId) ? item.clusterId : null),
  centroids: precomputedCentroids = null,
  nClusters = null,
  maxIters = 8,
  seed = 42,
} = {}) {
  const n = items.length;
  const keyToIndex = new Map();
  let dims = 0;
  const rawVectors = new Array(n);
  const validIndices = [];

  for (let i = 0; i < n; i++) {
    const item = items[i];
    const key = getKey(item);
    if (key && !keyToIndex.has(key)) keyToIndex.set(key, i);
    const vec = getVector(item, key, i);
    if (vec && vec.length > 0) {
      if (!dims) dims = vec.length;
      if (vec.length === dims) {
        rawVectors[i] = vec;
        validIndices.push(i);
      }
    }
  }

  // Track top-played items so popular tracks remain eligible regardless of cluster distance.
  const popularIndices = items
    .map((item, idx) => ({ idx, plays: Number(item?.playCount || 0) }))
    .filter(row => row.plays > 0)
    .sort((a, b) => b.plays - a.plays)
    .slice(0, 200)
    .map(row => row.idx);

  if (!dims || validIndices.length === 0) {
    return {
      size: n,
      dims: 0,
      k: 0,
      items,
      centroidData: new Float32Array(0),
      buckets: [],
      keyToIndex,
      popularIndices,
      unindexedIndices: items.map((_, i) => i),
    };
  }

  let k = 0;
  let centroidData = null;
  let clusterIds = new Int32Array(n).fill(-1);
  let secondaryIds = null;
  let usedPrecomputed = false;

  if (Array.isArray(precomputedCentroids) && precomputedCentroids.length > 0) {
    const candidateCentroids = new Float32Array(precomputedCentroids.length * dims);
    let ok = true;
    for (let c = 0; c < precomputedCentroids.length; c++) {
      const norm = toNormalizedFloat32(precomputedCentroids[c], dims);
      if (!norm) {
        ok = false;
        break;
      }
      candidateCentroids.set(norm, c * dims);
    }
    if (ok) {
      let assignedCount = 0;
      for (const idx of validIndices) {
        const cid = getClusterId(items[idx], idx);
        if (cid != null && cid >= 0 && cid < precomputedCentroids.length) {
          clusterIds[idx] = cid;
          assignedCount++;
        }
      }
      if (assignedCount === validIndices.length) {
        k = precomputedCentroids.length;
        centroidData = candidateCentroids;
        usedPrecomputed = true;
      }
    }
  }

  if (!usedPrecomputed) {
    const flatVecs = new Float32Array(n * dims);
    const filteredValid = [];
    for (const idx of validIndices) {
      const norm = toNormalizedFloat32(rawVectors[idx], dims);
      if (!norm) continue;
      flatVecs.set(norm, idx * dims);
      filteredValid.push(idx);
    }
    const desiredK = nClusters != null
      ? Number(nClusters)
      : Math.min(768, Math.max(16, Math.round(2.2 * Math.sqrt(filteredValid.length || 1))));
    const fitted = fitSphericalKmeansFast(flatVecs, filteredValid, dims, desiredK, maxIters, seed);
    k = fitted.k;
    centroidData = fitted.centroids;
    clusterIds = fitted.clusterIds;
    secondaryIds = fitted.secondaryIds;
  }

  const buckets = Array.from({ length: k }, () => []);
  const unindexedIndices = [];
  for (let i = 0; i < n; i++) {
    const cid = clusterIds[i];
    if (cid >= 0 && cid < k) {
      buckets[cid].push(i);
      const sid = secondaryIds ? secondaryIds[i] : -1;
      if (sid >= 0 && sid < k && sid !== cid) buckets[sid].push(i);
    } else {
      unindexedIndices.push(i);
    }
  }

  return {
    size: n,
    dims,
    k,
    items,
    centroidData,
    buckets,
    keyToIndex,
    popularIndices,
    unindexedIndices,
  };
}

/**
 * Retrieves or builds a cached IVF index keyed by items array reference + optional vector map.
 */
export function getOrBuildCandidateIndex(items = [], options = {}) {
  if (!Array.isArray(items)) return buildCandidateIndex([], options);
  const vectorKey = options.vectorSource || items;
  let perItems = indexCache.get(items);
  if (!perItems) {
    perItems = new WeakMap();
    indexCache.set(items, perItems);
  }
  const cacheTag = `${options.centroids?.length || 0}:${options.vectorMapSize || 0}`;
  const cached = perItems.get(vectorKey);
  if (cached && cached.tag === cacheTag) return cached.index;

  const built = buildCandidateIndex(items, options);
  perItems.set(vectorKey, { tag: cacheTag, index: built });
  return built;
}

/**
 * Selects up to ~targetSize candidates using Stage-1 cluster probing across active
 * taste/session/context/seed query vectors, always retaining liked, recent, and queued tracks.
 * Returns the full catalog untouched when below fullScanBelow (default 8,000 tracks).
 */
export function selectStage1Candidates(indexOrItems, {
  queryVectors = [],
  targetSize = DEFAULT_STAGE1_LIMIT,
  fullScanBelow = DEFAULT_FULL_SCAN_THRESHOLD,
  alwaysIncludeKeys = [],
  excludeKeys = [],
  indexOptions = {},
} = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const isIndex = Boolean(indexOrItems && !Array.isArray(indexOrItems) && Array.isArray(indexOrItems.items));
  const items = isIndex ? indexOrItems.items : (Array.isArray(indexOrItems) ? indexOrItems : []);

  if (items.length < fullScanBelow) {
    return {
      mode: 'full-scan',
      candidates: items,
      totalCount: items.length,
      candidateCount: items.length,
      clustersProbed: 0,
      totalClusters: isIndex ? indexOrItems.k : 0,
      latencyMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0,
    };
  }

  const index = isIndex ? indexOrItems : getOrBuildCandidateIndex(items, indexOptions);
  if (!index.dims || index.k === 0) {
    return {
      mode: 'full-scan',
      candidates: items,
      totalCount: items.length,
      candidateCount: items.length,
      clustersProbed: 0,
      totalClusters: 0,
      latencyMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0,
    };
  }

  const normalizedQueries = [];
  for (const q of queryVectors || []) {
    const raw = q?.vector || q;
    const weight = Number.isFinite(Number(q?.weight)) ? Math.max(0.05, Number(q.weight)) : 1;
    const norm = toNormalizedFloat32(raw, index.dims);
    if (norm) normalizedQueries.push({ vec: norm, weight });
  }

  if (normalizedQueries.length === 0) {
    return {
      mode: 'full-scan',
      candidates: items,
      totalCount: items.length,
      candidateCount: items.length,
      clustersProbed: 0,
      totalClusters: index.k,
      latencyMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0,
    };
  }

  const excludedMask = new Uint8Array(index.size);
  for (const key of excludeKeys || []) {
    const idx = index.keyToIndex.get(key);
    if (idx != null) excludedMask[idx] = 1;
  }

  const selectedMask = new Uint8Array(index.size);
  const candidates = [];
  const addIdx = idx => {
    if (idx < 0 || idx >= index.size || excludedMask[idx] || selectedMask[idx]) return;
    selectedMask[idx] = 1;
    candidates.push(index.items[idx]);
  };

  for (const key of alwaysIncludeKeys || []) {
    const idx = index.keyToIndex.get(key);
    if (idx != null) addIdx(idx);
  }
  for (const idx of index.popularIndices || []) addIdx(idx);

  // Score each cluster centroid by its best alignment across active query vectors.
  const clusterScores = new Array(index.k);
  const dims = index.dims;
  const cData = index.centroidData;
  for (let c = 0; c < index.k; c++) {
    const cOff = c * dims;
    let bestScore = -Infinity;
    for (let q = 0; q < normalizedQueries.length; q++) {
      const qVec = normalizedQueries[q].vec;
      const qW = normalizedQueries[q].weight;
      let dot = 0;
      for (let d = 0; d < dims; d++) dot += cData[cOff + d] * qVec[d];
      const weighted = dot * qW;
      if (weighted > bestScore) bestScore = weighted;
    }
    clusterScores[c] = { c, score: bestScore };
  }
  clusterScores.sort((a, b) => b.score - a.score);

  const desiredTotal = Math.max(1, Math.min(index.size, Math.floor(targetSize)));
  let clustersProbed = 0;
  for (let i = 0; i < clusterScores.length; i++) {
    if (candidates.length >= desiredTotal) break;
    const bucket = index.buckets[clusterScores[i].c];
    clustersProbed++;
    for (let b = 0; b < bucket.length; b++) addIdx(bucket[b]);
  }

  return {
    mode: 'ivf-stage1',
    candidates,
    totalCount: index.size,
    candidateCount: candidates.length,
    clustersProbed,
    totalClusters: index.k,
    latencyMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0,
  };
}
