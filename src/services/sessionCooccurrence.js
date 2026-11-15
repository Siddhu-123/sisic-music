import { getSongKey } from '../songIdentity.js';

const SESSION_GAP_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function asMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function groupSessionItems(events = []) {
  const ordered = (Array.isArray(events) ? events : [])
    .map(ev => ({ ev, ts: asMs(ev?.createdAt) }))
    .filter(item => item.ev?.songKey && item.ts !== null)
    .sort((a, b) => a.ts - b.ts);

  const sessions = [];
  let current = null;
  let lastQueue = null;
  let lastTs = null;

  for (const { ev, ts } of ordered) {
    const qid = ev.queueId || ev.sessionId || null;
    const sameQueue = qid && lastQueue && qid === lastQueue;
    const withinGap = lastTs !== null && (ts - lastTs) <= SESSION_GAP_MS;
    if (!current || (!sameQueue && !withinGap)) {
      current = [];
      sessions.push(current);
    }
    current.push({ ev, ts });
    lastQueue = qid;
    lastTs = ts;
  }

  return sessions.map(bucket => {
    const tracks = [];
    const byTrackIndex = new Map();
    for (const { ev, ts } of bucket) {
      const key = ev.songKey || getSongKey(ev);
      if (!key) continue;
      if (ev.eventType === 'playback-start' || ev.eventType === 'playback-replay' || !byTrackIndex.has(key)) {
        const prev = tracks[tracks.length - 1];
        if (!prev || prev.songKey !== key) {
          const item = { songKey: key, ts, weight: ev.eventType === 'playback-replay' ? 1.15 : 0.35, skipped: false };
          byTrackIndex.set(key, item);
          tracks.push(item);
        }
      }
      const item = byTrackIndex.get(key);
      if (!item) continue;
      if (ev.eventType === 'playback-complete' || ev.eventType === 'playback-replay' || ev.eventType === 'song-like') {
        item.weight = Math.max(item.weight, ev.eventType === 'playback-replay' ? 1.25 : 1.0);
        item.skipped = false;
      } else if (ev.eventType === 'user-skip') {
        item.skipped = true;
        item.weight = Math.min(item.weight, 0);
      }
    }
    return tracks;
  });
}

/**
 * Builds an Ochiai-normalized directed session co-occurrence & transition graph from playback events.
 */
export function buildSessionCooccurrenceGraph(events = [], {
  now = Date.now(),
  halfLifeDays = 180,
  windowSize = 4,
  shrinkage = 2.5,
  maxNeighborsPerSong = 40,
} = {}) {
  const sessions = groupSessionItems(events);
  const currentMs = typeof now === 'number' ? now : (asMs(now) ?? Date.now());
  const songMass = new Map();
  const rawEdges = new Map();

  const bumpEdge = (fromKey, toKey, value) => {
    let row = rawEdges.get(fromKey);
    if (!row) {
      row = new Map();
      rawEdges.set(fromKey, row);
    }
    row.set(toKey, (row.get(toKey) || 0) + value);
  };

  for (const tracks of sessions) {
    const positives = tracks.filter(t => t.weight > 0 && !t.skipped);
    if (positives.length < 2) continue;

    for (let i = 0; i < positives.length; i++) {
      const a = positives[i];
      const decay = halfLifeDays > 0
        ? Math.pow(0.5, Math.max(0, currentMs - a.ts) / (halfLifeDays * DAY_MS))
        : 1;
      const effDecay = 0.25 + 0.75 * decay;
      const massA = a.weight * effDecay;
      songMass.set(a.songKey, (songMass.get(a.songKey) || 0) + massA);

      const maxJ = Math.min(positives.length - 1, i + windowSize);
      for (let j = i + 1; j <= maxJ; j++) {
        const b = positives[j];
        if (b.songKey === a.songKey) continue;
        const dist = j - i;
        const stepWeight = (dist === 1 ? 1.5 : 1 / dist) * effDecay * Math.min(a.weight, b.weight);
        bumpEdge(a.songKey, b.songKey, stepWeight);
        // Include weaker reverse co-occurrence so bidirectional sessions stay discoverable.
        bumpEdge(b.songKey, a.songKey, stepWeight * 0.45);
      }
    }
  }

  const neighbors = new Map();
  let edgeCount = 0;

  for (const [fromKey, row] of rawEdges.entries()) {
    const massA = songMass.get(fromKey) || 1;
    const scored = [];
    for (const [toKey, w] of row.entries()) {
      const massB = songMass.get(toKey) || 1;
      const normScore = w / (Math.sqrt(massA * massB) + shrinkage);
      if (normScore > 0.005) {
        scored.push([toKey, Math.min(1, normScore * 2.5)]);
      }
    }
    scored.sort((a, b) => b[1] - a[1]);
    const trimmed = scored.slice(0, maxNeighborsPerSong);
    if (trimmed.length) {
      neighbors.set(fromKey, new Map(trimmed));
      edgeCount += trimmed.length;
    }
  }

  return {
    neighbors,
    songMass,
    sessionCount: sessions.length,
    edgeCount,
  };
}

/**
 * Extracts ordered positive anchor songKeys from recent playback history for transition lookup.
 */
export function extractRecentAnchorKeys(events = [], maxAnchors = 3) {
  const seen = new Set();
  const skipped = new Set();
  const anchors = [];
  for (let i = events.length - 1; i >= 0 && anchors.length < maxAnchors; i--) {
    const ev = events[i];
    if (!ev?.songKey) continue;
    if (ev.eventType === 'user-skip') {
      skipped.add(ev.songKey);
      continue;
    }
    if (ev.eventType === 'user-prev' || skipped.has(ev.songKey) || seen.has(ev.songKey)) continue;
    seen.add(ev.songKey);
    anchors.push(ev.songKey);
  }
  return anchors;
}

/**
 * Computes bounded [0, 1] collaborative transition score for candidateKey given ordered anchorKeys.
 */
export function scoreCooccurrenceCandidate(graph, anchorKeys = [], candidateKey = '') {
  if (!graph?.neighbors?.size || !anchorKeys?.length || !candidateKey) return 0;
  let scoreSum = 0;
  let weightSum = 0;
  for (let i = 0; i < anchorKeys.length; i++) {
    const anchor = anchorKeys[i];
    if (!anchor || anchor === candidateKey) continue;
    const w = Math.pow(0.55, i);
    weightSum += w;
    const row = graph.neighbors.get(anchor);
    if (row) {
      scoreSum += w * (row.get(candidateKey) || 0);
    }
  }
  return weightSum > 0 ? Math.min(1, scoreSum / weightSum) : 0;
}

/**
 * Returns top collaborative candidate songKeys for Stage-1 candidate injection.
 */
export function topCooccurrenceCandidates(graph, anchorKeys = [], limit = 120) {
  if (!graph?.neighbors?.size || !anchorKeys?.length) return [];
  const totals = new Map();
  const exclude = new Set(anchorKeys);
  for (let i = 0; i < anchorKeys.length; i++) {
    const anchor = anchorKeys[i];
    const row = graph.neighbors.get(anchor);
    if (!row) continue;
    const w = Math.pow(0.55, i);
    for (const [songKey, val] of row.entries()) {
      if (exclude.has(songKey)) continue;
      totals.set(songKey, (totals.get(songKey) || 0) + w * val);
    }
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([songKey]) => songKey);
}

/** Serializes the compact co-occurrence graph for IndexedDB or portable JSON packs. */
export function serializeCooccurrenceGraph(graph) {
  if (!graph?.neighbors) return null;
  const rows = [];
  for (const [songKey, map] of graph.neighbors.entries()) {
    rows.push([
      songKey,
      [...map.entries()].map(([target, score]) => [target, Number(score.toFixed(4))]),
    ]);
  }
  return {
    version: 1,
    sessionCount: graph.sessionCount || 0,
    edgeCount: graph.edgeCount || 0,
    rows,
  };
}

/** Rehydrates a serialized co-occurrence graph back into fast Map lookups. */
export function deserializeCooccurrenceGraph(serialized) {
  if (!serialized || !Array.isArray(serialized.rows)) return null;
  const neighbors = new Map();
  let edgeCount = 0;
  for (const entry of serialized.rows) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [songKey, list] = entry;
    if (!songKey || !Array.isArray(list) || !list.length) continue;
    neighbors.set(songKey, new Map(list));
    edgeCount += list.length;
  }
  return {
    neighbors,
    songMass: new Map(),
    sessionCount: serialized.sessionCount || 0,
    edgeCount,
  };
}
