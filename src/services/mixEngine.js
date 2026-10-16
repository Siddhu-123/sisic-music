// ExploreView does not load Gemma rows yet; collections are exposed through buildExploreMixes options.
import { computeAffinities, createSessionSteer, outcomeWeight, pairTransitionStats, pickWithExploration, transitionPenalty } from './behaviourLearning.js';
import { orderForFlow, nextFlowPick, transitionCost } from './flowPath.js';
import { getSongGenres, getSongMoods } from './exploreService.js';

const keyOf = song => song?.songKey || song?.id || '';
const rowOf = (ctx, key) => ctx?.gemmaVectors?.get?.(key) || ctx?.vectors?.get?.(key) || null;
const unit = vector => {
  if (!vector || !vector.length) return null;
  const values = Array.from(vector, Number);
  if (values.some(value => !Number.isFinite(value))) return null;
  const norm = Math.hypot(...values);
  return norm ? values.map(value => value / norm) : null;
};
const cosine = (a, b) => {
  if (!a || !b || a.length !== b.length) return -1;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
};
const affinityValue = (ctx, key) => {
  const entry = ctx?.affinities?.get?.(key);
  return Number(typeof entry === 'object' ? entry?.score : entry) || 0;
};
const withAffinities = ctx => ctx?.affinities instanceof Map || !ctx?.events?.length
  ? ctx : { ...ctx, affinities: computeAffinities(ctx.events, { now: ctx.now || new Date() }) };
const vectorSongs = ctx => (ctx?.songs || []).filter(song => unit(rowOf(ctx, keyOf(song))?.vector));
const vectorOf = (ctx, song) => unit(rowOf(ctx, keyOf(song))?.vector);
const facetText = value => Array.isArray(value) ? value.join(', ') : String(value || '');
const centroid = (songs, ctx, weighted = false) => {
  const first = songs.map(song => vectorOf(ctx, song)).find(Boolean);
  if (!first) return null;
  const sum = new Array(first.length).fill(0);
  for (const song of songs) {
    const vector = vectorOf(ctx, song);
    if (!vector || vector.length !== sum.length) continue;
    const weight = weighted ? Math.max(0.05, 1 + affinityValue(ctx, keyOf(song))) : 1;
    for (let i = 0; i < sum.length; i++) sum[i] += vector[i] * weight;
  }
  return unit(sum);
};
const flowItem = (ctx, song) => {
  const row = rowOf(ctx, keyOf(song));
  const vector = unit(row?.vector);
  if (!vector) return null;
  return {
    id: keyOf(song), song, vector,
    start: unit(row.startVector) || vector,
    end: unit(row.endVector) || vector,
    bpm: Number(song.bpm) || null,
    key: song.key || song.camelot || song.musicalKey || null,
    energy: Number.isFinite(Number(song.energy)) ? Number(song.energy) : null,
  };
};
const flowOptions = (ctx, extra = {}) => {
  const stats = ctx?.pairStats || pairTransitionStats(ctx?.events || []);
  return {
    timeBudgetMs: ctx?.timeBudgetMs,
    totalBudgetMs: ctx?.totalBudgetMs,
    extraCost: (a, b) => transitionPenalty(stats, a.id, b.id),
    ...extra,
  };
};
const orderSongs = (songs, ctx, opts = {}) => {
  const items = songs.map(song => flowItem(ctx, song)).filter(Boolean);
  if (!items.length) return [];
  const result = orderForFlow(items, flowOptions(ctx, opts));
  const byId = new Map(items.map(item => [item.id, item.song]));
  return result.order.map(id => byId.get(id)).filter(Boolean);
};
function byVector(query, songs, ctx) {
  const target = unit(query);
  if (!target) return [];
  return songs.map(song => ({ song, score: cosine(target, vectorOf(ctx, song)) }))
    .filter(item => item.score > -1).sort((a, b) => b.score - a.score).map(item => item.song);
}
function expand(seed, ctx, size) {
  const pool = vectorSongs(ctx);
  const seedKeys = new Set(seed.map(keyOf));
  const target = ctx?.textVector ? unit(ctx.textVector) : centroid(seed, ctx);
  const ranked = byVector(target, pool, ctx);
  const limit = Math.max(seed.length, Math.floor(size || 40));
  return [...seed.filter(song => rowOf(ctx, keyOf(song))?.vector), ...ranked.filter(song => !seedKeys.has(keyOf(song)))].slice(0, limit);
}

export function buildArtistMix(seedArtist, ctx = {}, { size = 40 } = {}) {
  ctx = withAffinities(ctx);
  const seed = vectorSongs(ctx).filter(song => String(song.artist || '').toLowerCase() === String(seedArtist || '').toLowerCase());
  return orderSongs(expand(seed, ctx, size), ctx);
}
export function buildDecadeMix(decade, ctx = {}) {
  ctx = withAffinities(ctx);
  const start = Number(String(decade).match(/\d{4}/)?.[0] || decade);
  const seed = vectorSongs(ctx).filter(song => {
    const year = Number(song.year || String(song.releaseDate || '').slice(0, 4));
    return Number.isFinite(start) && Math.floor(year / 10) * 10 === Math.floor(start / 10) * 10;
  });
  return orderSongs(expand(seed, ctx, ctx.size || 40), ctx);
}
export function buildGenreMix(genre, ctx = {}) {
  ctx = withAffinities(ctx);
  const seed = vectorSongs(ctx).filter(song => getSongGenres({
    ...song, track: song.track || song.title,
    genre: [facetText(song.genres), facetText(song.genre)].filter(Boolean).join(', '),
  }).some(label => label.toLowerCase() === String(genre).toLowerCase()));
  return orderSongs(expand(seed, ctx, ctx.size || 40), ctx);
}
export function buildMoodMix(mood, ctx = {}) {
  ctx = withAffinities(ctx);
  const wanted = String(mood).toLowerCase();
  const seed = vectorSongs(ctx).filter(song => {
    const direct = Array.isArray(song.moods) ? song.moods : facetText(song.moods).split(/[,/|;&]+/);
    return direct.some(label => String(label).trim().toLowerCase() === wanted) || getSongMoods({
      ...song, track: song.track || song.title,
      genre: [facetText(song.genres), facetText(song.genre), facetText(song.moods)].filter(Boolean).join(' '),
    }).some(label => label.toLowerCase() === wanted);
  });
  return orderSongs(expand(seed, ctx, ctx.size || 40), ctx);
}
export function buildTextMix(textVector, ctx = {}, { size = 40 } = {}) {
  ctx = withAffinities(ctx);
  return orderSongs(byVector(textVector, vectorSongs(ctx), ctx).slice(0, size), ctx);
}
export function buildNicheMix(ctx = {}) {
  ctx = withAffinities(ctx);
  const pool = vectorSongs(ctx);
  const center = centroid(pool, ctx);
  return orderSongs(pool.map(song => ({ song, distance: 1 - cosine(center, vectorOf(ctx, song)) }))
    .filter(item => affinityValue(ctx, keyOf(item.song)) >= 0)
    .sort((a, b) => b.distance - a.distance).slice(0, ctx.size || 40).map(item => item.song), ctx);
}

function hashSeed(value) {
  let seed = 2166136261;
  for (const char of String(value)) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  return seed >>> 0;
}
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => { state += 0x6D2B79F5; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function labelMix(songs) {
  const counts = new Map();
  for (const song of songs) for (const label of [song.artist, ...getSongGenres(song)]) if (label) counts.set(label, (counts.get(label) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || 'Daily discovery';
}
export function buildDailyMixes(ctx = {}, { count = 6, size = 30 } = {}) {
  ctx = withAffinities(ctx);
  const pool = vectorSongs(ctx);
  if (!pool.length) return [];
  const vectors = pool.map(song => vectorOf(ctx, song));
  const k = Math.max(1, Math.min(pool.length, Math.floor(count)));
  const date = ctx.date || new Date(ctx.now || Date.now()).toISOString().slice(0, 10);
  const random = seededRandom(hashSeed(date));
  const centers = [vectors[Math.floor(random() * vectors.length)]];
  while (centers.length < k) {
    const weights = vectors.map(vector => Math.max(0.0001, 1 - Math.max(...centers.map(center => cosine(vector, center)))));
    const total = weights.reduce((a, b) => a + b, 0);
    let draw = random() * total;
    let pick = weights.length - 1;
    for (let i = 0; i < weights.length; i++) { draw -= weights[i]; if (draw <= 0) { pick = i; break; } }
    centers.push(vectors[pick]);
  }
  const assignments = new Array(pool.length).fill(0);
  for (let iteration = 0; iteration < 10; iteration++) {
    const sums = Array.from({ length: k }, () => new Array(vectors[0].length).fill(0));
    const mass = new Array(k).fill(0);
    vectors.forEach((vector, i) => {
      let best = 0;
      for (let c = 1; c < k; c++) if (cosine(vector, centers[c]) > cosine(vector, centers[best])) best = c;
      assignments[i] = best;
      const weight = Math.max(0.05, 1 + affinityValue(ctx, keyOf(pool[i])));
      mass[best] += weight;
      for (let d = 0; d < vector.length; d++) sums[best][d] += vector[d] * weight;
    });
    for (let c = 0; c < k; c++) if (mass[c]) centers[c] = unit(sums[c]) || centers[c];
  }
  return centers.map((center, cluster) => {
    const ranked = pool.map((song, i) => ({ song, score: 0.45 * affinityValue(ctx, keyOf(song)) + 0.55 * cosine(center, vectors[i]) }))
      .filter((_, i) => assignments[i] === cluster).sort((a, b) => b.score - a.score).slice(0, Math.max(size, 10));
    const rng = seededRandom(hashSeed(`${date}:${cluster}`));
    const selected = [];
    const remaining = [...ranked];
    while (remaining.length && selected.length < size) {
      const picked = pickWithExploration(remaining, { epsilon: 0.1, rng, pool: Math.max(6, Math.ceil(size * 0.35)) });
      selected.push(picked);
      remaining.splice(remaining.findIndex(item => keyOf(item.song) === keyOf(picked)), 1);
    }
    const songs = orderSongs(selected.map(item => item.song), ctx);
    return { id: `daily-${date}-${cluster + 1}`, title: labelMix(songs), subtitle: 'A fresh mix from your library', songs };
  }).filter(mix => mix.songs.length);
}

export function buildDevilMix(ctx = {}) {
  const songs = vectorSongs(ctx);
  if (!songs.length) return [];
  const ordered = orderSongs(songs, ctx, { startId: ctx.seedKey, timeBudgetMs: ctx.timeBudgetMs ?? 2000, totalBudgetMs: ctx.totalBudgetMs ?? 2350 });
  return ordered;
}
export function buildLongMix(ctx = {}, { minutes = 180, seedKey } = {}) {
  const ordered = buildDevilMix({ ...ctx, seedKey: seedKey || ctx.seedKey });
  const budget = Math.max(0, Number(minutes)) * 60;
  let total = 0;
  return ordered.filter(song => {
    const duration = Number(song.duration) || 0;
    if (total && total + duration > budget) return false;
    total += duration;
    return true;
  });
}

export function createInfiniteMix(ctx = {}, { seedKey, rng = Math.random } = {}) {
  const songs = vectorSongs(ctx);
  const items = songs.map(song => flowItem(ctx, song)).filter(Boolean);
  const byId = new Map(items.map(item => [item.id, item]));
  const history = [];
  const steer = ctx.sessionSteer || createSessionSteer();
  const random = typeof rng === 'function' ? rng : Math.random;
  let current = byId.get(seedKey) || null;
  if (current) history.push(current.id);
  const opts = flowOptions(ctx);
  return {
    next() {
      if (!items.length) return null;
      const recent = new Set(history.slice(-50));
      let candidates = items.filter(item => !recent.has(item.id));
      if (!candidates.length) return null;
      const base = current ? nextFlowPick(current, candidates, { history, avoidRecent: 50, opts, rng: random }) : candidates[0];
      const ranked = candidates.map(item => ({ ...item, vector: item.vector, baseScore: current ? -transitionCost(current, item, opts) : 0 }));
      const steered = steer.rerank(ranked, { mix: 0.55 });
      const hasSteer = Boolean(steer.state);
      const selected = hasSteer ? steered[0] : (steered.find(item => item.id === base?.id) || steered[0]);
      const picked = pickWithExploration(steered, { epsilon: 0.1, rng: random, pool: Math.min(30, steered.length) });
      current = byId.get(picked?.id || selected?.id);
      if (!current) return null;
      history.push(current.id);
      return current.song;
    },
    observe(event = {}) {
      const key = event.songKey || current?.id;
      const vector = unit(rowOf(ctx, key)?.vector || current?.vector);
      if (!vector) return;
      const weight = outcomeWeight(event);
      if (weight) steer.observe(vector, weight);
      if (event.queueReplaceDirection) steer.applyQueueReplace(event.queueReplaceDirection, event.skipsInPreviousQueue || 1);
    },
  };
}
