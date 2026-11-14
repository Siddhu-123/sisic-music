const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_KEY = date => date.toISOString().slice(0, 10);

export const WEIGHTS = Object.freeze({
  earlySkip: -1.0,
  skip: -0.5,
  lateSkip: -0.15,
  nearCompleteSkip: -0.05,
  complete: 0.5,
  replay: 1.0,
  like: 1.5,
  unlike: -1.0,
  searchPlay: 0.8,
});

export const MAP_PRIOR_WEIGHTS = Object.freeze([1.0, 0.7, 0.35, -0.5, -0.25, 0.15]);

const asTime = value => {
  const time = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) ? time : null;
};

function eventPosition(event) {
  const position = Number(event.positionSeconds);
  return Number.isFinite(position) ? Math.max(0, position) : 0;
}

export function outcomeWeight(event = {}) {
  switch (event.eventType) {
    case 'unexpected-playback-skip':
    case 'playback-short-ended':
    case 'playback-error':
      return 0;
    // Session-ending navigation is neutral; only user-skip carries a negative song judgement.
    case 'user-prev': return 0;
    case 'user-skip': {
      const position = eventPosition(event);
      const duration = Number(event.durationSeconds);
      if (position < 10) return WEIGHTS.earlySkip;
      if (Number.isFinite(duration) && duration > 0 && position / duration >= 0.8) return WEIGHTS.nearCompleteSkip;
      if (position <= 60) return WEIGHTS.skip;
      return WEIGHTS.lateSkip;
    }
    case 'playback-complete': return WEIGHTS.complete;
    case 'playback-replay': return WEIGHTS.replay;
    case 'song-like': return WEIGHTS.like;
    case 'song-unlike': return WEIGHTS.unlike;
    case 'playback-start': return event.sourceType === 'search' ? WEIGHTS.searchPlay : 0;
    default: return 0;
  }
}

function decayFor(event, now, halfLifeDays) {
  const time = asTime(event.createdAt);
  if (time === null || !Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return time === null ? 1 : 0;
  return Math.pow(0.5, Math.max(0, now - time) / (halfLifeDays * DAY_MS));
}

function dateNow(value) {
  const time = asTime(value);
  return new Date(time === null ? Date.now() : time);
}

export function computeAffinities(events = [], { now = new Date(), halfLifeDays = 21 } = {}) {
  const current = dateNow(now).getTime();
  const result = new Map();
  for (const event of events) {
    if (!event?.songKey) continue;
    let row = result.get(event.songKey);
    if (!row) {
      row = { score: 0, plays: 0, skips: 0, lastAt: null };
      result.set(event.songKey, row);
    }
    const weight = outcomeWeight(event);
    row.score += weight * decayFor(event, current, halfLifeDays);
    if (event.eventType === 'playback-start' || event.eventType === 'playback-replay') row.plays += 1;
    if (event.eventType === 'user-skip') row.skips += 1;
    const timestamp = asTime(event.createdAt);
    if (timestamp !== null && (row.lastAt === null || timestamp > asTime(row.lastAt))) row.lastAt = new Date(timestamp).toISOString();
  }
  return result;
}

// Returns a Map from YYYY-MM-DD to the un-decayed sum of that day's outcomes.
export function dailyAffinity(events = [], { now = new Date() } = {}) {
  const today = dateNow(now);
  today.setUTCHours(0, 0, 0, 0);
  const result = new Map();
  for (let offset = 29; offset >= 0; offset--) {
    const date = new Date(today.getTime() - offset * DAY_MS);
    result.set(DAY_KEY(date), 0);
  }
  for (const event of events) {
    const timestamp = asTime(event.createdAt);
    if (timestamp === null) continue;
    const date = new Date(timestamp);
    const key = DAY_KEY(date);
    if (result.has(key)) result.set(key, result.get(key) + outcomeWeight(event));
  }
  return result;
}

function unit(vector) {
  if (!Array.isArray(vector) && !ArrayBuffer.isView(vector)) return null;
  const values = Array.from(vector, Number);
  if (!values.length || values.some(value => !Number.isFinite(value))) return null;
  let sumSquares = 0;
  for (const value of values) sumSquares += value * value;
  const norm = Math.sqrt(sumSquares);
  return norm > 0 ? values.map(value => value / norm) : null;
}

function meanUnit(vectors) {
  const usable = vectors.map(unit).filter(Boolean);
  if (!usable.length) return null;
  const dimensions = usable[0].length;
  const mean = new Array(dimensions).fill(0);
  for (const vector of usable) {
    if (vector.length !== dimensions) continue;
    for (let index = 0; index < dimensions; index++) mean[index] += vector[index];
  }
  return unit(mean);
}

export function queueReplaceSignals(events = [], vectorOf = () => null) {
  const signals = [];
  for (const replacement of events) {
    if (replacement.eventType !== 'queue-replaced' || Number(replacement.skipsInPreviousQueue) < 2) continue;
    const previousQueueId = replacement.previousQueueId;
    const cutoff = asTime(replacement.createdAt);
    const played = events.filter(event => event.queueId === previousQueueId
      && event.songKey
      && ['playback-start', 'playback-complete', 'playback-replay', 'user-prev'].includes(event.eventType)
      && (cutoff === null || asTime(event.createdAt) === null || asTime(event.createdAt) <= cutoff))
      .sort((a, b) => (asTime(a.createdAt) ?? 0) - (asTime(b.createdAt) ?? 0))
      .slice(-5);
    const direction = meanUnit(played.map(event => vectorOf(event.songKey)));
    if (!direction) continue;
    signals.push({
      queueId: previousQueueId ?? replacement.queueId ?? null,
      direction,
      weight: Math.min(1, Math.max(0, Number(replacement.skipsInPreviousQueue) / 5)),
    });
  }
  return signals;
}

function dot(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 0;
  let value = 0;
  for (let index = 0; index < a.length; index++) value += a[index] * b[index];
  return Math.max(-1, Math.min(1, value));
}

export function createSessionSteer({ alpha = 0.25, beta = 0.35, decay = 0.9 } = {}) {
  let state = null;
  const steer = {
    get state() { return state ? [...state] : null; },
    observe(vector, weight = 1) {
      const direction = unit(vector);
      if (!direction || !Number.isFinite(Number(weight))) return this;
      if (state && state.length !== direction.length) state = null;
      const strength = Number(weight) >= 0 ? alpha * Number(weight) : beta * Number(weight);
      const next = direction.map((value, index) => value * strength + (state?.[index] || 0) * decay);
      state = unit(next);
      return this;
    },
    applyQueueReplace(direction, weight = 1) {
      const away = unit(direction);
      if (!away || !Number.isFinite(Number(weight))) return this;
      if (state && state.length !== away.length) return this;
      const next = away.map((value, index) => (state?.[index] || 0) * decay - value * beta * Math.max(0, Number(weight)));
      state = unit(next);
      return this;
    },
    score(candidateVector) { return state ? dot(state, unit(candidateVector)) : 0; },
    rerank(candidates = [], { mix = 0.35 } = {}) {
      return candidates.map((candidate, index) => {
        const steerScore = this.score(candidate.vector);
        return { ...candidate, steerScore, rerankScore: (1 - mix) * Number(candidate.baseScore || 0) + mix * steerScore, _index: index };
      }).sort((a, b) => b.rerankScore - a.rerankScore || a._index - b._index)
        .map(({ _index, ...candidate }) => candidate);
    },
    toJSON() { return { state: state ? [...state] : null, alpha, beta, decay }; },
    fromJSON(value = {}) {
      state = unit(value.state);
      return this;
    },
  };
  return steer;
}

createSessionSteer.fromJSON = value => createSessionSteer(value).fromJSON(value);

export function pairTransitionStats(events = []) {
  const byQueue = new Map();
  for (const event of events) {
    if (!event.queueId || !event.songKey) continue;
    if (!byQueue.has(event.queueId)) byQueue.set(event.queueId, []);
    byQueue.get(event.queueId).push(event);
  }
  const stats = new Map();
  for (const queueEvents of byQueue.values()) {
    queueEvents.sort((a, b) => (asTime(a.createdAt) ?? 0) - (asTime(b.createdAt) ?? 0));
    const starts = queueEvents.filter(event => event.eventType === 'playback-start' || event.eventType === 'playback-replay');
    for (let index = 1; index < starts.length; index++) {
      const from = starts[index - 1];
      const to = starts[index];
      if (from.songKey === to.songKey) continue;
      const key = `${from.songKey}=>${to.songKey}`;
      const row = stats.get(key) || { plays: 0, skips: 0, earlySkips: 0 };
      row.plays++;
      const startTime = asTime(to.createdAt);
      const endTime = index + 1 < starts.length ? asTime(starts[index + 1].createdAt) : null;
      const outcomes = queueEvents.filter(event => event.songKey === to.songKey
        && event.eventType === 'user-skip'
        && startTime !== null
        && asTime(event.createdAt) !== null
        && asTime(event.createdAt) >= startTime
        && (endTime === null || asTime(event.createdAt) < endTime));
      if (outcomes.length) {
        row.skips++;
        if (eventPosition(outcomes[0]) < 60) row.earlySkips++;
      }
      stats.set(key, row);
    }
  }
  return stats;
}

function pairDifference(pair) {
  if (Array.isArray(pair) && pair.length === 2) {
    return pair[0].map((value, index) => Number(value) - Number(pair[1][index]));
  }
  if (Array.isArray(pair?.difference)) return pair.difference.map(Number);
  if (Array.isArray(pair?.diff)) return pair.diff.map(Number);
  const preferred = pair?.posFeatures ?? pair?.preferred ?? pair?.positive ?? pair?.winner;
  const rejected = pair?.negFeatures ?? pair?.rejected ?? pair?.negative ?? pair?.loser;
  if (Array.isArray(preferred) && Array.isArray(rejected)) {
    return preferred.map((value, index) => Number(value) - Number(rejected[index]));
  }
  throw new TypeError('Each pair must contain preferred and rejected feature vectors, or a difference vector');
}

/** Fits six pairwise logistic weights with a Gaussian prior and sign-preserving bounds. */
export function trainMapPairwiseWeights(pairs, {
  prior = MAP_PRIOR_WEIGHTS,
  lambda = 12.0,
  delta = 0.4,
  lr = 0.05,
  epochs = 35,
} = {}) {
  const center = Array.from(prior, Number);
  if (center.length !== 6 || center.some(value => !Number.isFinite(value))) {
    throw new TypeError('prior must contain six finite weights');
  }
  const rows = Array.from(pairs || [], pair => ({
    diff: pairDifference(pair),
    weight: Math.max(0.01, Number(pair?.weight ?? 1) || 1),
  }));
  if (rows.some(r => r.diff.length !== center.length || r.diff.some(value => !Number.isFinite(value)))) {
    throw new TypeError('Pair feature vectors must contain six finite values');
  }
  if (!rows.length) return [...center];
  const bounds = center.map(value => {
    let low = value - Math.abs(delta);
    let high = value + Math.abs(delta);
    if (value > 0) low = Math.max(low, value >= 0.05 ? 0.05 : Number.EPSILON);
    if (value < 0) high = Math.min(high, value <= -0.05 ? -0.05 : -Number.EPSILON);
    return [low, high];
  });
  const weights = [...center];
  const step = Math.max(0, Number(lr) || 0);
  const regularization = Math.max(0, Number(lambda) || 0);
  const count = Math.max(0, Math.floor(Number(epochs) || 0));
  const totalWeight = rows.reduce((sum, r) => sum + r.weight, 0) || 1;
  for (let epoch = 0; epoch < count; epoch++) {
    const dataGrad = new Array(weights.length).fill(0);
    for (const { diff, weight } of rows) {
      const margin = weights.reduce((sum, w, index) => sum + w * diff[index], 0);
      const factor = (-1 / (1 + Math.exp(Math.max(-40, Math.min(40, margin))))) * weight;
      for (let index = 0; index < weights.length; index++) dataGrad[index] += factor * diff[index];
    }
    for (let index = 0; index < weights.length; index++) {
      const grad = (dataGrad[index] / totalWeight) + (regularization / totalWeight) * (weights[index] - center[index]);
      weights[index] = Math.max(bounds[index][0], Math.min(bounds[index][1], weights[index] - step * grad));
    }
  }
  return weights;
}

export function transitionPenalty(stats, fromKey, toKey) {
  const row = stats?.get(`${fromKey}=>${toKey}`);
  if (!row) return 0;
  return Math.max(0, Math.min(1, Number(row.skips || 0) / (Number(row.plays || 0) + 1)));
}

export function pickWithExploration(ranked = [], { epsilon = 0.1, rng = Math.random, pool = 30 } = {}) {
  if (!ranked.length) return undefined;
  const tail = ranked.slice(5, Math.max(5, Math.floor(pool)));
  if (tail.length && rng() < Math.max(0, Math.min(1, epsilon))) {
    const selected = tail[Math.min(tail.length - 1, Math.floor(rng() * tail.length))];
    return { ...selected, explore: true };
  }
  return ranked[0];
}

export const SKIP_MODEL_FEATURES = Object.freeze([
  'affinity', 'steerScore', 'transitionPenalty', 'hourOfDay', 'sourceType', 'positionInQueue',
]);

let skipPredictor = null;
export function registerSkipPredictor(fn) {
  if (typeof fn !== 'function') throw new TypeError('Skip predictor must be a function');
  skipPredictor = fn;
}
export function clearSkipPredictor() { skipPredictor = null; }

// Default logistic heuristic: bias -0.4, affinity -0.35, steerScore -0.7,
// transition penalty +1.4, hourOfDay 0, search source -0.8, queue position -0.025.
export function predictSkip(features = {}) {
  if (skipPredictor) return skipPredictor(features);
  const source = features.sourceType === 'search' ? -0.8 : 0;
  const x = -0.4
    - 0.35 * Number(features.affinity || 0)
    - 0.7 * Number(features.steerScore || 0)
    + 1.4 * Number(features.transitionPenalty || 0)
    + 0 * Number(features.hourOfDay || 0)
    + source
    - 0.025 * Number(features.positionInQueue || 0);
  return 1 / (1 + Math.exp(-x));
}

function affinityFor(affinities, songKey) {
  const value = affinities instanceof Map ? affinities.get(songKey) : affinities?.[songKey];
  return Number(typeof value === 'object' ? value?.score : value) || 0;
}

export function buildSkipTrainingRows(events = [], { vectorOf = () => null, affinities = new Map(), steerVector = null } = {}) {
  const rows = [];
  const session = createSessionSteer();
  for (const event of events) {
    let label;
    if ((event.eventType === 'user-skip') && eventPosition(event) < 60) label = 1;
    else if (event.eventType === 'playback-complete') label = 0;
    else continue;
    const timestamp = asTime(event.createdAt);
    const hourOfDay = timestamp === null ? 0 : new Date(timestamp).getHours();
    const vector = vectorOf(event.songKey);
    const steerScore = steerVector && vector
      ? dot(unit(steerVector), unit(vector))
      : vector ? session.score(vector) : Number(event.steerScore || 0);
    rows.push({
      affinity: affinityFor(affinities, event.songKey),
      steerScore,
      transitionPenalty: Number(event.transitionPenalty || 0),
      hourOfDay,
      sourceType: event.sourceType || 'unknown',
      positionInQueue: Number(event.positionInQueue ?? event.queuePosition ?? 0),
      label,
    });
    const weight = outcomeWeight(event);
    if (vector && weight !== 0) session.observe(vector, weight);
  }
  return rows;
}
