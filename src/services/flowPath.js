const DEFAULT_WEIGHTS = { wSim: 1, wTempo: 0.3, wKey: 0.2, wEnergy: 0.15 };

function validNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function endpoint(item, name) {
  return item?.[name] ?? item?.vector;
}

function cosine(a, b) {
  if (!a || !b) return 0;
  let dot = 0;
  for (let i = 0, length = Math.min(a.length, b.length); i < length; i += 1) dot += a[i] * b[i];
  return Math.max(-1, Math.min(1, dot));
}

function tempoDistance(a, b) {
  if (!validNumber(a) || !validNumber(b) || a <= 0 || b <= 0) return 0.35;
  const ratios = [b, b * 2, b / 2];
  let difference = 1;
  for (const adjusted of ratios) difference = Math.min(difference, Math.abs(a - adjusted) / Math.max(a, adjusted));
  return Math.min(1, difference);
}

function parseCamelot(key) {
  if (typeof key !== 'string') return null;
  const match = /^(1[0-2]|[1-9])([AB])$/i.exec(key.trim());
  return match ? { number: Number(match[1]), letter: match[2].toUpperCase() } : null;
}

function keyDistance(a, b) {
  const left = parseCamelot(a);
  const right = parseCamelot(b);
  if (!left || !right) return 0.35;
  if (left.number === right.number && left.letter === right.letter) return 0;
  const linear = Math.abs(left.number - right.number);
  const wheel = Math.min(linear, 12 - linear);
  return Math.min(1, (wheel + (left.letter === right.letter ? 0 : 1)) / 4);
}

function energyDelta(a, b) {
  if (!validNumber(a) || !validNumber(b)) return 0.25;
  return Math.abs(a - b);
}

/** Lower transition costs indicate a smoother handoff from a to b. */
export function transitionCost(a, b, opts = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...opts };
  const similarity = 1 - cosine(endpoint(a, 'end'), endpoint(b, 'start'));
  const tempo = tempoDistance(a?.bpm, b?.bpm);
  const key = keyDistance(a?.key, b?.key);
  const energy = energyDelta(a?.energy, b?.energy);
  const learned = typeof opts.extraCost === 'function' ? (Number(opts.extraCost(a, b)) || 0) : 0;
  return (similarity * weights.wSim)
    + (tempo * weights.wTempo)
    + (key * weights.wKey)
    + (energy * weights.wEnergy)
    + learned;
}

function insertBest(best, index, dot, k) {
  if (best.length < k) {
    best.push({ index, dot });
    return;
  }
  let worst = 0;
  for (let i = 1; i < best.length; i += 1) {
    if (best[i].dot < best[worst].dot || (best[i].dot === best[worst].dot && best[i].index > best[worst].index)) worst = i;
  }
  if (dot > best[worst].dot || (dot === best[worst].dot && index < best[worst].index)) best[worst] = { index, dot };
}

function sortBest(best) {
  return best.sort((a, b) => b.dot - a.dot || a.index - b.index).map(entry => entry.index);
}

function exactVectorNeighbours(items, k, deadline) {
  const result = Array.from({ length: items.length }, () => []);
  for (let i = 0; i < items.length; i += 1) {
    const best = [];
    const a = items[i]?.vector;
    for (let j = 0; j < items.length; j += 1) {
      if (i !== j) insertBest(best, j, vectorDot(a, items[j]?.vector), k);
      if ((j & 255) === 255 && Date.now() >= deadline) break;
    }
    result[i] = sortBest(best);
    if (Date.now() >= deadline) break;
  }
  return result;
}

/** Approximate vector-neighbour lists, with exact search for small inputs. */
export function vectorNeighbours(items, k = 24, { deadline = Infinity } = {}) {
  const n = items?.length ?? 0;
  const count = Math.max(0, Math.floor(Number(k) || 0));
  const result = Array.from({ length: n }, () => []);
  if (n < 2 || count === 0) return result;
  if (n <= 1500) return exactVectorNeighbours(items, count, deadline);

  let dimensions = 0;
  for (const item of items) dimensions = Math.max(dimensions, Math.min(64, item?.vector?.length ?? 0));
  if (!dimensions || Date.now() >= deadline) return result;

  const vectors = new Float32Array(n * dimensions);
  for (let i = 0; i < n; i += 1) {
    const vector = items[i]?.vector;
    let norm = 0;
    for (let d = 0; d < dimensions; d += 1) {
      const value = Number(vector?.[d]) || 0;
      vectors[(i * dimensions) + d] = value;
      norm += value * value;
    }
    if (norm > 0) {
      const scale = 1 / Math.sqrt(norm);
      for (let d = 0; d < dimensions; d += 1) vectors[(i * dimensions) + d] *= scale;
    }
    if ((i & 255) === 255 && Date.now() >= deadline) return result;
  }

  const clusterCount = Math.max(2, Math.min(n, Math.round(Math.sqrt(n))));
  const centroids = new Float32Array(clusterCount * dimensions);
  let seed = 0x6d2b79f5;
  const randomIndex = () => {
    seed = (Math.imul(seed ^ (seed >>> 15), seed | 1) + 0x6d2b79f5) | 0;
    seed ^= seed + Math.imul(seed ^ (seed >>> 7), seed | 61);
    return ((seed ^ (seed >>> 14)) >>> 0) % n;
  };
  for (let c = 0; c < clusterCount; c += 1) {
    const source = (c === 0) ? 0 : randomIndex();
    centroids.set(vectors.subarray(source * dimensions, (source + 1) * dimensions), c * dimensions);
  }
  const assignments = new Int32Array(n);
  const sums = new Float64Array(clusterCount * dimensions);
  const sizes = new Uint32Array(clusterCount);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    if (Date.now() >= deadline) return result;
    sums.fill(0);
    sizes.fill(0);
    for (let i = 0; i < n; i += 1) {
      let bestCluster = 0;
      let bestDot = -Infinity;
      const offset = i * dimensions;
      for (let c = 0; c < clusterCount; c += 1) {
        let dot = 0;
        const centroidOffset = c * dimensions;
        for (let d = 0; d < dimensions; d += 1) dot += vectors[offset + d] * centroids[centroidOffset + d];
        if (dot > bestDot) { bestDot = dot; bestCluster = c; }
      }
      assignments[i] = bestCluster;
      sizes[bestCluster] += 1;
      const sumOffset = bestCluster * dimensions;
      for (let d = 0; d < dimensions; d += 1) sums[sumOffset + d] += vectors[offset + d];
      if ((i & 127) === 127 && Date.now() >= deadline) return result;
    }
    for (let c = 0; c < clusterCount; c += 1) {
      if (!sizes[c]) continue;
      const offset = c * dimensions;
      let norm = 0;
      for (let d = 0; d < dimensions; d += 1) {
        const value = sums[offset + d] / sizes[c];
        centroids[offset + d] = value;
        norm += value * value;
      }
      if (norm > 0) {
        const scale = 1 / Math.sqrt(norm);
        for (let d = 0; d < dimensions; d += 1) centroids[offset + d] *= scale;
      }
    }
  }

  const members = Array.from({ length: clusterCount }, () => []);
  for (let i = 0; i < n; i += 1) members[assignments[i]].push(i);
  for (let i = 0; i < n; i += 1) {
    if (Date.now() >= deadline) break;
    const own = assignments[i];
    const nearby = [];
    const vectorOffset = i * dimensions;
    for (let c = 0; c < clusterCount; c += 1) {
      let dot = 0;
      const centroidOffset = c * dimensions;
      for (let d = 0; d < dimensions; d += 1) dot += vectors[vectorOffset + d] * centroids[centroidOffset + d];
      if (c !== own) insertBest(nearby, c, dot, 3);
    }
    const candidates = [...members[own]];
    for (const cluster of sortBest(nearby)) candidates.push(...members[cluster]);
    const best = [];
    for (const j of candidates) {
      if (i === j) continue;
      let dot = 0;
      const candidateOffset = j * dimensions;
      for (let d = 0; d < dimensions; d += 1) dot += vectors[vectorOffset + d] * vectors[candidateOffset + d];
      insertBest(best, j, dot, count);
    }
    result[i] = sortBest(best);
  }
  return result;
}

/** Nearest-neighbour ordering from startId, or from the first item. */
export function greedyPath(items, { startId, opts = {}, neighbours } = {}) {
  if (!items?.length) return [];
  const near = neighbours ?? vectorNeighbours(items, 24);
  const byId = new Map(items.map(item => [item.id, item]));
  const itemIndex = new Map(items.map((item, index) => [item.id, index]));
  let current = byId.get(startId) ?? items[0];
  const remaining = new Set(items);
  remaining.delete(current);
  const order = [current.id];
  while (remaining.size) {
    let best = null;
    let bestCost = Infinity;
    const candidates = (near[itemIndex.get(current.id)] ?? [])
      .map(index => items[index])
      .filter(candidate => remaining.has(candidate));
    if (!candidates.length) {
      const sampleSize = Math.min(256, remaining.size);
      const stride = Math.max(1, Math.floor(remaining.size / sampleSize));
      let index = 0;
      for (const candidate of remaining) {
        if (index % stride === 0) candidates.push(candidate);
        index += 1;
        if (candidates.length >= sampleSize) break;
      }
    }
    for (const candidate of candidates) {
      const cost = transitionCost(current, candidate, opts);
      if (cost < bestCost) {
        best = candidate;
        bestCost = cost;
      }
    }
    order.push(best.id);
    remaining.delete(best);
    current = best;
  }
  return order;
}

function vectorDot(a, b) {
  let dot = 0;
  for (let i = 0, length = Math.min(a?.length ?? 0, b?.length ?? 0); i < length; i += 1) dot += a[i] * b[i];
  return dot;
}

function pathCost(ids, byId, opts) {
  let total = 0;
  for (let i = 1; i < ids.length; i += 1) total += transitionCost(byId.get(ids[i - 1]), byId.get(ids[i]), opts);
  return total;
}

/** Improve an open path with directed 2-opt reversals and vector-neighbour candidates. */
export function improve2opt(order, items, {
  opts = {},
  maxIterations = 40,
  timeBudgetMs = 2000,
  candidateK,
  neighbours,
} = {}) {
  const result = [...(order ?? [])];
  const n = result.length;
  if (n < 3 || !items?.length || maxIterations <= 0 || timeBudgetMs <= 0) return result;
  const byId = new Map(items.map(item => [item.id, item]));
  const itemIndex = new Map(items.map((item, index) => [item.id, index]));
  const k = Math.max(1, Math.floor(candidateK ?? opts.candidateK ?? 12));
  const deadline = Date.now() + timeBudgetMs;
  const near = neighbours ?? vectorNeighbours(items, k, { deadline });
  const pathItems = result.map(id => byId.get(id));

  for (let iteration = 0; iteration < maxIterations && Date.now() < deadline; iteration += 1) {
    const positions = new Map(result.map((id, index) => [itemIndex.get(id), index]));
    const reversePrefix = new Float64Array(n);
    for (let i = 0; i < n - 1; i += 1) {
      reversePrefix[i + 1] = reversePrefix[i]
        + transitionCost(pathItems[i + 1], pathItems[i], opts)
        - transitionCost(pathItems[i], pathItems[i + 1], opts);
    }
    const seen = new Set();
    let bestDelta = -1e-12;
    let bestStart = -1;
    let bestEnd = -1;
    let checked = 0;
    for (let itemPos = 0; itemPos < n; itemPos += 1) {
      const sourceIndex = itemIndex.get(result[itemPos]);
      for (const targetIndex of near[sourceIndex] ?? []) {
        const targetPos = positions.get(targetIndex);
        if (targetPos === undefined || targetPos === itemPos) continue;
        const start = Math.min(itemPos, targetPos);
        const end = Math.max(itemPos, targetPos);
        const key = (start * n) + end;
        if (seen.has(key)) continue;
        seen.add(key);
        if (end - start < 1) continue;
        const oldLeft = start > 0 ? transitionCost(pathItems[start - 1], pathItems[start], opts) : 0;
        const oldRight = end < n - 1 ? transitionCost(pathItems[end], pathItems[end + 1], opts) : 0;
        const newLeft = start > 0 ? transitionCost(pathItems[start - 1], pathItems[end], opts) : 0;
        const newRight = end < n - 1 ? transitionCost(pathItems[start], pathItems[end + 1], opts) : 0;
        const internal = reversePrefix[end] - reversePrefix[start];
        const delta = (newLeft + newRight + internal) - (oldLeft + oldRight);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestStart = start;
          bestEnd = end;
        }
        checked += 1;
        if ((checked & 255) === 0 && Date.now() >= deadline) break;
      }
      if (Date.now() >= deadline) break;
    }
    if (bestStart < 0) break;
    for (let left = bestStart, right = bestEnd; left < right; left += 1, right -= 1) {
      [result[left], result[right]] = [result[right], result[left]];
      [pathItems[left], pathItems[right]] = [pathItems[right], pathItems[left]];
    }
  }
  return result;
}

/** Greedy seed followed by 2-opt improvement. */
export function orderForFlow(items, opts = {}) {
  const started = Date.now();
  const overallBudgetMs = Math.min(2350, opts.totalBudgetMs ?? 2350);
  const deadline = started + overallBudgetMs;
  const buildBudgetMs = items.length <= 1500 ? overallBudgetMs - 300 : Math.min(800, overallBudgetMs * 0.35);
  const buildDeadline = Math.min(deadline - 150, started + buildBudgetMs);
  const neighbours = vectorNeighbours(items, Math.max(24, opts.candidateK ?? 0), { deadline: buildDeadline });
  const order = greedyPath(items, { startId: opts.startId, opts, neighbours });
  const remainingBudgetMs = Math.max(1, deadline - Date.now());
  const improved = improve2opt(order, items, {
    opts,
    maxIterations: opts.maxIterations ?? 40,
    timeBudgetMs: Math.min(opts.timeBudgetMs ?? 2000, remainingBudgetMs),
    candidateK: opts.candidateK,
    neighbours,
  });
  const byId = new Map(items.map(item => [item.id, item]));
  return { order: improved, totalCost: pathCost(improved, byId, opts) };
}

/** Pick a low-cost next track while avoiding recent history when possible. */
export function nextFlowPick(currentItem, candidates, {
  history = [],
  avoidRecent = 50,
  opts = {},
  rng = Math.random,
} = {}) {
  if (!candidates?.length) return null;
  const recent = new Set((avoidRecent > 0 ? history.slice(-avoidRecent) : []).map(entry => (
    entry && typeof entry === 'object' ? entry.id : entry
  )));
  let eligible = candidates.filter(candidate => !recent.has(candidate.id));
  if (!eligible.length) eligible = [...candidates];
  const ranked = eligible.map(item => ({ item, cost: transitionCost(currentItem, item, opts) }))
    .sort((a, b) => a.cost - b.cost);
  const best = ranked[0].cost;
  const nearTies = ranked.slice(0, 3).filter(entry => entry.cost - best <= Math.max(0.02, Math.abs(best) * 0.05));
  const random = Math.max(0, Math.min(0.999999999999, Number(rng()) || 0));
  return nearTies[Math.floor(random * nearTies.length)].item;
}
