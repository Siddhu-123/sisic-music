// Multi-interest taste modelling. A single mean vector blurs distinct tastes
// together (a metal fan who also loves jazz gets a centroid that sounds like
// neither). Following PinnerSage (Pal et al., KDD 2020) and MIND (Li et al.,
// CIKM 2019) a listener is represented by a few interest vectors instead, and
// a song is scored against the interest it fits best.
//
// This module is a leaf: it imports nothing from the app, so any service can use it.

export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function dot(a, b) {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < length; i++) sum += a[i] * b[i];
  return sum;
}

/** Unit-length copy as a plain array, or null for empty/zero/non-finite input. */
export function unit(values) {
  if (!values || !values.length) return null;
  let sumSq = 0;
  for (let i = 0; i < values.length; i++) {
    const value = Number(values[i]);
    if (!Number.isFinite(value)) return null;
    sumSq += value * value;
  }
  const norm = Math.sqrt(sumSq);
  if (!norm) return null;
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = values[i] / norm;
  return out;
}

function weightedSum(vectors, weights, dims) {
  const sum = new Float64Array(dims);
  for (let i = 0; i < vectors.length; i++) {
    const weight = weights[i];
    if (!weight) continue;
    const vector = vectors[i];
    for (let d = 0; d < dims; d++) sum[d] += vector[d] * weight;
  }
  return sum;
}

/**
 * Spherical k-means: vectors are compared by cosine and each centroid is the
 * re-normalised weighted mean, which matches how songs are ranked later.
 * Seeding is weighted k-means++ on cosine distance with a fixed seed, so the
 * same history always yields the same interests.
 */
function sphericalKMeans(vectors, weights, k, { iterations = 25, seed = 11 } = {}) {
  const n = vectors.length;
  const dims = vectors[0].length;
  const random = mulberry32(seed + n * 31 + k);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

  // Seed the first centre in proportion to weight, later ones by cosine distance.
  const pick = scores => {
    const total = scores.reduce((sum, score) => sum + score, 0);
    if (!(total > 0)) return Math.floor(random() * n);
    let target = random() * total;
    for (let i = 0; i < n; i++) {
      target -= scores[i];
      if (target <= 0) return i;
    }
    return n - 1;
  };
  const centroids = [Array.from(vectors[pick(weights)])];
  while (centroids.length < k) {
    const distances = vectors.map((vector, i) => {
      let best = -Infinity;
      for (const centroid of centroids) best = Math.max(best, dot(vector, centroid));
      return weights[i] * Math.max(0, 1 - best);
    });
    centroids.push(Array.from(vectors[pick(distances)]));
  }

  const assignments = new Array(n).fill(-1);
  for (let iteration = 0; iteration < iterations; iteration++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestScore = -Infinity;
      for (let c = 0; c < k; c++) {
        const score = dot(vectors[i], centroids[c]);
        if (score > bestScore) { bestScore = score; best = c; }
      }
      if (assignments[i] !== best) { assignments[i] = best; changed = true; }
    }
    if (!changed) break;
    for (let c = 0; c < k; c++) {
      const memberVectors = [];
      const memberWeights = [];
      for (let i = 0; i < n; i++) {
        if (assignments[i] === c) { memberVectors.push(vectors[i]); memberWeights.push(weights[i]); }
      }
      if (!memberVectors.length) continue;
      const next = unit(weightedSum(memberVectors, memberWeights, dims));
      if (next) centroids[c] = next;
    }
  }

  let cost = 0;
  for (let i = 0; i < n; i++) cost += weights[i] * (1 - dot(vectors[i], centroids[assignments[i]]));
  return { centroids, assignments, cost: totalWeight ? cost / totalWeight : 0 };
}

/**
 * Splits weighted, unit-length vectors into up to `maxInterests` interests.
 * A split is kept only when every resulting interest carries a meaningful
 * share of the listening AND the split makes the groups noticeably tighter,
 * so a listener with one broad taste is not chopped into arbitrary pieces.
 *
 * @param {{vector: ArrayLike<number>, weight: number}[]} items
 * @returns {{vector: number[], weight: number, size: number, members: number[]}[]}
 *   interests sorted by weight; `weight` is the share of total listening (sums to 1).
 */
export function buildInterests(items = [], {
  maxInterests = 4,
  minShare = 0.12,
  minClusterSize = 3,
  kappa = 4.0,
  minRelativeGain = 0.3,
  minAbsoluteGain = 0.04,
  seed = 11,
  gemmaVectors,
} = {}) {
  const valid = [];
  items.forEach((item, index) => {
    const gemmaVector = gemmaVectors?.get?.(item?.songKey)?.vector;
    // When a Gemma map is supplied it is authoritative; never mix it with a fallback space.
    const vector = unit(gemmaVectors ? gemmaVector : item?.vector);
    const weight = Number(item?.weight);
    if (vector && weight > 0 && Number.isFinite(weight)) valid.push({ vector, weight, index });
  });
  if (!valid.length) return [];

  const vectors = valid.map(item => item.vector);
  const weights = valid.map(item => item.weight);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const globalVector = unit(weightedSum(vectors, weights, vectors[0].length));

  const summarise = fit => fit.centroids
    .map((vector, c) => {
      const members = [];
      let weight = 0;
      valid.forEach((item, i) => {
        if (fit.assignments[i] === c) { members.push(item.index); weight += item.weight; }
      });
      const shrink = members.length / (members.length + Math.max(0, Number(kappa) || 0));
      const shrunk = globalVector
        ? unit(vector.map((value, d) => (shrink * value) + ((1 - shrink) * globalVector[d])))
        : vector;
      return { vector: shrunk ?? vector, weight: weight / totalWeight, size: members.length, members };
    })
    .filter(interest => interest.size > 0)
    .sort((a, b) => b.weight - a.weight);

  let best = sphericalKMeans(vectors, weights, 1, { seed });
  const limit = Math.min(maxInterests, valid.length);
  for (let k = 2; k <= limit; k++) {
    const candidate = sphericalKMeans(vectors, weights, k, { seed });
    const summary = summarise(candidate);
    const gain = best.cost - candidate.cost;
    const balanced = summary.length === k && summary.every(interest => interest.weight >= minShare);
    const largeEnough = valid.length < minClusterSize
      || (summary.length === k && summary.every(interest => interest.size >= minClusterSize));
    if (!balanced || !largeEnough || gain < minAbsoluteGain || gain < best.cost * minRelativeGain) break;
    best = candidate;
  }
  return summarise(best);
}

/**
 * How well a song fits a listener's interests: cosine to the closest interest,
 * gently discounted for interests that carry little of the listening. Falls back
 * to nothing (null) when there are no interests, so callers can use their own vector.
 */
export function interestAffinity(vector, interests = []) {
  if (!vector || !interests.length) return null;
  const heaviest = Math.max(...interests.map(interest => interest.weight)) || 1;
  let best = -Infinity;
  for (const interest of interests) {
    const raw = dot(vector, interest.vector);
    // Only discount positive fits; a poor match must never look better for a small interest.
    const similarity = raw > 0 ? raw * (0.8 + (0.2 * (interest.weight / heaviest))) : raw;
    if (similarity > best) best = similarity;
  }
  return best;
}

/** Smooth, session-aware aggregation of similarity across a listener's interests. */
export function scoreInterestsLogSumExp(vector, interests, {
  sessionVector = null,
  beta = 3.0,
  tau = 8.0,
} = {}) {
  if (!vector || !interests?.length) return null;
  const candidates = interests.filter(interest => interest?.vector
    && Number.isFinite(interest.weight) && interest.weight > 0);
  if (!candidates.length) return null;

  const activation = candidates.map(interest => {
    const sessionFit = sessionVector ? dot(sessionVector, interest.vector) : 0;
    return Math.log(interest.weight) + (sessionVector ? beta * sessionFit : 0);
  });
  const maxActivation = Math.max(...activation);
  const activated = activation.map(value => Math.exp(value - maxActivation));
  const totalActivation = activated.reduce((sum, value) => sum + value, 0);
  const similarities = candidates.map(interest => dot(vector, interest.vector));
  const scaled = similarities.map((similarity, i) => Math.log(activated[i] / totalActivation) + tau * similarity);
  const maxScaled = Math.max(...scaled);
  return (maxScaled + Math.log(scaled.reduce((sum, value) => sum + Math.exp(value - maxScaled), 0))) / tau;
}
