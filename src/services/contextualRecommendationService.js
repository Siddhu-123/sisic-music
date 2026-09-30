import { getSongKey } from '../songIdentity.js';
import {
  computeSongEmbedding,
  cosineSimilarity,
  EMBEDDING_DIMENSIONS,
} from './tasteEmbeddingService.js';

export const PLAYBACK_SESSION_GAP_MS = 20 * 60 * 1000;
export const PLAYBACK_START_EVENT_TYPES = Object.freeze(['playback-start', 'playback-resume']);

const DAY_MS = 24 * 60 * 60 * 1000;

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
  if (eventType === 'playback-complete') {
    track.completeCount += 1;
    track.positiveWeight += 1;
  } else if (eventType === 'playback-pause') {
    track.pauseCount += 1;
    track.positiveWeight += completionRatio(event) >= 0.65 ? 0.7 : 0.15;
  } else if (eventType === 'playback-stop') {
    track.stopCount += 1;
    track.positiveWeight += completionRatio(event) >= 0.65 ? 0.65 : 0.12;
  }
  if (eventType === 'user-skip') {
    track.skipCount += 1;
    track.negativeWeight += 1;
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
  if (song?.vector && song.vector.length === EMBEDDING_DIMENSIONS) return song.vector;
  return computeSongEmbedding(song);
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
  const now = timestampValue(options.now, Date.now());
  const halfLifeDays = Math.max(1, finiteNumber(options.recencyHalfLifeDays, 30));
  const currentContext = options.currentContext || getPlaybackContext(now, options.userAgent || '');
  let positiveSignalCount = 0;
  let negativeSignalCount = 0;

  function getCompatibleVector(song) {
    if (!song) return null;
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

    session.tracks.forEach(track => {
      const song = songByKey.get(track.songKey);
      if (!song) return;
      const vector = getCompatibleVector(song);
      const positiveWeight = track.status === 'skipped' ? 0 : Math.min(1.6, track.positiveWeight);
      const negativeWeight = Math.min(1.4, track.negativeWeight);
      if (positiveWeight > 0) {
        if (vector) addWeightedVector(positiveAccumulator, vector, positiveWeight * sessionWeight);
        positiveSignalCount += 1;
        lastPlayedAtByKey.set(track.songKey, Math.max(lastPlayedAtByKey.get(track.songKey) || 0, track.lastEventAt));
      }
      if (negativeWeight > 0) {
        if (vector) addWeightedVector(negativeAccumulator, vector, negativeWeight * sessionWeight);
        negativeSignalCount += 1;
      }

      if (sessionIndex === sessions.length - 1 && track.status !== 'skipped' && vector) {
        const orderWeight = 0.65 + ((session.tracks.indexOf(track) + 1) / Math.max(1, session.tracks.length)) * 0.35;
        addWeightedVector(recentAccumulator, vector, Math.max(0.2, positiveWeight) * orderWeight);
      }
    });
  });

  const recentSession = sessions.at(-1);
  return {
    vector: normaliseVector(positiveAccumulator),
    negativeVector: normaliseVector(negativeAccumulator),
    recentVector: normaliseVector(recentAccumulator),
    sessions,
    sessionCount: sessions.length,
    positiveSignalCount,
    negativeSignalCount,
    hasSignal: Boolean(positiveSignalCount || negativeSignalCount),
    currentContext,
    recentSongKeys: recentSession?.trackKeys || [],
    lastPlayedAtByKey,
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

export function rankContextualSongs(songs = [], options = {}) {
  const profile = options.profile;
  const likedSongKeys = new Set(options.likedSongKeys || []);
  const excluded = new Set(options.excludeSongKeys || []);
  const playCountByKey = options.playCountByKey || new Map();
  const now = timestampValue(options.now, Date.now());
  const scored = songs
    .map(song => {
      const key = song.songKey || getSongKey(song);
      let vector = null;
      if (profile?.spaceMeta) {
        const meta = resolveEmbeddingMetadata(song);
        if (meta && areVectorSpacesCompatible(profile.spaceMeta, meta)) {
          vector = meta.vector;
        } else if (profile.spaceMeta.vectorType === 'metadata') {
          vector = getSongVector(song);
        }
      } else {
        vector = getSongVector(song);
      }

      const plays = Math.max(finiteNumber(song.playCount), playCountFor(playCountByKey, key));
      const tasteAffinity = (profile?.vector && vector) ? cosineSimilarity(profile.vector, vector) : 0;
      const sequenceAffinity = (profile?.recentVector && vector) ? cosineSimilarity(profile.recentVector, vector) : 0;
      const skipAffinity = (profile?.negativeVector && vector) ? cosineSimilarity(profile.negativeVector, vector) : 0;
      const likedBoost = likedSongKeys.has(key) ? 0.22 : 0;
      const popularityBoost = Math.min(0.14, Math.log1p(plays) * 0.045);
      const discoveryBoost = plays === 0 ? (profile?.hasSignal ? 0.035 : 0.05) : 0;
      const lastPlayedAt = profile?.lastPlayedAtByKey instanceof Map
        ? profile.lastPlayedAtByKey.get(key)
        : profile?.lastPlayedAtByKey?.[key];
      const recentPenalty = recencyPenalty(lastPlayedAt, now);
      const score = (tasteAffinity * 0.52)
        + (sequenceAffinity * 0.3)
        - (skipAffinity * 0.28)
        + likedBoost
        + popularityBoost
        + discoveryBoost
        - recentPenalty;
      return {
        song,
        key,
        artist: String(song.artist || '').trim().toLowerCase(),
        score,
        plays,
      };
    })
    .filter(item => item.key && !excluded.has(item.key));

  const limit = Math.floor(Math.max(0, finiteNumber(options.limit, scored.length)));
  const selected = [];
  const artistCounts = new Map();
  const remaining = [...scored];

  while (remaining.length && selected.length < limit) {
    let bestIndex = 0;
    let bestAdjustedScore = -Infinity;
    for (let index = 0; index < remaining.length; index++) {
      const item = remaining[index];
      const artistPenalty = item.artist ? Math.min(0.2, (artistCounts.get(item.artist) || 0) * 0.11) : 0;
      const adjustedScore = item.score - artistPenalty;
      const currentBest = remaining[bestIndex];
      const currentBestPenalty = currentBest?.artist
        ? Math.min(0.2, (artistCounts.get(currentBest.artist) || 0) * 0.11)
        : 0;
      if (
        adjustedScore > bestAdjustedScore
        || (Math.abs(adjustedScore - bestAdjustedScore) < 1e-9 && (
          item.score - artistPenalty > currentBest?.score - currentBestPenalty
          || (item.score === currentBest?.score && String(item.song.track || '').localeCompare(String(currentBest.song.track || '')) < 0)
        ))
      ) {
        bestIndex = index;
        bestAdjustedScore = adjustedScore;
      }
    }
    const [best] = remaining.splice(bestIndex, 1);
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
    return Array.isArray(vector) ? vector : Array.from(vector);
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
} = {}) {
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
    // Bounded candidate pool: cap at 80 candidate tracks to keep recommendation computation fast
    if (candidates.length >= 80) break;
  }

  if (candidates.length === 0) return [];
  if (signal?.aborted) return [];

  // 2. Resolve embedding for current song
  let currentMeta = null;
  let currentVector = null;
  if (currentSong.vector) {
    const rawDims = currentSong.dimensions || currentSong.embeddingDimensions || currentSong.vector.length;
    const norm = validateAndNormalizeVector(currentSong.vector, rawDims);
    if (norm) {
      currentMeta = resolveEmbeddingMetadata({ ...currentSong, vector: norm });
      currentVector = norm;
    }
  }
  if (!currentVector && typeof getEmbedding === 'function') {
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
    targetSpace: currentMeta?.vectorType || 'metadata',
    targetModel: currentMeta?.model || null,
    targetDimensions: currentMeta?.dimensions || EMBEDDING_DIMENSIONS,
  });

  // 4. Rank candidates using embedding similarity when available and compatible, with honest fallback.
  const hasEmbedding = Boolean(currentVector && currentMeta);

  const scored = [];
  for (const candidate of candidates) {
    const candKey = candidate.songKey || getSongKey(candidate);
    let candMeta = null;
    let candVector = null;
    if (candidate.vector) {
      const rawDims = candidate.dimensions || candidate.embeddingDimensions || candidate.vector.length;
      const norm = validateAndNormalizeVector(candidate.vector, rawDims);
      if (norm) {
        candMeta = resolveEmbeddingMetadata({ ...candidate, vector: norm });
        candVector = norm;
      }
    }
    if (!candVector && hasEmbedding && typeof getEmbedding === 'function') {
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
    let isCompatible = false;
    if (hasEmbedding && candMeta && candVector) {
      isCompatible = areVectorSpacesCompatible(currentMeta, candMeta);
      if (isCompatible) {
        embeddingSimilarity = cosineSimilarity(currentVector, candVector);
      }
    }

    scored.push({
      candidate,
      candKey,
      candMeta,
      embeddingSimilarity,
      isCompatible,
    });
  }

  // Rank with contextual signals (play counts, skip affinity, sequence affinity, liked boost, recency penalty, artist diversity)
  const rankedContextual = rankContextualSongs(
    scored.map(s => s.candidate),
    {
      profile,
      likedSongKeys,
      excludeSongKeys: Array.from(recentKeys),
      limit: candidates.length,
    }
  );
  const contextualScoreByKey = new Map(rankedContextual.map((item, idx) => [
    item.songKey || getSongKey(item),
    item.recommendationScore ?? (1 - idx / Math.max(1, rankedContextual.length)),
  ]));

  // Combine scores: embedding similarity (when available and compatible) + contextual affinity
  const finalScored = scored.map(item => {
    const contextualScore = contextualScoreByKey.get(item.candKey) ?? 0;
    const hasEmbeddingMatch = typeof item.embeddingSimilarity === 'number' && item.isCompatible;

    let finalScore;
    if (hasEmbeddingMatch) {
      finalScore = item.embeddingSimilarity * 0.55 + contextualScore * 0.45;
    } else {
      // Honest fallback: contextual score without pretending to have an embedding
      finalScore = contextualScore;
    }

    return {
      song: item.candidate,
      score: finalScore,
      hasEmbedding: hasEmbeddingMatch,
      embeddingType: hasEmbeddingMatch ? item.candMeta?.vectorType : null,
      embeddingModel: hasEmbeddingMatch ? item.candMeta?.model : null,
      similarityScore: hasEmbeddingMatch ? item.embeddingSimilarity : undefined,
      isFallback: !hasEmbeddingMatch,
    };
  });

  // Sort descending by finalScore
  finalScored.sort((a, b) => b.score - a.score);

  // Apply artist diversity: max 2 tracks per artist unless pool is small
  const result = [];
  const artistCounts = new Map();
  const targetLimit = Math.min(limit, finalScored.length);

  for (const item of finalScored) {
    if (result.length >= targetLimit) break;
    const artist = String(item.song.artist || '').trim().toLowerCase();
    const count = artistCounts.get(artist) || 0;
    if (count >= 2 && finalScored.length > targetLimit) continue;
    artistCounts.set(artist, count + 1);

    result.push({
      ...item.song,
      hasEmbedding: item.hasEmbedding,
      embeddingType: item.embeddingType,
      embeddingModel: item.embeddingModel,
      similarityScore: item.similarityScore,
      isFallback: item.isFallback,
      recommendationScore: item.score,
    });
  }

  if (result.length < targetLimit) {
    const includedKeys = new Set(result.map(s => s.songKey || getSongKey(s)));
    for (const item of finalScored) {
      if (result.length >= targetLimit) break;
      const key = item.song.songKey || getSongKey(item.song);
      if (!includedKeys.has(key)) {
        includedKeys.add(key);
        result.push({
          ...item.song,
          hasEmbedding: item.hasEmbedding,
          embeddingType: item.embeddingType,
          embeddingModel: item.embeddingModel,
          similarityScore: item.similarityScore,
          isFallback: item.isFallback,
          recommendationScore: item.score,
        });
      }
    }
  }

  return result;
}
