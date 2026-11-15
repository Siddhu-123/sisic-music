import { getSongKey } from '../songIdentity.js';
import {
  cosineSimilarity,
  EMBEDDING_DIMENSIONS,
  getSongEmbedding,
} from './tasteEmbeddingService.js';
import {
  buildInterests,
  interestAffinity,
  prepareInterestsLogSumExp,
  scoreInterestsLogSumExp,
  scorePreparedInterestsLogSumExp,
} from './tasteInterests.js';
import {
  MAP_PRIOR_WEIGHTS,
  createSessionSteer,
  hasCustomSkipPredictor,
  outcomeWeight,
  pairTransitionStats,
  predictSkip,
  transitionPenalty,
} from './behaviourLearning.js';
import { GEMMA2_MODEL } from './gemmaVectors.js';
import {
  DEFAULT_FULL_SCAN_THRESHOLD,
  DEFAULT_STAGE1_LIMIT,
  selectStage1Candidates,
} from './candidateIndex.js';
import {
  extractRecentAnchorKeys,
  scoreCooccurrenceCandidate,
  topCooccurrenceCandidates,
} from './sessionCooccurrence.js';

export const PLAYBACK_SESSION_GAP_MS = 20 * 60 * 1000;
export function currentSessionEvents(events = [], gapMs = PLAYBACK_SESSION_GAP_MS) {
  const sorted = [...events].filter(event => Number.isFinite(Date.parse(event?.createdAt)))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  let start = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (Date.parse(sorted[i].createdAt) - Date.parse(sorted[i - 1].createdAt) > gapMs) start = i;
  }
  return sorted.slice(start);
}

export const PLAYBACK_START_EVENT_TYPES = Object.freeze(['playback-start', 'playback-resume']);

const DAY_MS = 24 * 60 * 60 * 1000;
// How quickly "what you were just listening to" fades into long-term taste.
const SEQUENCE_HALF_LIFE_MS = 6 * 60 * 60 * 1000;
// Time-of-day prior strength (kappa_ctx = 6 sessions) so sparse buckets shrink safely to longTerm.
const CONTEXT_PRIOR_SESSIONS = 6;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function timestampValue(value, fallback = 0) {
  if (value instanceof Date) return finiteNumber(value.getTime(), fallback);
  if (typeof value === 'number') return finiteNumber(value, fallback);
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  return finiteNumber(value, fallback);
}

function normaliseContext(context = {}, timestamp = Date.now(), userAgent = '') {
  const base = getPlaybackContext(timestamp, userAgent);
  const custom = context && typeof context === 'object' ? context : {};
  return {
    ...base,
    ...custom,
    weekday: Number.isInteger(Number(custom.weekday)) ? Number(custom.weekday) : base.weekday,
    hour: Number.isInteger(Number(custom.hour)) ? Number(custom.hour) : base.hour,
    timeBucket: custom.timeBucket || custom.timeOfDay || base.timeBucket,
    deviceType: custom.deviceType || custom.device || base.deviceType,
    sourceSurface: custom.sourceSurface || custom.source || base.sourceSurface,
  };
}

function timeBucket(hour) {
  if (hour < 6) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  if (hour < 23) return 'evening';
  return 'night';
}

export function classifyDevice(userAgent = '') {
  const value = String(userAgent || '').toLowerCase();
  if (/ipad|tablet|android(?!.*mobile)/i.test(value)) return 'tablet';
  if (/mobile|iphone|ipod|android/i.test(value)) return 'mobile';
  return 'desktop';
}

export function getPlaybackContext(value = Date.now(), userAgent = '') {
  const timestamp = timestampValue(value, Date.now());
  const date = new Date(timestamp);
  const hour = date.getHours();
  return {
    weekday: date.getDay(),
    hour,
    timeBucket: timeBucket(hour),
    deviceType: classifyDevice(userAgent),
    sourceSurface: 'player',
  };
}

function eventPosition(event) {
  return Math.max(0, finiteNumber(event.positionSeconds, finiteNumber(event.currentTime)));
}

function eventDuration(event) {
  return Math.max(0, finiteNumber(event.durationSeconds, finiteNumber(event.duration)));
}

function completionRatio(event) {
  const duration = eventDuration(event);
  return duration > 0 ? Math.min(1, eventPosition(event) / duration) : 0;
}

function createTrackRecord(songKey, timestamp) {
  return {
    songKey,
    firstEventAt: timestamp,
    lastEventAt: timestamp,
    starts: 0,
    completeCount: 0,
    skipCount: 0,
    shortEndCount: 0,
    errorCount: 0,
    pauseCount: 0,
    stopCount: 0,
    maxPositionSeconds: 0,
    durationSeconds: 0,
    positiveWeight: 0,
    negativeWeight: 0,
  };
}

function addEventToTrack(track, event) {
  const eventType = String(event.eventType || '');
  const positionSeconds = eventPosition(event);
  const durationSeconds = eventDuration(event);
  track.lastEventAt = Math.max(track.lastEventAt, timestampValue(event.createdAt, track.lastEventAt));
  track.maxPositionSeconds = Math.max(track.maxPositionSeconds, positionSeconds);
  track.durationSeconds = Math.max(track.durationSeconds, durationSeconds);

  if (PLAYBACK_START_EVENT_TYPES.includes(eventType)) {
    track.starts += 1;
    track.positiveWeight += eventType === 'playback-resume' ? 0.32 : 0.38;
  }
  if (eventType === 'playback-complete' || eventType === 'playback-replay') {
    track.completeCount += 1;
    track.positiveWeight += eventType === 'playback-replay' ? 1.2 : 1;
  } else if (eventType === 'playback-pause') {
    track.pauseCount += 1;
    track.positiveWeight += completionRatio(event) >= 0.65 ? 0.7 : 0.15;
  } else if (eventType === 'playback-stop') {
    track.stopCount += 1;
    track.positiveWeight += completionRatio(event) >= 0.65 ? 0.65 : 0.12;
  }
  if (eventType === 'user-skip') {
    track.skipCount += 1;
    // Honour skip position/duration so instant <10s skips outweigh late 2m+ listens.
    track.negativeWeight += Math.max(0.05, Math.abs(outcomeWeight(event)) || 1);
  } else if (eventType === 'playback-short-ended') {
    track.shortEndCount += 1;
    if (completionRatio(event) >= 0.8) track.positiveWeight += 0.8;
    else track.negativeWeight += 0.8;
  } else if (eventType === 'playback-stream-error' || eventType === 'playback-start-failed') {
    track.errorCount += 1;
    track.negativeWeight += 0.5;
  }
}

function finishTrackRecord(track) {
  const status = track.positiveWeight > track.negativeWeight && track.positiveWeight >= 0.35
    ? 'played'
    : track.negativeWeight > 0
      ? 'skipped'
      : 'started';
  return {
    ...track,
    status,
    listenedSeconds: track.maxPositionSeconds,
  };
}

function finishSession(session) {
  const tracks = [...session.trackMap.values()].map(finishTrackRecord);
  return {
    sessionId: session.sessionId,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    context: session.context,
    events: session.events,
    tracks,
    playedTracks: tracks.filter(track => track.status === 'played'),
    skippedTracks: tracks.filter(track => track.status === 'skipped'),
    trackKeys: tracks.map(track => track.songKey),
  };
}

export function sessionizePlaybackEvents(events = [], options = {}) {
  const gapMs = Math.max(1, finiteNumber(options.gapMs, PLAYBACK_SESSION_GAP_MS));
  const userAgent = options.userAgent || '';
  const ordered = events
    .map((event, index) => ({
      event,
      index,
      timestamp: timestampValue(event?.createdAt, index),
    }))
    .filter(item => item.event?.songKey)
    .sort((a, b) => a.timestamp - b.timestamp || a.index - b.index);

  const sessions = [];
  let current = null;
  let previousTimestamp = 0;

  ordered.forEach(({ event, timestamp, index }) => {
    const explicitSessionId = String(event.sessionId || '').trim();
    const hasGap = current && previousTimestamp > 0 && timestamp - previousTimestamp > gapMs;
    const sessionChanged = current && explicitSessionId && current.sessionId !== explicitSessionId;
    const shouldStart = !current || sessionChanged || (!explicitSessionId && hasGap);

    if (shouldStart) {
      current = {
        sessionId: explicitSessionId || `session-${timestamp || index}`,
        startedAt: timestamp,
        endedAt: timestamp,
        context: normaliseContext({
          ...(event.context || {}),
          sourceSurface: event.context?.sourceSurface || event.sourceSurface || event.source || 'player',
        }, timestamp || Date.now(), userAgent),
        events: [],
        trackMap: new Map(),
      };
      sessions.push(current);
    }

    current.endedAt = Math.max(current.endedAt, timestamp);
    current.events.push(event);
    if (!current.trackMap.has(event.songKey)) current.trackMap.set(event.songKey, createTrackRecord(event.songKey, timestamp));
    addEventToTrack(current.trackMap.get(event.songKey), event);
    previousTimestamp = timestamp;
  });

  return sessions.map(finishSession);
}

function getSongVector(song) {
  return getSongEmbedding(song || {});
}

function normaliseVector(values) {
  if (!values) return null;
  const vector = Array.from(values);
  let sumSq = 0;
  for (const value of vector) sumSq += value * value;
  const norm = Math.sqrt(sumSq);
  if (!norm) return null;
  return vector.map(value => value / norm);
}

function contextMatchScore(source = {}, target = {}) {
  let score = 1;
  if (source.timeBucket && source.timeBucket === target.timeBucket) score += 0.18;
  if (Number.isInteger(source.hour) && source.hour === target.hour) score += 0.1;
  if (Number.isInteger(source.weekday) && source.weekday === target.weekday) score += 0.06;
  if (source.deviceType && source.deviceType === target.deviceType) score += 0.04;
  if (source.sourceSurface && source.sourceSurface === target.sourceSurface) score += 0.04;
  return score;
}

function addWeightedVector(accumulator, vector, weight) {
  if (!vector || !weight || !accumulator) return;
  const len = Math.min(accumulator.length, vector.length);
  for (let index = 0; index < len; index++) accumulator[index] += vector[index] * weight;
}

export function buildContextualTasteProfile(songs = [], playbackEvents = [], options = {}) {
  const sessions = sessionizePlaybackEvents(playbackEvents, options);
  const songByKey = new Map(songs.map(song => [song.songKey || getSongKey(song), song]));

  const targetSpace = options.targetSpace || 'metadata';
  const targetModel = options.targetModel || null;
  const targetDimensions = Number(options.targetDimensions) || EMBEDDING_DIMENSIONS;

  const spaceMeta = {
    vectorType: targetSpace,
    model: targetModel || (targetSpace === 'learned-audio' ? 'unknown-audio-model' : 'sisic-metadata-heuristics'),
    dimensions: targetDimensions,
  };

  const positiveAccumulator = new Float32Array(targetDimensions);
  const negativeAccumulator = new Float32Array(targetDimensions);
  const recentAccumulator = new Float32Array(targetDimensions);
  const lastPlayedAtByKey = new Map();
  const lastSkippedAtByKey = new Map();
  // Net evidence per song (recency-decayed), kept whether or not the song has a
  // vector so portable "anchor" tracks can be derived independent of any embedding.
  const songSignal = new Map();
  const bumpSignal = (key, song, field, amount) => {
    if (!(amount > 0)) return;
    const entry = songSignal.get(key) || { song, positive: 0, negative: 0 };
    entry[field] += amount;
    songSignal.set(key, entry);
  };
  // Recency-only weighted vectors per time-of-day bucket (no current-context boost).
  const bucketAccumulators = new Map();
  const now = timestampValue(options.now, Date.now());
  const halfLifeDays = Math.max(1, finiteNumber(options.recencyHalfLifeDays, 30));
  const currentContext = options.currentContext || getPlaybackContext(now, options.userAgent || '');
  let positiveSignalCount = 0;
  let negativeSignalCount = 0;

  function getCompatibleVector(song) {
    if (!song) return null;
    const gemma = options.gemmaVectors?.get?.(song.songKey || getSongKey(song));
    if (targetSpace === 'gemma') return gemma?.vector ? validateAndNormalizeVector(gemma.vector, gemma.vector.length) : null;
    // Metadata space always goes through the versioned helper so stale v1 vectors never mix in.
    if (targetSpace === 'metadata') return targetDimensions === EMBEDDING_DIMENSIONS ? getSongVector(song) : null;
    const meta = resolveEmbeddingMetadata(song);
    if (meta && areVectorSpacesCompatible(spaceMeta, meta)) {
      return meta.vector;
    }
    if (targetSpace === 'metadata' && targetDimensions === EMBEDDING_DIMENSIONS) {
      return getSongVector(song);
    }
    return null;
  }

  sessions.forEach((session, sessionIndex) => {
    const ageDays = Math.max(0, (now - session.endedAt) / DAY_MS);
    const recencyWeight = 2 ** (-ageDays / halfLifeDays);
    const sessionWeight = recencyWeight * contextMatchScore(session.context, currentContext);
    const bucketKey = session.context?.timeBucket || 'unknown';
    let sessionHadVector = false;

    session.tracks.forEach((track, trackIndex) => {
      const song = songByKey.get(track.songKey);
      if (!song) return;
      const vector = getCompatibleVector(song);
      const positiveWeight = track.status === 'skipped' ? 0 : Math.min(1.6, track.positiveWeight);
      const negativeWeight = Math.min(1.4, track.negativeWeight);
      if (positiveWeight > 0) {
        if (vector) {
          addWeightedVector(positiveAccumulator, vector, positiveWeight * sessionWeight);
          if (!bucketAccumulators.has(bucketKey)) bucketAccumulators.set(bucketKey, { sum: new Float32Array(targetDimensions), sessions: 0, mass: 0 });
          const bucket = bucketAccumulators.get(bucketKey);
          addWeightedVector(bucket.sum, vector, positiveWeight * recencyWeight);
          bucket.mass += positiveWeight * recencyWeight;
          sessionHadVector = true;
        }
        bumpSignal(track.songKey, song, 'positive', positiveWeight * sessionWeight);
        positiveSignalCount += 1;
        lastPlayedAtByKey.set(track.songKey, Math.max(lastPlayedAtByKey.get(track.songKey) || 0, track.lastEventAt));
      }
      if (negativeWeight > 0) {
        if (vector) addWeightedVector(negativeAccumulator, vector, negativeWeight * sessionWeight);
        bumpSignal(track.songKey, song, 'negative', negativeWeight * sessionWeight);
        negativeSignalCount += 1;
        if (track.status === 'skipped') {
          lastSkippedAtByKey.set(track.songKey, Math.max(lastSkippedAtByKey.get(track.songKey) || 0, track.lastEventAt));
        }
      }

      if (sessionIndex === sessions.length - 1 && track.status !== 'skipped' && vector) {
        const orderWeight = 0.65 + ((trackIndex + 1) / Math.max(1, session.tracks.length)) * 0.35;
        addWeightedVector(recentAccumulator, vector, Math.max(0.2, positiveWeight) * orderWeight);
      }
    });
    if (sessionHadVector) bucketAccumulators.get(bucketKey).sessions += 1;
  });

  // Explicit likes, user-curated playlists, and imported play counts are durable taste signals
  // even with little or no event history (e.g. a freshly synced device).
  const likedSongKeys = new Set(options.likedSongKeys || []);
  let explicitSignalCount = 0;
  songs.forEach(song => {
    const key = song.songKey || getSongKey(song);
    const likeWeight = likedSongKeys.has(key) ? 0.9 : 0;
    const curatedCount = Array.isArray(song.playlistKeys)
      ? song.playlistKeys.filter(pk => pk && pk !== '__listening_history__').length
      : 0;
    const playlistWeight = !likeWeight && curatedCount > 0
      ? Math.min(0.45, 0.25 + 0.1 * (curatedCount - 1))
      : 0;
    const playWeight = Math.min(0.6, Math.log1p(finiteNumber(song.playCount)) * 0.2);
    const totalExplicit = likeWeight + playlistWeight + playWeight;
    if (!totalExplicit) return;
    bumpSignal(key, song, 'positive', totalExplicit);
    const vector = getCompatibleVector(song);
    if (!vector) return;
    addWeightedVector(positiveAccumulator, vector, totalExplicit);
    explicitSignalCount += 1;
  });

  const longTerm = normaliseVector(positiveAccumulator);

  // Interests: cluster the songs that carry positive evidence (net of skips).
  const interestItems = [];
  songSignal.forEach((entry, key) => {
    const net = entry.positive - (0.5 * entry.negative);
    if (net <= 0) return;
    const vector = getCompatibleVector(entry.song);
    if (vector) interestItems.push({ vector, weight: net, songKey: key });
  });
  const interests = buildInterests(interestItems, { maxInterests: options.maxInterests || 4, gemmaVectors: options.gemmaVectors }).map(interest => ({
    vector: interest.vector,
    weight: interest.weight,
    size: interest.size,
    songKeys: interest.members.map(index => interestItems[index].songKey),
  }));

  // Time-of-day vectors, shrunk toward long-term taste for rarely seen buckets.
  const totalBucketMass = [...bucketAccumulators.values()].reduce((sum, bucket) => sum + bucket.mass, 0);
  const totalBucketSessions = [...bucketAccumulators.values()].reduce((sum, bucket) => sum + bucket.sessions, 0);
  const meanSessionMass = totalBucketSessions ? totalBucketMass / totalBucketSessions : 0;
  const contextVectors = {};
  if (longTerm) {
    bucketAccumulators.forEach((bucket, key) => {
      if (!bucket.sessions || key === 'unknown') return;
      const blended = new Float32Array(targetDimensions);
      addWeightedVector(blended, bucket.sum, 1);
      addWeightedVector(blended, longTerm, CONTEXT_PRIOR_SESSIONS * meanSessionMass);
      const vector = normaliseVector(blended);
      if (vector) contextVectors[key] = { vector, sessions: bucket.sessions };
    });
  }

  const recentSession = sessions.at(-1);
  const sequenceWeight = recentSession ? 2 ** (-Math.max(0, now - recentSession.endedAt) / SEQUENCE_HALF_LIFE_MS) : 0;
  return {
    vector: longTerm,
    interests,
    contextVectors,
    songSignal,
    negativeVector: normaliseVector(negativeAccumulator),
    recentVector: normaliseVector(recentAccumulator),
    sessions,
    sessionCount: sessions.length,
    positiveSignalCount,
    negativeSignalCount,
    explicitSignalCount,
    sequenceWeight,
    hasSignal: Boolean(positiveSignalCount || negativeSignalCount || explicitSignalCount),
    currentContext,
    recentSongKeys: recentSession?.trackKeys || [],
    lastPlayedAtByKey,
    lastSkippedAtByKey,
    targetSpace,
    spaceMeta,
  };
}

function playCountFor(playCountByKey, key) {
  if (playCountByKey instanceof Map) return finiteNumber(playCountByKey.get(key));
  return finiteNumber(playCountByKey?.[key]);
}

function recencyPenalty(lastPlayedAt, now) {
  if (!lastPlayedAt) return 0;
  const ageDays = Math.max(0, (now - lastPlayedAt) / DAY_MS);
  return Math.max(0, 0.26 * (1 - Math.min(1, ageDays / 14)));
}

function skipPenalty(lastSkippedAt, now) {
  if (!lastSkippedAt) return 0;
  const ageDays = Math.max(0, (now - lastSkippedAt) / DAY_MS);
  return Math.max(0, 0.3 * (1 - Math.min(1, ageDays / 7)));
}

function lookup(mapOrObject, key) {
  return mapOrObject instanceof Map ? mapOrObject.get(key) : mapOrObject?.[key];
}

export function scoreWithMapFeatures(rows = [], weights = MAP_PRIOR_WEIGHTS) {
  if (!rows.length) return [];
  const w = Array.isArray(weights) && weights.length === 6 ? weights : MAP_PRIOR_WEIGHTS;
  const contMeans = [0, 0, 0];
  const contStds = [1, 1, 1];
  for (let col = 0; col < 3; col++) {
    let mean = 0;
    for (const row of rows) mean += Number(row.features?.[col] || 0);
    mean /= rows.length;
    contMeans[col] = mean;
    let variance = 0;
    for (const row of rows) {
      const diff = Number(row.features?.[col] || 0) - mean;
      variance += diff * diff;
    }
    contStds[col] = Math.max(1e-6, Math.sqrt(variance / rows.length));
  }
  return rows.map(row => {
    const f = row.features || [0, 0, 0, 0, 0, 0];
    // Standardize continuous scores (f0..f2) only; keep bounded flags/penalties (f3..f5) unscaled.
    const z0 = (Number(f[0] || 0) - contMeans[0]) / contStds[0];
    const z1 = (Number(f[1] || 0) - contMeans[1]) / contStds[1];
    const z2 = (Number(f[2] || 0) - contMeans[2]) / contStds[2];
    const s3 = Number(f[3] || 0);
    const s4 = Number(f[4] || 0);
    const s5 = Number(f[5] || 0);
    const mapScore = (w[0] * z0) + (w[1] * z1) + (w[2] * z2) + (w[3] * s3) + (w[4] * s4) + (w[5] * s5);
    return { ...row, mapScore };
  });
}

export const CONTEXTUAL_RANKER_FEATURES = Object.freeze([
  'tasteAffinity',
  'staleTasteBoost',
  'sequenceBoost',
  'skipAffinity',
  'liked',
  'popularity',
  'discovery',
  'recentPenalty',
  'steer',
  'skipRisk',
]);

// Prior reproduces the exact baseline heuristic weights at day 1 (zero behavioral change until earned).
export const CONTEXTUAL_PRIOR_WEIGHTS = Object.freeze([
  0.52,
  0.30,
  0.30,
  -0.28,
  0.22,
  0.14,
  0.05,
  -1.0,
  0.20,
  0.0,
]);

function resolveCandidateVector(song, key, profile, gemmaVectors) {
  if (profile?.spaceMeta) {
    if (profile.spaceMeta.vectorType === 'gemma') {
      const gemma = gemmaVectors?.get?.(key);
      if (!gemma?.vector) return null;
      // Fast path when gemmaVectors holds pre-validated unit Float32Array vectors.
      if (gemma.vector instanceof Float32Array && gemma.vector.length > 0) return gemma.vector;
      return validateAndNormalizeVector(gemma.vector, gemma.vector.length);
    }
    const meta = profile.spaceMeta.vectorType === 'metadata' ? null : resolveEmbeddingMetadata(song);
    if (meta && areVectorSpacesCompatible(profile.spaceMeta, meta)) {
      return meta.vector;
    }
    if (profile.spaceMeta.vectorType === 'metadata') {
      return getSongVector(song);
    }
    return null;
  }
  return getSongVector(song);
}

/** Extracts the aligned feature vector shared between training and serving. */
export function extractContextualCandidateFeatures(song, ctx = {}) {
  const key = song?.songKey || getSongKey(song);
  const vector = ctx.vector !== undefined ? ctx.vector : resolveCandidateVector(song, key, ctx.profile, ctx.gemmaVectors);
  const plays = ctx.plays != null ? ctx.plays : Math.max(finiteNumber(song?.playCount), playCountFor(ctx.playCountByKey, key));
  const sequenceWeight = ctx.sequenceWeight ?? 1;
  const multiInterest = vector && ctx.profile?.interests?.length > 1
    ? (ctx.preparedInterests
      ? scorePreparedInterestsLogSumExp(vector, ctx.preparedInterests)
      : (scoreInterestsLogSumExp(vector, ctx.profile.interests, {
        sessionVector: sequenceWeight > 0.05 ? ctx.profile.recentVector : null,
        beta: 6.0 * sequenceWeight,
        tau: 10.0,
      }) ?? interestAffinity(vector, ctx.profile.interests)))
    : null;
  const baseTaste = multiInterest ?? ((ctx.profile?.vector && vector) ? cosineSimilarity(ctx.profile.vector, vector) : 0);
  const contextBlendWeight = ctx.contextBlendWeight ?? 0;
  const contextFit = (ctx.contextEntry?.vector && vector) ? cosineSimilarity(ctx.contextEntry.vector, vector) : 0;
  const tasteAffinity = (baseTaste * (1 - 0.25 * contextBlendWeight)) + (contextFit * (0.25 * contextBlendWeight));
  const sequenceAffinity = (ctx.profile?.recentVector && vector) ? cosineSimilarity(ctx.profile.recentVector, vector) : 0;
  const skipAffinity = (ctx.profile?.negativeVector && vector) ? cosineSimilarity(ctx.profile.negativeVector, vector) : 0;
  const liked = ctx.likedSongKeys?.has?.(key) ? 1 : 0;
  const popularity = Math.min(0.14, Math.log1p(plays) * 0.045) / 0.14;
  const discovery = plays === 0 ? (ctx.profile?.hasSignal ? 0.7 : 1.0) : 0;
  const now = ctx.now ?? Date.now();
  const recentPenalty = recencyPenalty(lookup(ctx.profile?.lastPlayedAtByKey, key), now)
    + skipPenalty(lookup(ctx.profile?.lastSkippedAtByKey, key), now);
  const steerScore = ctx.sessionSteer?.score?.(vector) || 0;
  const skipRisk = ctx.computeSkipRisk
    ? predictSkip({
      affinity: Math.max(0, tasteAffinity) + (liked ? 0.35 : 0),
      steerScore,
      transitionPenalty: 0,
      hourOfDay: ctx.hourOfDay ?? new Date(now).getHours(),
      sourceType: ctx.sourceType || 'radio',
      positionInQueue: ctx.positionInQueue ?? 0,
    })
    : 0;
  return {
    key,
    vector,
    plays,
    steerScore,
    features: [
      tasteAffinity,
      tasteAffinity * (1 - sequenceWeight),
      sequenceAffinity * sequenceWeight,
      skipAffinity,
      liked,
      popularity,
      discovery,
      recentPenalty,
      steerScore,
      skipRisk,
    ],
  };
}

export function resolveRankerWeights(candidateWeights, options = {}) {
  const base = Array.isArray(candidateWeights)
    && candidateWeights.length === CONTEXTUAL_PRIOR_WEIGHTS.length
    && candidateWeights.every(v => Number.isFinite(Number(v)))
    ? candidateWeights.map(Number)
    : [...CONTEXTUAL_PRIOR_WEIGHTS];
  if (options.steerWeight != null && Number.isFinite(Number(options.steerWeight))) {
    base[8] = Number(options.steerWeight);
  }
  if (options.skipRiskWeight != null && Number.isFinite(Number(options.skipRiskWeight))) {
    base[9] = Number(options.skipRiskWeight);
  }
  return base;
}

function buildStage1QueryVectors(profile, { contextEntry, sessionSteer, extraQueries = [], sequenceWeight = 1, preparedInterests = null } = {}) {
  const queries = [];
  if (profile?.recentVector) queries.push({ vector: profile.recentVector, weight: 1.0 });
  if (preparedInterests?.candidates?.length) {
    for (let j = 0; j < preparedInterests.candidates.length; j++) {
      const interestVec = preparedInterests.candidates[j].vector;
      const prob = preparedInterests.probs[j];
      if (profile?.recentVector && interestVec.length === profile.recentVector.length) {
        const blended = new Float32Array(interestVec.length);
        const seqScale = 0.30 * sequenceWeight;
        let ss = 0;
        for (let d = 0; d < blended.length; d++) {
          const val = 0.52 * interestVec[d] + seqScale * profile.recentVector[d];
          blended[d] = val;
          ss += val * val;
        }
        const inv = 1 / (Math.sqrt(ss) || 1);
        for (let d = 0; d < blended.length; d++) blended[d] *= inv;
        queries.push({ vector: blended, weight: Math.max(0.25, prob) });
      } else {
        queries.push({ vector: interestVec, weight: Math.max(0.25, prob) });
      }
    }
  } else if (profile?.vector) {
    queries.push({ vector: profile.vector, weight: 1.0 });
  }
  if (contextEntry?.vector) queries.push({ vector: contextEntry.vector, weight: 0.55 });
  if (sessionSteer?.state) queries.push({ vector: sessionSteer.state, weight: 0.9 });
  for (const q of extraQueries || []) {
    if (q?.vector || Array.isArray(q) || ArrayBuffer.isView(q)) queries.push(q?.vector ? q : { vector: q, weight: 1.0 });
  }
  return queries;
}

export function rankContextualSongs(songs = [], options = {}) {
  const profile = options.profile;
  const likedSongKeys = new Set(options.likedSongKeys || []);
  const excluded = new Set(options.excludeSongKeys || []);
  const playCountByKey = options.playCountByKey || new Map();
  const now = timestampValue(options.now, Date.now());
  const hourOfDay = Number.isFinite(options.currentContext?.hour) ? options.currentContext.hour : new Date(now).getHours();
  const activeTimeBucket = options.currentContext?.timeBucket || profile?.currentContext?.timeBucket;
  const contextEntry = activeTimeBucket ? profile?.contextVectors?.[activeTimeBucket] : null;
  const contextBlendWeight = contextEntry?.vector
    ? (contextEntry.sessions / (contextEntry.sessions + CONTEXT_PRIOR_SESSIONS))
    : 0;
  // Stale sessions hand their weight back to long-term taste instead of
  // steering today's picks with what was played weeks ago.
  const sequenceWeight = Number.isFinite(profile?.sequenceWeight) ? Math.min(1, Math.max(0, profile.sequenceWeight)) : 1;
  const preparedInterests = profile?.interests?.length > 1
    ? prepareInterestsLogSumExp(profile.interests, {
      sessionVector: sequenceWeight > 0.05 ? profile.recentVector : null,
      beta: 6.0 * sequenceWeight,
      tau: 10.0,
    })
    : null;
  const weights = resolveRankerWeights(options.rankerWeights, options);
  const computeSkipRisk = weights[9] !== 0 && (hasCustomSkipPredictor() || Boolean(options.useSkipRisk));
  const collabGraph = options.collabGraph || null;
  const collabWeight = Number(options.collabWeight || 0) || 0;
  const collabAnchorKeys = Array.isArray(options.collabAnchorKeys) ? options.collabAnchorKeys : [];
  const useCollab = Boolean(collabGraph?.neighbors?.size && collabWeight > 0 && collabAnchorKeys.length);

  const fullScanBelow = options.fullScanBelow ?? DEFAULT_FULL_SCAN_THRESHOLD;
  let candidatePool = songs;
  if (songs.length >= fullScanBelow) {
    const queryVectors = buildStage1QueryVectors(profile, {
      contextEntry,
      sessionSteer: options.sessionSteer,
      extraQueries: options.queryVectors,
      sequenceWeight,
      preparedInterests,
    });
    if (queryVectors.length > 0) {
      const recentPlayedKeys = profile?.lastPlayedAtByKey instanceof Map
        ? Array.from(profile.lastPlayedAtByKey.keys())
        : Object.keys(profile?.lastPlayedAtByKey || {});
      const collabBoostKeys = useCollab ? topCooccurrenceCandidates(collabGraph, collabAnchorKeys, 120) : [];
      const alwaysIncludeKeys = [
        ...likedSongKeys,
        ...recentPlayedKeys.slice(0, 200),
        ...collabBoostKeys,
        ...(options.alwaysIncludeKeys || []),
      ];
      const stage1 = selectStage1Candidates(songs, {
        queryVectors,
        targetSize: options.stage1Limit ?? DEFAULT_STAGE1_LIMIT,
        fullScanBelow,
        alwaysIncludeKeys,
        excludeKeys: options.excludeSongKeys,
        indexOptions: {
          getVector: (song, key) => resolveCandidateVector(song, key, profile, options.gemmaVectors),
          vectorSource: options.gemmaVectors || songs,
          vectorMapSize: options.gemmaVectors?.size || 0,
        },
      });
      candidatePool = stage1.candidates;
    }
  }

  const featCtx = {
    profile,
    gemmaVectors: options.gemmaVectors,
    playCountByKey,
    sequenceWeight,
    contextBlendWeight,
    contextEntry,
    likedSongKeys,
    now,
    hourOfDay,
    sessionSteer: options.sessionSteer,
    computeSkipRisk,
    preparedInterests,
  };

  const scored = candidatePool
    .map(song => {
      const extracted = extractContextualCandidateFeatures(song, featCtx);
      const features = extracted.features;
      let score = 0;
      for (let i = 0; i < weights.length; i++) score += weights[i] * (features[i] || 0);
      if (useCollab) {
        score += collabWeight * scoreCooccurrenceCandidate(collabGraph, collabAnchorKeys, extracted.key);
      }
      return {
        song,
        key: extracted.key,
        artist: String(song.artist || '').trim().toLowerCase(),
        score,
        steerScore: extracted.steerScore,
        plays: extracted.plays,
      };
    })
    .filter(item => item.key && !excluded.has(item.key));

  const limit = Math.floor(Math.max(0, finiteNumber(options.limit, scored.length)));
  const selected = [];
  if (limit === 0 || scored.length === 0) return selected;

  // Sorting descending by base score lets the greedy artist-diversity pass break early
  // once item.score falls below bestAdjustedScore (since artistPenalty >= 0).
  const remaining = scored.slice().sort((a, b) => (
    (b.score - a.score)
    || String(a.song.track || '').localeCompare(String(b.song.track || ''))
  ));
  const artistCounts = new Map();
  const taken = new Uint8Array(remaining.length);
  const targetCount = Math.min(limit, remaining.length);
  let scanStart = 0;

  while (selected.length < targetCount) {
    while (scanStart < remaining.length && taken[scanStart]) scanStart++;
    if (scanStart >= remaining.length) break;

    let bestIndex = -1;
    let bestAdjustedScore = -Infinity;
    for (let index = scanStart; index < remaining.length; index++) {
      if (taken[index]) continue;
      const item = remaining[index];
      if (bestIndex >= 0 && item.score < bestAdjustedScore - 1e-9) break;
      const artistPenalty = item.artist ? Math.min(0.2, (artistCounts.get(item.artist) || 0) * 0.11) : 0;
      const adjustedScore = item.score - artistPenalty;
      if (
        bestIndex < 0
        || adjustedScore > bestAdjustedScore + 1e-9
        || (Math.abs(adjustedScore - bestAdjustedScore) <= 1e-9 && (
          item.score > remaining[bestIndex].score + 1e-9
          || (Math.abs(item.score - remaining[bestIndex].score) <= 1e-9
            && String(item.song.track || '').localeCompare(String(remaining[bestIndex].song.track || '')) < 0)
        ))
      ) {
        bestIndex = index;
        bestAdjustedScore = adjustedScore;
      }
    }
    if (bestIndex < 0) break;
    taken[bestIndex] = 1;
    const best = remaining[bestIndex];
    artistCounts.set(best.artist, (artistCounts.get(best.artist) || 0) + 1);
    selected.push({
      ...best.song,
      tasteScore: bestAdjustedScore,
      recommendationScore: best.score,
    });
  }

  return selected;
}

export function enrichPlaybackEvent(event = {}, sessionState = {}, options = {}) {
  const fallbackNow = timestampValue(options.now, Date.now());
  const eventAt = timestampValue(event.createdAt, fallbackNow);
  const explicitSessionId = String(event.sessionId || '').trim();
  const previousAt = finiteNumber(sessionState.lastTimestamp);
  const needsNewSession = explicitSessionId
    ? sessionState.id !== explicitSessionId
    : !sessionState.id || !previousAt || eventAt < previousAt || eventAt - previousAt > PLAYBACK_SESSION_GAP_MS;

  if (needsNewSession) {
    sessionState.sequence = finiteNumber(sessionState.sequence) + 1;
    sessionState.id = explicitSessionId || `session-${eventAt || fallbackNow}-${sessionState.sequence}`;
  }
  sessionState.lastTimestamp = eventAt;

  const context = normaliseContext({
    ...(event.context || {}),
    sourceSurface: event.context?.sourceSurface || event.sourceSurface || event.source || 'player',
  }, eventAt, options.userAgent || '');
  const enriched = {
    ...event,
    sessionId: sessionState.id,
    context,
    sourceSurface: event.sourceSurface || event.source || 'player',
    secondsPlayed: event.secondsPlayed == null ? eventPosition(event) : Math.max(0, finiteNumber(event.secondsPlayed)),
  };
  if (event.eventType === 'user-skip') enriched.skipReason = event.skipReason || event.message || 'user-skip';
  return enriched;
}

export function resolveEmbeddingMetadata(item) {
  if (!item) return null;
  const vector = item.vector;
  if (!vector || (!Array.isArray(vector) && !ArrayBuffer.isView(vector))) return null;

  const rawVectorType = item.vectorType || item.embeddingType;
  const rawModel = item.model || item.embeddingModel;
  const isExplicitLearnedAudio = rawVectorType === 'learned-audio' && Boolean(rawModel);

  const vectorType = isExplicitLearnedAudio ? 'learned-audio' : 'metadata';
  const model = isExplicitLearnedAudio ? String(rawModel) : (rawModel || 'sisic-metadata-heuristics');
  const modelVersion = String(item.modelVersion || item.embeddingModelVersion || '1.0.0');
  const dimensions = Number(item.dimensions || item.embeddingDimensions || vector.length);
  const provider = String(item.provider || item.embeddingProvider || (isExplicitLearnedAudio ? 'registered-audio-provider' : 'sisic-client'));

  return {
    vector,
    vectorType,
    model,
    modelVersion,
    dimensions,
    provider,
  };
}

export function areVectorSpacesCompatible(metaA, metaB) {
  if (!metaA || !metaB) return false;
  if (metaA.vectorType !== metaB.vectorType) return false;
  if (metaA.dimensions !== metaB.dimensions) return false;
  if (metaA.vectorType === 'learned-audio') {
    return metaA.model === metaB.model;
  }
  return true;
}

export function isLearnedAudioProvider(provider = '') {
  const p = String(provider || '').toLowerCase();
  return p.includes('audio-learned') || p.includes('onnx') || p.includes('m2v') || p.includes('musicnn');
}

export function validateAndNormalizeVector(vector, expectedDimensions = EMBEDDING_DIMENSIONS) {
  if (!vector || (!Array.isArray(vector) && !ArrayBuffer.isView(vector))) return null;
  const length = vector.length;
  if (length === 0) return null;
  if (expectedDimensions != null && length !== expectedDimensions) return null;
  let sumSq = 0;
  for (let i = 0; i < length; i++) {
    const val = Number(vector[i]);
    if (!Number.isFinite(val)) return null;
    sumSq += val * val;
  }
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return null;
  if (Math.abs(norm - 1.0) < 1e-4) {
    return vector;
  }
  const normalized = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    normalized[i] = vector[i] / norm;
  }
  return Array.from(normalized);
}

/**
 * Builds Up Next recommendations using taste embeddings (metadata or learned audio) when available,
 * with strict space separation (never mixing metadata and audio vectors) and honest fallback
 * to contextual playback signals when absent or incompatible.
 */
export const STAGE3_768D_ENABLED = false;

export async function buildUpNextRecommendations({
  currentSong,
  librarySongs = [],
  playbackEvents = [],
  likedSongKeys = [],
  recentlyPlayedKeys = [],
  manualQueue = [],
  limit = 5,
  signal,
  getEmbedding,
  gemmaVectors: gemmaVectorsOption,
  sessionSteer,
  rankerWeights,
  fullScanBelow = DEFAULT_FULL_SCAN_THRESHOLD,
  stage1Limit = DEFAULT_STAGE1_LIMIT,
  enableStage3Rerank = STAGE3_768D_ENABLED,
  getWhitened768Vector,
  stage3TopK = 200,
  collabGraph = null,
  collabWeight = 0,
} = {}) {
  // An empty map means "no Gemma vectors yet": keep the old MusiCNN/metadata path untouched.
  const gemmaVectors = gemmaVectorsOption?.size ? gemmaVectorsOption : null;
  if (!currentSong || !Array.isArray(librarySongs) || librarySongs.length === 0) return [];
  const currentKey = currentSong.songKey || getSongKey(currentSong);
  if (!currentKey) return [];

  // 1. Build exclusion sets: current track, recent history, manual queue
  const recentKeys = new Set(recentlyPlayedKeys);
  recentKeys.add(currentKey);
  const manualKeys = new Set((manualQueue || []).map(s => s?.songKey || getSongKey(s)).filter(Boolean));

  const hasDriveFiles = librarySongs.some(s => s?.driveFileId);
  const seenCandidateKeys = new Set();
  const candidates = [];

  for (const song of librarySongs) {
    if (!song) continue;
    const key = song.songKey || getSongKey(song);
    if (!key || seenCandidateKeys.has(key)) continue;
    if (recentKeys.has(key) || manualKeys.has(key)) continue;
    if (song.isDeleted || song.isDuplicate) continue;

    // Filter to playable songs if streamable tracks exist
    const isPlayableSong = Boolean(song.driveFileId || song.isPlayable || song.status === 'ready');
    if (hasDriveFiles && !isPlayableSong) continue;

    seenCandidateKeys.add(key);
    candidates.push(song);
  }

  if (candidates.length === 0) return [];
  if (signal?.aborted) return [];

  const activeSteer = sessionSteer || createSessionSteer();
  if (!sessionSteer && gemmaVectors) {
    // Steer from the current listening session only, not the whole history.
    for (const event of currentSessionEvents(playbackEvents)) {
      const vector = gemmaVectors?.get?.(event.songKey)?.vector;
      const weight = outcomeWeight(event);
      if (vector && weight) activeSteer.observe(vector, weight);
    }
  }
  const gemmaDimensions = gemmaVectors?.values?.().next?.().value?.vector?.length;

  // 2. Resolve embedding and boundary endVector for current song
  let currentMeta = null;
  let currentVector = null;
  let currentEndVector = null;
  const gemmaCurrent = gemmaVectors?.get?.(currentKey);
  if (gemmaCurrent?.vector) {
    currentVector = validateAndNormalizeVector(gemmaCurrent.vector, gemmaCurrent.vector.length);
    if (currentVector) {
      currentMeta = {
        vectorType: 'gemma',
        model: gemmaCurrent.embeddingModel || GEMMA2_MODEL,
        dimensions: currentVector.length,
      };
    }
    if (gemmaCurrent.endVector?.length) {
      currentEndVector = validateAndNormalizeVector(gemmaCurrent.endVector, gemmaCurrent.endVector.length);
    }
  } else if (!gemmaVectors && currentSong.vector) {
    const rawDims = currentSong.dimensions || currentSong.embeddingDimensions || currentSong.vector.length;
    const norm = validateAndNormalizeVector(currentSong.vector, rawDims);
    if (norm) {
      currentMeta = resolveEmbeddingMetadata({ ...currentSong, vector: norm });
      currentVector = norm;
    }
  }
  if (!currentVector && !gemmaVectors && typeof getEmbedding === 'function') {
    try {
      const loaded = await getEmbedding(currentKey);
      if (loaded?.vector) {
        const rawDims = loaded.dimensions || loaded.vector.length;
        const norm = validateAndNormalizeVector(loaded.vector, rawDims);
        if (norm) {
          currentMeta = resolveEmbeddingMetadata({ ...loaded, vector: norm });
          currentVector = norm;
        }
      }
    } catch {
      // Missing embedding or failure handled honestly
    }
  }

  if (signal?.aborted) return [];

  // 3. Build contextual taste profile from playback history within compatible space
  const profile = buildContextualTasteProfile(librarySongs, playbackEvents, {
    excludeSongKeys: Array.from(recentKeys),
    targetSpace: currentMeta?.vectorType || (gemmaVectors ? 'gemma' : 'metadata'),
    targetModel: currentMeta?.model || null,
    targetDimensions: currentMeta?.dimensions || gemmaDimensions || EMBEDDING_DIMENSIONS,
    gemmaVectors,
    likedSongKeys,
    now: Date.now(),
  });
  const transStats = playbackEvents.length ? pairTransitionStats(playbackEvents) : null;
  const activeCollabWeight = Number(collabWeight || 0) || 0;
  const useCollab = Boolean(collabGraph?.neighbors?.size && activeCollabWeight > 0);
  const sessionAnchors = useCollab ? extractRecentAnchorKeys(currentSessionEvents(playbackEvents), 2) : [];
  const collabAnchorKeys = useCollab
    ? [currentKey, ...sessionAnchors.filter(key => key !== currentKey)]
    : [];

  // 4. Stage-1 candidate generation at large catalog scales (>= 8K); full scan below.
  const hasEmbedding = Boolean(currentVector && currentMeta);
  let activeCandidates = candidates;
  if (candidates.length >= fullScanBelow) {
    const seqWeight = Number.isFinite(profile?.sequenceWeight) ? Math.min(1, Math.max(0, profile.sequenceWeight)) : 1;
    const preparedInterests = profile?.interests?.length > 1
      ? prepareInterestsLogSumExp(profile.interests, {
        sessionVector: seqWeight > 0.05 ? profile.recentVector : null,
        beta: 6.0 * seqWeight,
        tau: 10.0,
      })
      : null;
    const queryVectors = buildStage1QueryVectors(profile, {
      sessionSteer: activeSteer,
      extraQueries: currentVector ? [{ vector: currentVector, weight: 1.15 }] : [],
      sequenceWeight: seqWeight,
      preparedInterests,
    });
    if (queryVectors.length > 0) {
      const collabBoostKeys = useCollab ? topCooccurrenceCandidates(collabGraph, collabAnchorKeys, 120) : [];
      const stage1 = selectStage1Candidates(candidates, {
        queryVectors,
        targetSize: stage1Limit,
        fullScanBelow,
        alwaysIncludeKeys: [...likedSongKeys, ...collabBoostKeys],
        indexOptions: {
          getVector: (song, key) => resolveCandidateVector(song, key, profile, gemmaVectors),
          vectorSource: gemmaVectors || candidates,
          vectorMapSize: gemmaVectors?.size || 0,
        },
      });
      activeCandidates = stage1.candidates;
    }
  }

  const scored = [];
  for (const candidate of activeCandidates) {
    const candKey = candidate.songKey || getSongKey(candidate);
    let candMeta = null;
    let candVector = null;
    let candStartVector = null;
    const gemmaCandidate = gemmaVectors?.get?.(candKey);
    if (gemmaCandidate?.vector) {
      candVector = validateAndNormalizeVector(gemmaCandidate.vector, gemmaCandidate.vector.length);
      if (candVector) {
        candMeta = {
          vectorType: 'gemma',
          model: gemmaCandidate.embeddingModel || GEMMA2_MODEL,
          dimensions: candVector.length,
        };
      }
      if (gemmaCandidate.startVector?.length) {
        candStartVector = validateAndNormalizeVector(gemmaCandidate.startVector, gemmaCandidate.startVector.length);
      }
    } else if (!gemmaVectors && candidate.vector) {
      const rawDims = candidate.dimensions || candidate.embeddingDimensions || candidate.vector.length;
      const norm = validateAndNormalizeVector(candidate.vector, rawDims);
      if (norm) {
        candMeta = resolveEmbeddingMetadata({ ...candidate, vector: norm });
        candVector = norm;
      }
    }
    if (!candVector && hasEmbedding && !gemmaVectors && typeof getEmbedding === 'function') {
      try {
        const loaded = await getEmbedding(candKey);
        if (loaded?.vector) {
          const rawDims = loaded.dimensions || loaded.vector.length;
          const norm = validateAndNormalizeVector(loaded.vector, rawDims);
          if (norm) {
            candMeta = resolveEmbeddingMetadata({ ...loaded, vector: norm });
            candVector = norm;
          }
        }
      } catch {
        // Honest fallback
      }
    }

    let embeddingSimilarity = null;
    let seamSimilarity = null;
    let isCompatible = false;
    if (hasEmbedding && candMeta && candVector) {
      isCompatible = areVectorSpacesCompatible(currentMeta, candMeta);
      if (isCompatible) {
        const globalSim = cosineSimilarity(currentVector, candVector);
        if (currentEndVector && candStartVector && currentEndVector.length === candStartVector.length) {
          seamSimilarity = cosineSimilarity(currentEndVector, candStartVector);
          // 55/45 acoustic + boundary seam blend measured in v3 evaluation (+0.26 seam lift)
          embeddingSimilarity = (0.55 * globalSim) + (0.45 * seamSimilarity);
        } else {
          embeddingSimilarity = globalSim;
        }
      }
    }

    scored.push({
      candidate,
      candKey,
      candMeta,
      embeddingSimilarity,
      seamSimilarity,
      isCompatible,
    });
  }

  // Rank with contextual signals (LogSumExp interests, context shrinkage, play/skip signals, diversity)
  const rankedContextual = rankContextualSongs(
    scored.map(s => s.candidate),
    {
      profile,
      likedSongKeys,
      excludeSongKeys: Array.from(recentKeys),
      limit: Math.min(scored.length, Math.max(limit * 10, 200)),
      gemmaVectors,
      sessionSteer: null,
      rankerWeights,
      fullScanBelow: Infinity,
      ...(useCollab ? { collabGraph, collabWeight: activeCollabWeight, collabAnchorKeys } : {}),
    }
  );
  const contextualScoreByKey = new Map(rankedContextual.map((item, idx) => [
    item.songKey || getSongKey(item),
    item.recommendationScore ?? (1 - idx / Math.max(1, rankedContextual.length)),
  ]));

  // Combine scores: boundary-aware embedding similarity (when compatible) + contextual affinity
  const finalScored = scored.map(item => {
    const contextualScore = contextualScoreByKey.get(item.candKey) ?? 0;
    const hasEmbeddingMatch = typeof item.embeddingSimilarity === 'number' && item.isCompatible;
    const badTransition = transStats ? transitionPenalty(transStats, currentKey, item.candKey) : 0;

    let finalScore;
    if (hasEmbeddingMatch) {
      finalScore = (item.embeddingSimilarity * 0.55) + (contextualScore * 0.45) - (badTransition * 0.18);
    } else {
      // Honest fallback: contextual score without pretending to have an embedding
      finalScore = contextualScore - (badTransition * 0.18);
    }

    return {
      song: item.candidate,
      score: finalScore,
      hasEmbedding: hasEmbeddingMatch,
      embeddingType: hasEmbeddingMatch ? item.candMeta?.vectorType : null,
      embeddingModel: hasEmbeddingMatch ? item.candMeta?.model : null,
      similarityScore: hasEmbeddingMatch ? item.embeddingSimilarity : undefined,
      seamSimilarity: typeof item.seamSimilarity === 'number' ? item.seamSimilarity : undefined,
      isFallback: !hasEmbeddingMatch,
      _vector: item.candMeta?.vectorType === 'gemma' ? gemmaVectors?.get?.(item.candKey)?.vector : item.candidate.vector,
    };
  });

  // Sort descending by finalScore
  if (activeSteer?.state) {
    const reranked = activeSteer.rerank(finalScored.map(item => ({ ...item, vector: item._vector, baseScore: item.score })), { mix: 0.25 });
    const scores = new Map(reranked.map(item => [item.song.songKey || getSongKey(item.song), item.rerankScore]));
    finalScored.forEach(item => { item.score = scores.get(item.song.songKey || getSongKey(item.song)) ?? item.score; });
  }
  finalScored.sort((a, b) => b.score - a.score);

  // Optional behind-flag Stage 3: whitened-768D re-check over Stage 2 top-200.
  // Off by default because eval_recs_v3 measured -0.0091 unseen-artist Tag Jaccard@5 lift.
  if (enableStage3Rerank && typeof getWhitened768Vector === 'function' && finalScored.length > 0) {
    const query768 = await getWhitened768Vector(currentKey);
    if (query768 && !signal?.aborted) {
      const topSlice = finalScored.slice(0, Math.min(stage3TopK, finalScored.length));
      for (const item of topSlice) {
        const key = item.song.songKey || getSongKey(item.song);
        const cand768 = await getWhitened768Vector(key);
        if (cand768 && cand768.length === query768.length) {
          const sim768 = cosineSimilarity(query768, cand768);
          item.score = (item.score * 0.75) + (sim768 * 0.25);
        }
      }
      finalScored.sort((a, b) => b.score - a.score);
    }
  }

  // Apply artist diversity: max 2 tracks per artist unless pool is small
  const result = [];
  const artistCounts = new Map();
  const targetLimit = Math.min(limit, finalScored.length);

  const formatResult = item => ({
    ...item.song,
    hasEmbedding: item.hasEmbedding,
    embeddingType: item.embeddingType,
    embeddingModel: item.embeddingModel,
    similarityScore: item.similarityScore,
    ...(typeof item.seamSimilarity === 'number' ? { seamSimilarity: item.seamSimilarity } : {}),
    isFallback: item.isFallback,
    recommendationScore: item.score,
  });

  for (const item of finalScored) {
    if (result.length >= targetLimit) break;
    const artist = String(item.song.artist || '').trim().toLowerCase();
    const count = artistCounts.get(artist) || 0;
    if (count >= 2 && finalScored.length > targetLimit) continue;
    artistCounts.set(artist, count + 1);

    result.push(formatResult(item));
  }

  if (result.length < targetLimit) {
    const includedKeys = new Set(result.map(s => s.songKey || getSongKey(s)));
    for (const item of finalScored) {
      if (result.length >= targetLimit) break;
      const key = item.song.songKey || getSongKey(item.song);
      if (!includedKeys.has(key)) {
        includedKeys.add(key);
        result.push(formatResult(item));
      }
    }
  }

  return result;
}
