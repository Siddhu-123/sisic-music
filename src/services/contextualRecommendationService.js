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
  if (!vector || !weight) return;
  for (let index = 0; index < EMBEDDING_DIMENSIONS; index++) accumulator[index] += vector[index] * weight;
}

export function buildContextualTasteProfile(songs = [], playbackEvents = [], options = {}) {
  const sessions = sessionizePlaybackEvents(playbackEvents, options);
  const songByKey = new Map(songs.map(song => [song.songKey || getSongKey(song), song]));
  const positiveAccumulator = new Float32Array(EMBEDDING_DIMENSIONS);
  const negativeAccumulator = new Float32Array(EMBEDDING_DIMENSIONS);
  const recentAccumulator = new Float32Array(EMBEDDING_DIMENSIONS);
  const lastPlayedAtByKey = new Map();
  const now = timestampValue(options.now, Date.now());
  const halfLifeDays = Math.max(1, finiteNumber(options.recencyHalfLifeDays, 30));
  const currentContext = options.currentContext || getPlaybackContext(now, options.userAgent || '');
  let positiveSignalCount = 0;
  let negativeSignalCount = 0;

  sessions.forEach((session, sessionIndex) => {
    const ageDays = Math.max(0, (now - session.endedAt) / DAY_MS);
    const recencyWeight = 2 ** (-ageDays / halfLifeDays);
    const sessionWeight = recencyWeight * contextMatchScore(session.context, currentContext);

    session.tracks.forEach(track => {
      const song = songByKey.get(track.songKey);
      if (!song) return;
      const vector = getSongVector(song);
      const positiveWeight = track.status === 'skipped' ? 0 : Math.min(1.6, track.positiveWeight);
      const negativeWeight = Math.min(1.4, track.negativeWeight);
      if (positiveWeight > 0) {
        addWeightedVector(positiveAccumulator, vector, positiveWeight * sessionWeight);
        positiveSignalCount += 1;
        lastPlayedAtByKey.set(track.songKey, Math.max(lastPlayedAtByKey.get(track.songKey) || 0, track.lastEventAt));
      }
      if (negativeWeight > 0) {
        addWeightedVector(negativeAccumulator, vector, negativeWeight * sessionWeight);
        negativeSignalCount += 1;
      }

      if (sessionIndex === sessions.length - 1 && track.status !== 'skipped') {
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
      const vector = getSongVector(song);
      const plays = Math.max(finiteNumber(song.playCount), playCountFor(playCountByKey, key));
      const tasteAffinity = profile?.vector ? cosineSimilarity(profile.vector, vector) : 0;
      const sequenceAffinity = profile?.recentVector ? cosineSimilarity(profile.recentVector, vector) : 0;
      const skipAffinity = profile?.negativeVector ? cosineSimilarity(profile.negativeVector, vector) : 0;
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
