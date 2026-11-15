import { db } from '../db.js';
import { getSongKey } from '../songIdentity.js';
import {
  MAP_PRIOR_WEIGHTS,
  buildSkipTrainingRows,
  clearSkipPredictor,
  computeAffinities,
  computeRocAuc,
  createSessionSteer,
  createSkipPredictorFromWeights,
  outcomeWeight,
  pairTransitionStats,
  registerSkipPredictor,
  SKIP_PRIOR_WEIGHTS,
  trainMapPairwiseWeights,
  trainSkipModel,
  transitionPenalty,
} from './behaviourLearning.js';
import {
  CONTEXTUAL_PRIOR_WEIGHTS,
  PLAYBACK_SESSION_GAP_MS,
  buildContextualTasteProfile,
  extractContextualCandidateFeatures,
  rankContextualSongs,
  resolveRankerWeights,
} from './contextualRecommendationService.js';
import {
  buildSessionCooccurrenceGraph,
  deserializeCooccurrenceGraph,
  extractRecentAnchorKeys,
  scoreCooccurrenceCandidate,
  serializeCooccurrenceGraph,
} from './sessionCooccurrence.js';

export const PERSONAL_RANKER_STORAGE_KEY = 'personalRankerState:v1';
export const EXTERNAL_HISTORY_STORAGE_KEY = 'externalHistoryPack:v1';
const DAY_MS = 24 * 60 * 60 * 1000;
const collabGraphCache = new WeakMap();

// Sign-preserving and scale-aware bounds per contextual feature weight.
export const CONTEXTUAL_DELTA_BOUNDS = Object.freeze([
  0.35,  // tasteAffinity (prior 0.52)
  0.25,  // staleTasteBoost (prior 0.30)
  0.25,  // sequenceBoost (prior 0.30)
  0.25,  // skipAffinity (prior -0.28)
  0.18,  // liked (prior 0.22)
  0.10,  // popularity (prior 0.14)
  0.035, // discovery (prior 0.05)
  0.35,  // recentPenalty (prior -1.0)
  0.15,  // steer (prior 0.20)
  0.20,  // skipRisk (prior 0.0, clamped <= 0 when learned)
]);

function eventTimestamp(event) {
  const raw = event?.createdAt;
  const ts = typeof raw === 'number' ? raw : Date.parse(raw);
  return Number.isFinite(ts) ? ts : null;
}

export function sortEventsChronologically(events = []) {
  return (Array.isArray(events) ? events : [])
    .map((event, idx) => ({ event, idx, ts: eventTimestamp(event) }))
    .filter(item => item.event && item.event.songKey && item.ts !== null)
    .sort((a, b) => a.ts - b.ts || a.idx - b.idx)
    .map(item => item.event);
}

function isPositiveOutcomeEvent(event) {
  return outcomeWeight(event) > 0;
}

function isNegativeOutcomeEvent(event) {
  return outcomeWeight(event) < 0;
}

function sessionBuckets(sortedEvents = []) {
  const sessions = [];
  let current = null;
  for (const event of sortedEvents) {
    const ts = eventTimestamp(event);
    const sid = event.sessionId ? String(event.sessionId) : null;
    const startNew = !current
      || (sid && current.sessionId && sid !== current.sessionId)
      || (ts - current.lastTs > PLAYBACK_SESSION_GAP_MS);
    if (startNew) {
      current = { sessionId: sid, lastTs: ts, events: [event] };
      sessions.push(current);
    } else {
      current.lastTs = ts;
      current.events.push(event);
    }
  }
  return sessions;
}

function stripFuturePlayCounts(songs = [], historicalPlayCounts = new Map()) {
  return songs.map(song => {
    const key = song.songKey || getSongKey(song);
    return {
      ...song,
      playCount: historicalPlayCounts.get(key) || 0,
    };
  });
}

function scoreFeatureVector(weights, features) {
  let total = 0;
  for (let i = 0; i < weights.length; i++) total += weights[i] * (features[i] || 0);
  return total;
}

/**
 * Extracts chronological pairwise preferences (positive vs skipped / hard-negative tracks)
 * using strictly prior history at each session boundary so there is zero future leakage.
 */
export function buildRankerPairsFromEvents(songs = [], sortedEvents = [], {
  likedSongKeys = [],
  gemmaVectors = null,
  now = Date.now(),
  halfLifeDays = 21,
  maxNegativesPerPositive = 3,
} = {}) {
  if (!songs.length || !sortedEvents.length) return [];
  const likedSet = new Set(likedSongKeys);
  const songByKey = new Map();
  const orderedSongs = [];
  for (const song of songs) {
    const key = song?.songKey || getSongKey(song);
    if (key && !songByKey.has(key)) {
      songByKey.set(key, song);
      orderedSongs.push({ song, key });
    }
  }

  const sessions = sessionBuckets(sortedEvents);
  const priorEvents = [];
  const historicalPlays = new Map();
  const recentNegKeys = [];
  const pairs = [];

  for (let sIdx = 0; sIdx < sessions.length; sIdx++) {
    const sess = sessions[sIdx];
    const sessStartTs = eventTimestamp(sess.events[0]) ?? now;
    const histSongs = stripFuturePlayCounts(songs, historicalPlays);
    const profile = priorEvents.length > 0
      ? buildContextualTasteProfile(histSongs, priorEvents, {
        gemmaVectors,
        likedSongKeys: likedSet,
        now: sessStartTs,
      })
      : null;

    const sequenceWeight = Number.isFinite(profile?.sequenceWeight)
      ? Math.min(1, Math.max(0, profile.sequenceWeight))
      : 1;
    const activeTimeBucket = profile?.currentContext?.timeBucket;
    const contextEntry = activeTimeBucket ? profile?.contextVectors?.[activeTimeBucket] : null;
    const contextBlendWeight = contextEntry?.vector ? (contextEntry.sessions / (contextEntry.sessions + 5)) : 0;

    const posInSession = [];
    const negInSession = [];
    for (const ev of sess.events) {
      if (isPositiveOutcomeEvent(ev)) posInSession.push(ev);
      else if (isNegativeOutcomeEvent(ev)) {
        negInSession.push(ev);
        if (ev.songKey) recentNegKeys.push(ev.songKey);
      }
    }

    if (posInSession.length > 0 && priorEvents.length > 0) {
      const steer = createSessionSteer();
      for (const pe of priorEvents.slice(-10)) {
        const vec = gemmaVectors?.get?.(pe.songKey)?.vector || songByKey.get(pe.songKey)?.vector;
        const w = outcomeWeight(pe);
        if (vec && w) steer.observe(vec, w);
      }
      const featCtx = {
        profile,
        gemmaVectors,
        playCountByKey: historicalPlays,
        sequenceWeight,
        contextBlendWeight,
        contextEntry,
        likedSongKeys: likedSet,
        now: sessStartTs,
        hourOfDay: new Date(sessStartTs).getHours(),
        sessionSteer: steer,
        computeSkipRisk: false,
      };
      const featureCache = new Map();
      const getFeatures = key => {
        if (featureCache.has(key)) return featureCache.get(key);
        const song = songByKey.get(key);
        if (!song) return null;
        const baseSong = { ...song, playCount: historicalPlays.get(key) || 0 };
        const extracted = extractContextualCandidateFeatures(baseSong, featCtx);
        featureCache.set(key, extracted.features);
        return extracted.features;
      };

      const sessionNegKeys = negInSession.map(e => e.songKey).filter(Boolean);
      for (let pIdx = 0; pIdx < posInSession.length; pIdx++) {
        const posEvent = posInSession[pIdx];
        const posKey = posEvent.songKey;
        const posFeat = getFeatures(posKey);
        if (!posFeat) continue;

        const negKeys = new Set(sessionNegKeys);
        negKeys.delete(posKey);
        for (let r = recentNegKeys.length - 1; r >= 0 && negKeys.size < maxNegativesPerPositive; r--) {
          if (recentNegKeys[r] !== posKey) negKeys.add(recentNegKeys[r]);
        }
        // Deterministic stride fallback over unplayed catalog items if skips are scarce.
        let strideCursor = (sIdx * 13 + pIdx * 7) % Math.max(1, orderedSongs.length);
        let attempts = 0;
        while (negKeys.size < maxNegativesPerPositive && attempts < orderedSongs.length) {
          const candKey = orderedSongs[strideCursor].key;
          if (candKey !== posKey && !posInSession.some(pe => pe.songKey === candKey)) {
            negKeys.add(candKey);
          }
          strideCursor = (strideCursor + 17) % orderedSongs.length;
          attempts++;
        }

        const ageDays = Math.max(0, (now - sessStartTs) / DAY_MS);
        const timeDecay = Math.pow(0.5, ageDays / Math.max(1, halfLifeDays));
        const pairWeight = Math.max(0.05, timeDecay * Math.min(1.5, Math.max(0.4, outcomeWeight(posEvent))));

        for (const negKey of negKeys) {
          const negFeat = getFeatures(negKey);
          if (!negFeat) continue;
          pairs.push({
            preferred: posFeat,
            rejected: negFeat,
            weight: pairWeight,
            timestamp: sessStartTs,
          });
        }
      }
    }

    for (const ev of sess.events) {
      priorEvents.push(ev);
      if (ev.eventType === 'playback-start' || ev.eventType === 'playback-replay') {
        historicalPlays.set(ev.songKey, (historicalPlays.get(ev.songKey) || 0) + 1);
      }
    }
  }

  return pairs;
}

function splitEventsChronologically(sortedEvents = [], { holdoutFraction = 0.25, minHoldoutOutcomes = 5 } = {}) {
  const outcomeIndices = [];
  for (let i = 0; i < sortedEvents.length; i++) {
    if (outcomeWeight(sortedEvents[i]) !== 0) outcomeIndices.push(i);
  }
  if (outcomeIndices.length < minHoldoutOutcomes * 3) {
    return { trainEvents: sortedEvents, evalEvents: [] };
  }
  const splitOutcomePos = Math.max(
    outcomeIndices.length - Math.max(minHoldoutOutcomes, Math.round(outcomeIndices.length * holdoutFraction)),
    minHoldoutOutcomes * 2,
  );
  const splitIdx = outcomeIndices[splitOutcomePos];
  return {
    trainEvents: sortedEvents.slice(0, splitIdx),
    evalEvents: sortedEvents.slice(splitIdx),
  };
}

function defaultSkipPredictWithoutOverride(features = {}) {
  const source = features.sourceType === 'search' ? -0.8 : 0;
  const x = -0.4
    - 0.35 * Number(features.affinity || 0)
    - 0.7 * Number(features.steerScore || 0)
    + 1.4 * Number(features.transitionPenalty || 0)
    + source
    - 0.025 * Number(features.positionInQueue || 0);
  return 1 / (1 + Math.exp(-x));
}

function evaluateHoldoutMetrics({
  songs = [],
  trainEvents = [],
  evalEvents = [],
  likedSongKeys = [],
  gemmaVectors = null,
  learnedWeights = CONTEXTUAL_PRIOR_WEIGHTS,
  skipModel = null,
}) {
  const likedSet = new Set(likedSongKeys);
  const historicalPlays = new Map();
  const history = [];
  for (const ev of trainEvents) {
    history.push(ev);
    if (ev.eventType === 'playback-start' || ev.eventType === 'playback-replay') {
      historicalPlays.set(ev.songKey, (historicalPlays.get(ev.songKey) || 0) + 1);
    }
  }

  const songKeyList = [];
  const songByKey = new Map();
  for (const song of songs) {
    const key = song?.songKey || getSongKey(song);
    if (key && !songByKey.has(key)) {
      songByKey.set(key, song);
      songKeyList.push(key);
    }
  }

  const agg = {
    baseline: { hits10: 0, hits60: 0, ndcg10: 0, queries: 0 },
    learned: { hits10: 0, hits60: 0, ndcg10: 0, queries: 0 },
  };

  const baselineW = CONTEXTUAL_PRIOR_WEIGHTS;
  const evalSessions = sessionBuckets(evalEvents);
  for (const sess of evalSessions) {
    const posEvents = sess.events.filter(isPositiveOutcomeEvent);
    if (posEvents.length > 0 && history.length > 0 && songKeyList.length > 1) {
      const sessTs = eventTimestamp(sess.events[0]) ?? Date.now();
      const histSongs = stripFuturePlayCounts(songs, historicalPlays);
      const profile = buildContextualTasteProfile(histSongs, history, {
        gemmaVectors,
        likedSongKeys: likedSet,
        now: sessTs,
      });
      const sequenceWeight = Number.isFinite(profile?.sequenceWeight) ? Math.min(1, Math.max(0, profile.sequenceWeight)) : 1;
      const activeTimeBucket = profile?.currentContext?.timeBucket;
      const contextEntry = activeTimeBucket ? profile?.contextVectors?.[activeTimeBucket] : null;
      const contextBlendWeight = contextEntry?.vector ? (contextEntry.sessions / (contextEntry.sessions + 5)) : 0;
      const steer = createSessionSteer();
      for (const pe of history.slice(-10)) {
        const vec = gemmaVectors?.get?.(pe.songKey)?.vector || songByKey.get(pe.songKey)?.vector;
        const w = outcomeWeight(pe);
        if (vec && w) steer.observe(vec, w);
      }

      const featCtx = {
        profile,
        gemmaVectors,
        playCountByKey: historicalPlays,
        sequenceWeight,
        contextBlendWeight,
        contextEntry,
        likedSongKeys: likedSet,
        now: sessTs,
        hourOfDay: new Date(sessTs).getHours(),
        sessionSteer: steer,
        computeSkipRisk: false,
      };

      const baseScores = [];
      const learnedScores = [];
      for (const key of songKeyList) {
        const song = { ...songByKey.get(key), playCount: historicalPlays.get(key) || 0 };
        const extracted = extractContextualCandidateFeatures(song, featCtx);
        baseScores.push({ key, score: scoreFeatureVector(baselineW, extracted.features) });
        learnedScores.push({ key, score: scoreFeatureVector(learnedWeights, extracted.features) });
      }
      baseScores.sort((a, b) => b.score - a.score);
      learnedScores.sort((a, b) => b.score - a.score);

      const baseTop10 = new Set(baseScores.slice(0, 10).map(r => r.key));
      const baseTop60 = new Set(baseScores.slice(0, 60).map(r => r.key));
      const baseRankMap = new Map(baseScores.slice(0, 10).map((r, idx) => [r.key, idx]));

      const learnedTop10 = new Set(learnedScores.slice(0, 10).map(r => r.key));
      const learnedTop60 = new Set(learnedScores.slice(0, 60).map(r => r.key));
      const learnedRankMap = new Map(learnedScores.slice(0, 10).map((r, idx) => [r.key, idx]));

      for (const ev of posEvents) {
        if (!songByKey.has(ev.songKey)) continue;
        agg.baseline.queries += 1;
        agg.learned.queries += 1;
        if (baseTop10.has(ev.songKey)) {
          agg.baseline.hits10 += 1;
          agg.baseline.ndcg10 += 1 / Math.log2(baseRankMap.get(ev.songKey) + 2);
        }
        if (baseTop60.has(ev.songKey)) agg.baseline.hits60 += 1;

        if (learnedTop10.has(ev.songKey)) {
          agg.learned.hits10 += 1;
          agg.learned.ndcg10 += 1 / Math.log2(learnedRankMap.get(ev.songKey) + 2);
        }
        if (learnedTop60.has(ev.songKey)) agg.learned.hits60 += 1;
      }
    }

    for (const ev of sess.events) {
      history.push(ev);
      if (ev.eventType === 'playback-start' || ev.eventType === 'playback-replay') {
        historicalPlays.set(ev.songKey, (historicalPlays.get(ev.songKey) || 0) + 1);
      }
    }
  }

  // Evaluate skip predictor strictly on held-out events with affinities computed on trainEvents only.
  const trainAffinities = computeAffinities(trainEvents, { now: new Date(eventTimestamp(evalEvents[0]) || Date.now()) });
  const transStats = pairTransitionStats(trainEvents);
  const vectorOf = key => gemmaVectors?.get?.(key)?.vector || songByKey.get(key)?.vector || null;
  let lastStartKey = null;
  const evalRowsInput = evalEvents.map(ev => {
    const penalty = lastStartKey && ev.songKey && lastStartKey !== ev.songKey
      ? transitionPenalty(transStats, lastStartKey, ev.songKey)
      : 0;
    if (ev.eventType === 'playback-start' || ev.eventType === 'playback-replay') lastStartKey = ev.songKey;
    return ev.transitionPenalty == null ? { ...ev, transitionPenalty: penalty } : ev;
  });
  const evalSkipRows = buildSkipTrainingRows(evalRowsInput, { vectorOf, affinities: trainAffinities });
  const skipLabels = evalSkipRows.map(r => r.label);
  const baselineSkipAuc = evalSkipRows.length
    ? computeRocAuc(evalSkipRows.map(r => defaultSkipPredictWithoutOverride(r)), skipLabels)
    : null;
  const learnedSkipAuc = evalSkipRows.length && skipModel?.predict
    ? computeRocAuc(evalSkipRows.map(r => skipModel.predict(r)), skipLabels)
    : null;

  const summarize = bucket => ({
    queries: bucket.queries,
    hitAt10: bucket.queries ? bucket.hits10 / bucket.queries : 0,
    hitAt60: bucket.queries ? bucket.hits60 / bucket.queries : 0,
    ndcgAt10: bucket.queries ? bucket.ndcg10 / bucket.queries : 0,
  });

  return {
    ranking: {
      baseline: summarize(agg.baseline),
      learned: summarize(agg.learned),
    },
    skip: {
      evalSamples: evalSkipRows.length,
      baselineAuc: baselineSkipAuc,
      learnedAuc: learnedSkipAuc,
    },
  };
}

const DEFAULT_MAX_RANKER_SESSIONS = 200;
const SESSION_SPLIT_GAP_MS = 30 * 60 * 1000;

function trimRecentSessions(sortedEvents = [], maxSessions = DEFAULT_MAX_RANKER_SESSIONS) {
  if (!Number.isFinite(maxSessions) || maxSessions <= 0 || !sortedEvents.length) {
    return sortedEvents;
  }
  let sessionCount = 0;
  let lastSessionKey = null;
  let lastTs = null;
  let cutIndex = 0;
  for (let i = sortedEvents.length - 1; i >= 0; i--) {
    const ev = sortedEvents[i];
    const ts = eventTimestamp(ev);
    const key = ev?.queueId || ev?.sessionId || null;
    const isNewByKey = key && lastSessionKey && key !== lastSessionKey;
    const isNewByGap = !key && ts !== null && lastTs !== null && (lastTs - ts) > SESSION_SPLIT_GAP_MS;
    if (sessionCount === 0 || isNewByKey || isNewByGap) {
      sessionCount += 1;
      if (sessionCount > maxSessions) {
        cutIndex = i + 1;
        break;
      }
    }
    if (key) lastSessionKey = key;
    if (ts !== null) lastTs = ts;
  }
  return cutIndex > 0 ? sortedEvents.slice(cutIndex) : sortedEvents;
}

/**
 * Fits the personal MAP ranker and logistic skip predictor on older playback events,
 * evaluates both on held-out recent events, and activates learned weights only if they beat
 * the baseline fixed heuristic weights.
 */
export function fitAndEvaluatePersonalRanker({
  songs = [],
  playbackEvents = [],
  likedSongKeys = [],
  gemmaVectors = null,
  now = Date.now(),
  halfLifeDays = 21,
  minTrainPairs = 8,
  minHoldoutOutcomes = 5,
  maxSessions = DEFAULT_MAX_RANKER_SESSIONS,
} = {}) {
  const sortedAllEvents = sortEventsChronologically(playbackEvents);
  const sortedEvents = trimRecentSessions(sortedAllEvents, maxSessions);
  const { trainEvents, evalEvents } = splitEventsChronologically(sortedEvents, {
    holdoutFraction: 0.25,
    minHoldoutOutcomes,
  });

  if (!songs.length || !evalEvents.length) {
    return {
      version: 1,
      eventCount: playbackEvents.length,
      rankerEnabled: false,
      skipEnabled: false,
      rankerWeights: [...CONTEXTUAL_PRIOR_WEIGHTS],
      skipWeights: [...SKIP_PRIOR_WEIGHTS],
      reason: 'insufficient-history',
      evalReport: { ranking: null, skip: null, trainPairs: 0, totalEvents: sortedEvents.length },
    };
  }

  const trainPairs = buildRankerPairsFromEvents(songs, trainEvents, {
    likedSongKeys,
    gemmaVectors,
    now,
    halfLifeDays,
  });

  if (trainPairs.length < minTrainPairs) {
    return {
      version: 1,
      eventCount: playbackEvents.length,
      rankerEnabled: false,
      skipEnabled: false,
      rankerWeights: [...CONTEXTUAL_PRIOR_WEIGHTS],
      skipWeights: [...SKIP_PRIOR_WEIGHTS],
      reason: 'insufficient-pairs',
      evalReport: { ranking: null, skip: null, trainPairs: trainPairs.length, totalEvents: sortedEvents.length },
    };
  }

  const holdoutRankerWeights = trainMapPairwiseWeights(trainPairs, {
    prior: CONTEXTUAL_PRIOR_WEIGHTS,
    lambda: 10.0,
    delta: CONTEXTUAL_DELTA_BOUNDS,
    lr: 0.06,
    epochs: 45,
  });

  const trainAffinities = computeAffinities(trainEvents, { now: new Date(now), halfLifeDays });
  const trainTransStats = pairTransitionStats(trainEvents);
  const songByKey = new Map(songs.map(s => [s?.songKey || getSongKey(s), s]).filter(([k]) => Boolean(k)));
  const vectorOf = key => gemmaVectors?.get?.(key)?.vector || songByKey.get(key)?.vector || null;
  let prevStart = null;
  const enrichedTrainSkipEvents = trainEvents.map(ev => {
    const tp = prevStart && ev.songKey && prevStart !== ev.songKey ? transitionPenalty(trainTransStats, prevStart, ev.songKey) : 0;
    if (ev.eventType === 'playback-start' || ev.eventType === 'playback-replay') prevStart = ev.songKey;
    return ev.transitionPenalty == null ? { ...ev, transitionPenalty: tp } : ev;
  });
  const trainSkipRows = buildSkipTrainingRows(enrichedTrainSkipEvents, { vectorOf, affinities: trainAffinities });
  const holdoutSkipModel = trainSkipModel(trainSkipRows, { minRows: 10 });

  const holdout = evaluateHoldoutMetrics({
    songs,
    trainEvents,
    evalEvents,
    likedSongKeys,
    gemmaVectors,
    learnedWeights: holdoutRankerWeights,
    skipModel: holdoutSkipModel,
  });

  const { baseline, learned } = holdout.ranking;
  const rankerImproved = learned.queries >= minHoldoutOutcomes && (
    learned.hitAt10 > baseline.hitAt10 + 1e-9
    || (Math.abs(learned.hitAt10 - baseline.hitAt10) < 1e-9 && (
      learned.hitAt60 > baseline.hitAt60 + 1e-9
      || learned.ndcgAt10 > baseline.ndcgAt10 + 0.002
    ))
  );

  const { baselineAuc, learnedAuc, evalSamples } = holdout.skip;
  const skipImproved = holdoutSkipModel.trained
    && evalSamples >= 6
    && baselineAuc != null
    && learnedAuc != null
    && learnedAuc > 0.52
    && learnedAuc > baselineAuc + 0.005;

  let finalRankerWeights = [...CONTEXTUAL_PRIOR_WEIGHTS];
  if (rankerImproved) {
    const allPairs = buildRankerPairsFromEvents(songs, sortedEvents, {
      likedSongKeys,
      gemmaVectors,
      now,
      halfLifeDays,
    });
    finalRankerWeights = allPairs.length >= minTrainPairs
      ? trainMapPairwiseWeights(allPairs, {
        prior: CONTEXTUAL_PRIOR_WEIGHTS,
        lambda: 10.0,
        delta: CONTEXTUAL_DELTA_BOUNDS,
        lr: 0.06,
        epochs: 45,
      })
      : holdoutRankerWeights;
    if (skipImproved) {
      // Gently penalize songs flagged by the learned skip model when both models win eval.
      finalRankerWeights[9] = -0.18;
    }
  }

  let finalSkipWeights = [...SKIP_PRIOR_WEIGHTS];
  if (skipImproved) {
    const allAff = computeAffinities(sortedEvents, { now: new Date(now), halfLifeDays });
    const allTrans = pairTransitionStats(sortedEvents);
    let lastKey = null;
    const allSkipRows = buildSkipTrainingRows(sortedEvents.map(ev => {
      const tp = lastKey && ev.songKey && lastKey !== ev.songKey ? transitionPenalty(allTrans, lastKey, ev.songKey) : 0;
      if (ev.eventType === 'playback-start' || ev.eventType === 'playback-replay') lastKey = ev.songKey;
      return ev.transitionPenalty == null ? { ...ev, transitionPenalty: tp } : ev;
    }), { vectorOf, affinities: allAff });
    const fullSkip = trainSkipModel(allSkipRows, { minRows: 10 });
    finalSkipWeights = fullSkip.trained ? fullSkip.weights : holdoutSkipModel.weights;
  }

  let collabEnabled = false;
  let collabWeight = 0;
  let collabGraph = null;
  let collabReport = null;

  const evalStartTs = eventTimestamp(evalEvents[0]);
  if (evalStartTs !== null) {
    const preEvalEvents = sortedAllEvents.filter(ev => {
      const ts = eventTimestamp(ev);
      return ts !== null && ts < evalStartTs;
    });
    const evalSessionBuckets = sessionBuckets(evalEvents);
    const withinQueries = [];
    for (const sess of evalSessionBuckets) {
      const completes = sess.events.filter(ev => ev.eventType === 'playback-complete' || ev.eventType === 'playback-replay');
      if (completes.length < 2) continue;
      const seedIdx = sess.events.indexOf(completes[0]);
      const prefix = sess.events.slice(0, seedIdx + 1);
      const targetKey = completes[1].songKey;
      const seedKey = completes[0].songKey;
      if (targetKey && seedKey && targetKey !== seedKey) {
        withinQueries.push({ prefix, targetKey, ts: eventTimestamp(completes[1]) || now });
      }
    }

    if (withinQueries.length >= 6 && preEvalEvents.length >= 20) {
      const trainGraph = buildSessionCooccurrenceGraph(preEvalEvents, { now });
      if (trainGraph.edgeCount > 0) {
        const evalW = rankerImproved ? finalRankerWeights : CONTEXTUAL_PRIOR_WEIGHTS;
        let runningHistory = preEvalEvents.slice(-1200);
        const playCounts = new Map();
        for (const ev of preEvalEvents) {
          if (ev.eventType === 'playback-start' || ev.eventType === 'playback-replay') {
            playCounts.set(ev.songKey, (playCounts.get(ev.songKey) || 0) + 1);
          }
        }
        const precomputed = [];
        for (const q of withinQueries.slice(-40)) {
          const histSlice = runningHistory.concat(q.prefix).slice(-1200);
          const anchors = extractRecentAnchorKeys(q.prefix, 3);
          const exclude = anchors.slice(0, 1);
          const histSongs = stripFuturePlayCounts(songs, playCounts);
          const profile = buildContextualTasteProfile(histSongs, histSlice, {
            gemmaVectors,
            likedSongKeys,
            now: q.ts,
            excludeSongKeys: exclude,
          });
          const baseRanked = rankContextualSongs(histSongs, {
            profile,
            gemmaVectors,
            likedSongKeys,
            excludeSongKeys: exclude,
            rankerWeights: evalW,
            now: q.ts,
            limit: songs.length,
            fullScanBelow: Infinity,
          });
          precomputed.push({
            targetKey: q.targetKey,
            rows: baseRanked.map(item => {
              const key = item.songKey || getSongKey(item);
              return {
                key,
                baseScore: item.recommendationScore ?? 0,
                collabScore: scoreCooccurrenceCandidate(trainGraph, anchors, key),
              };
            }),
          });
          runningHistory = histSlice;
        }

        const evalWeightCandidate = cw => {
          let h10 = 0;
          let h60 = 0;
          let ndcg10 = 0;
          for (const item of precomputed) {
            const ranked = cw === 0
              ? item.rows
              : item.rows.slice().sort((a, b) => (b.baseScore + cw * b.collabScore) - (a.baseScore + cw * a.collabScore));
            const idx = ranked.findIndex(r => r.key === item.targetKey);
            if (idx >= 0 && idx < 60) {
              h60 += 1;
              if (idx < 10) {
                h10 += 1;
                ndcg10 += 1 / Math.log2(idx + 2);
              }
            }
          }
          const n = precomputed.length || 1;
          return { queries: n, hitAt10: h10 / n, hitAt60: h60 / n, ndcgAt10: ndcg10 / n };
        };

        const baseCollabEval = evalWeightCandidate(0);
        let bestCw = 0;
        let bestMetrics = baseCollabEval;
        for (const cw of [0.4, 0.75, 1.0]) {
          const metrics = evalWeightCandidate(cw);
          const better = metrics.hitAt10 > bestMetrics.hitAt10 + 1e-9
            || (Math.abs(metrics.hitAt10 - bestMetrics.hitAt10) < 1e-9 && metrics.hitAt60 > bestMetrics.hitAt60 + 1e-9)
            || (Math.abs(metrics.hitAt10 - bestMetrics.hitAt10) < 1e-9 && Math.abs(metrics.hitAt60 - bestMetrics.hitAt60) < 1e-9 && metrics.ndcgAt10 > bestMetrics.ndcgAt10 + 0.002);
          if (better) {
            bestCw = cw;
            bestMetrics = metrics;
          }
        }
        collabReport = { baseline: baseCollabEval, selected: bestMetrics, selectedWeight: bestCw };
        if (bestCw > 0) {
          collabEnabled = true;
          collabWeight = bestCw;
          collabGraph = serializeCooccurrenceGraph(buildSessionCooccurrenceGraph(sortedAllEvents, { now }));
        }
      }
    }
  }

  return {
    version: 1,
    updatedAt: new Date(now).toISOString(),
    eventCount: playbackEvents.length,
    rankerEnabled: Boolean(rankerImproved),
    skipEnabled: Boolean(skipImproved),
    collabEnabled,
    collabWeight,
    collabGraph,
    rankerWeights: finalRankerWeights,
    skipWeights: finalSkipWeights,
    reason: rankerImproved || skipImproved || collabEnabled ? 'promoted-by-holdout-eval' : 'baseline-tied-or-better',
    evalReport: {
      trainPairs: trainPairs.length,
      trainEvents: trainEvents.length,
      evalEvents: evalEvents.length,
      ranking: holdout.ranking,
      skip: holdout.skip,
      collab: collabReport,
    },
  };
}

export function resolvePersonalRankerCollab(state) {
  if (!state?.collabEnabled || !(state.collabWeight > 0) || !state?.collabGraph) {
    return { collabGraph: null, collabWeight: 0 };
  }
  let cached = collabGraphCache.get(state.collabGraph);
  if (!cached) {
    cached = deserializeCooccurrenceGraph(state.collabGraph);
    if (cached) collabGraphCache.set(state.collabGraph, cached);
  }
  return cached ? { collabGraph: cached, collabWeight: Number(state.collabWeight) } : { collabGraph: null, collabWeight: 0 };
}

export async function loadExternalHistoryPack() {
  try {
    if (!db?.metadata) return null;
    const record = await db.metadata.get(EXTERNAL_HISTORY_STORAGE_KEY);
    return record?.value || null;
  } catch {
    return null;
  }
}

export async function saveExternalHistoryPack(pack) {
  try {
    if (!db?.metadata || !pack) return false;
    await db.metadata.put({ key: EXTERNAL_HISTORY_STORAGE_KEY, value: pack });
    return true;
  } catch {
    return false;
  }
}

export function applyPersonalRankerState(state) {
  if (state?.skipEnabled && Array.isArray(state.skipWeights) && state.skipWeights.length === SKIP_PRIOR_WEIGHTS.length) {
    registerSkipPredictor(createSkipPredictorFromWeights(state.skipWeights));
  } else {
    clearSkipPredictor();
  }
  return resolveRankerWeights(state?.rankerEnabled ? state.rankerWeights : CONTEXTUAL_PRIOR_WEIGHTS);
}

export async function loadPersonalRankerState() {
  try {
    if (!db?.metadata) return null;
    const record = await db.metadata.get(PERSONAL_RANKER_STORAGE_KEY);
    return record?.value || null;
  } catch {
    return null;
  }
}

export async function savePersonalRankerState(state) {
  try {
    if (!db?.metadata || !state) return false;
    await db.metadata.put({ key: PERSONAL_RANKER_STORAGE_KEY, value: state });
    return true;
  } catch {
    return false;
  }
}

export async function refreshPersonalRanker({
  songs = [],
  playbackEvents = [],
  likedSongKeys = [],
  gemmaVectors = null,
  now = Date.now(),
  force = false,
} = {}) {
  const cached = await loadPersonalRankerState();
  if (!force && cached && cached.eventCount === playbackEvents.length && songs.length > 0) {
    applyPersonalRankerState(cached);
    return cached;
  }
  const fitted = fitAndEvaluatePersonalRanker({
    songs,
    playbackEvents,
    likedSongKeys,
    gemmaVectors,
    now,
  });
  applyPersonalRankerState(fitted);
  await savePersonalRankerState(fitted);
  return fitted;
}

export { MAP_PRIOR_WEIGHTS };
