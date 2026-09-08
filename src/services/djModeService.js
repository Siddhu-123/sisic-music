import { getSongKey } from '../songIdentity.js';
import {
  buildContextualTasteProfile,
  getPlaybackContext,
  rankContextualSongs,
} from './contextualRecommendationService.js';

export const DJ_METADATA_VERSION = 1;
export const DJ_SKIP_HORIZON_SECONDS = 18;
export const DJ_SKIP_THRESHOLD = 0.62;
export const DJ_MAX_TEMPO_DELTA = 8;
export const DJ_NEAR_TIE_DELTA = 0.055;
export const DJ_RANDOMIZATION_BUDGET = 0.55;

const START_EVENTS = new Set(['playback-start', 'playback-resume']);
const SKIP_EVENT = 'user-skip';
const PITCH_CLASSES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const ENHARMONIC = { DB: 'C#', EB: 'D#', GB: 'F#', AB: 'G#', BB: 'A#', CB: 'B', FB: 'E', 'E#': 'F', 'B#': 'C' };

const numberOrNull = value => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const logistic = value => 1 / (1 + Math.exp(-value));
const keyOf = song => song?.songKey || getSongKey(song || {});
const artistOf = song => String(song?.artist || '').trim().toLocaleLowerCase();
const genresOf = song => String(song?.genre || '').toLocaleLowerCase().split(/[,/|;&]+/).map(value => value.trim()).filter(Boolean);

export function normaliseTempo(value) {
  const bpm = numberOrNull(value);
  return bpm && bpm >= 40 && bpm <= 240 ? bpm : null;
}

export function normaliseMusicalKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const camelot = raw.match(/^([1-9]|1[0-2])\s*([AB])$/i);
  if (camelot) {
    const minor = camelot[2].toUpperCase() === 'A';
    const roots = minor ? ['G#', 'D#', 'A#', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'] : ['B', 'F#', 'C#', 'G#', 'D#', 'A#', 'F', 'C', 'G', 'D', 'A', 'E'];
    return normaliseMusicalKey(`${roots[Number(camelot[1]) - 1]} ${minor ? 'minor' : 'major'}`);
  }
  const match = raw.match(/^([A-G])([#b♯♭]?)(?:\s*)?(maj(?:or)?|min(?:or)?|m)?$/i);
  if (!match) return null;
  const root = `${match[1].toUpperCase()}${match[2] === '♯' ? '#' : match[2] === '♭' ? 'b' : match[2] || ''}`;
  const canonicalRoot = ENHARMONIC[root.toUpperCase()] || root;
  const mode = /^m(in(or)?)?$/i.test(match[3] || '') ? 'minor' : 'major';
  if (!PITCH_CLASSES.includes(canonicalRoot)) return null;
  return { notation: `${canonicalRoot} ${mode}`, root: PITCH_CLASSES.indexOf(canonicalRoot), mode };
}

function harmonicCompatibility(sourceKey, candidateKey) {
  const source = normaliseMusicalKey(sourceKey);
  const candidate = normaliseMusicalKey(candidateKey);
  if (!source || !candidate) return { available: false, score: 0, compatible: true };
  const distance = Math.min((source.root - candidate.root + 12) % 12, (candidate.root - source.root + 12) % 12);
  const same = distance === 0 && source.mode === candidate.mode;
  const relative = (source.mode !== candidate.mode && ((source.mode === 'major' && (candidate.root - source.root + 12) % 12 === 9) || (source.mode === 'minor' && (candidate.root - source.root + 12) % 12 === 3)));
  const fifth = distance === 5 || distance === 7;
  return { available: true, score: same ? 1 : relative ? .82 : fifth && source.mode === candidate.mode ? .7 : .18, compatible: same || relative || (fifth && source.mode === candidate.mode) };
}

// One observation per play, not per pause/resume. Incomplete and DJ-interrupted
// listens are censored: they are only evidence for windows actually heard.
export function buildSkipObservations(events = []) {
  const seen = new Set();
  const ordered = events.filter(event => {
    if (!event?.songKey) return false;
    const id = event.eventId || event.id;
    if (id && seen.has(id)) return false;
    if (id) seen.add(id);
    return true;
  }).sort((a, b) => (Date.parse(a.createdAt) || Number(a.createdAt) || 0) - (Date.parse(b.createdAt) || Number(b.createdAt) || 0));
  const active = new Map();
  const observations = [];
  for (const event of ordered) {
    const key = `${event.sessionId || ''}::${event.songKey}`;
    const position = Math.max(0, Number(event.positionSeconds ?? event.secondsPlayed) || 0);
    let observation = active.get(key);
    if (event.eventType === 'playback-start' || (!observation && START_EVENTS.has(event.eventType))) {
      observation = { ...event, entryPosition: position, position, skipped: false, complete: false, sought: false };
      observations.push(observation);
      active.set(key, observation);
    }
    if (!observation) continue; // Legacy skips without a start cannot supply a denominator.
    observation.position = Math.max(observation.position, position);
    if (event.eventType === 'playback-seek') observation.sought = true;
    if (event.eventType === SKIP_EVENT || event.eventType === 'playback-complete') {
      observation.skipped = event.eventType === SKIP_EVENT;
      observation.complete = !observation.skipped;
      observation.skipPosition = position;
      active.delete(key);
    } else if (['dj-transition', 'playback-stop', 'playback-stream-error'].includes(event.eventType)) active.delete(key);
  }
  return observations.filter(item => !item.sought);
}

function skipStatistics(observations, predicate, { positionSeconds, horizonSeconds }) {
  const starts = observations.filter(predicate);
  const terminal = starts.filter(item => item.skipped || item.complete);
  const skips = terminal.filter(item => item.skipped);
  const eligible = starts.filter(item => item.entryPosition <= positionSeconds && item.position >= positionSeconds
    && (item.position >= positionSeconds + horizonSeconds || item.skipped || item.complete));
  const inWindow = eligible.filter(item => item.skipped && item.skipPosition <= positionSeconds + horizonSeconds);
  return {
    starts: starts.length,
    skips: skips.length,
    windowSamples: eligible.length,
    windowSkips: inWindow.length,
    skipPositions: inWindow.map(item => item.skipPosition),
    skipRate: (skips.length + 1) / (terminal.length + 4),
    windowRate: (inWindow.length + .5) / (eligible.length + 2),
  };
}

export function predictSkipProbability({
  song,
  songs = [],
  playbackEvents = [],
  observations = buildSkipObservations(playbackEvents),
  positionSeconds = 0,
  durationSeconds = 0,
  horizonSeconds = DJ_SKIP_HORIZON_SECONDS,
  now = Date.now(),
  currentContext = getPlaybackContext(now, typeof navigator === 'undefined' ? '' : navigator.userAgent),
} = {}) {
  const songKey = keyOf(song);
  const artist = artistOf(song);
  const genres = new Set(genresOf(song));
  const events = observations;
  const songByKey = new Map((Array.isArray(songs) ? songs : []).map(item => [keyOf(item), item]));
  const track = skipStatistics(events, event => event.songKey === songKey, { positionSeconds, horizonSeconds });
  const artistStats = skipStatistics(events, event => artist && artistOf(songByKey.get(event.songKey) || event) === artist, { positionSeconds, horizonSeconds });
  const genreStats = skipStatistics(events, event => {
    const eventGenres = genresOf(songByKey.get(event.songKey));
    return genres.size && eventGenres.some(genre => genres.has(genre));
  }, { positionSeconds, horizonSeconds });
  const contextStats = skipStatistics(events, event => {
    const context = event.context || {};
    return context.hour === currentContext.hour && context.deviceType === currentContext.deviceType;
  }, { positionSeconds, horizonSeconds });
  const elapsedRatio = durationSeconds > 0 ? clamp(positionSeconds / durationSeconds) : 0;
  const samples = Math.max(track.windowSamples, artistStats.windowSamples, genreStats.windowSamples, contextStats.windowSamples);
  const logOdds = -2.35
    + (track.skipRate * 2.05)
    + (track.windowRate * 1.55)
    + (artistStats.skipRate * .48)
    + (genreStats.skipRate * .26)
    + (contextStats.windowRate * .62)
    + (elapsedRatio < .12 ? .18 : 0)
    + (samples < 4 ? -.32 : 0);
  const probability = clamp(logistic(logOdds), .02, samples < 4 ? .49 : .97);
  const positions = [...(track.skipPositions.length ? track.skipPositions : artistStats.skipPositions)].sort((a, b) => a - b);
  const predictedSkipAtSeconds = positions.length ? positions[Math.floor(positions.length / 2)] : positionSeconds + horizonSeconds;
  const reasons = [
    track.starts ? `track skip rate ${Math.round(track.skipRate * 100)}% (${track.skips}/${track.starts})` : 'no track history',
    artistStats.starts ? `artist history ${Math.round(artistStats.skipRate * 100)}%` : null,
    contextStats.starts ? `${currentContext.timeBucket} ${currentContext.deviceType} window ${Math.round(contextStats.windowRate * 100)}%` : null,
  ].filter(Boolean);
  return { probability, horizonSeconds, positionSeconds, predictedSkipAtSeconds, samples, reasons, features: { track, artist: artistStats, genre: genreStats, context: contextStats } };
}

function energyAt(song, position) {
  const windows = song?.djAudioWindows;
  if (Number.isFinite(position) && Array.isArray(windows)) {
    const window = windows.find(item => position >= item.startSeconds && position < item.startSeconds + 5);
    if (window) return numberOrNull(window.energy);
  }
  return numberOrNull(song?.energy);
}

export function transitionCacheKey(source, candidate, positionSeconds) {
  const fingerprint = [source?.bpm, source?.musicalKey, source?.keyConfidence, energyAt(source, positionSeconds), source?.loudnessLufs, source?.djMetadataVersion, candidate?.bpm, candidate?.musicalKey, candidate?.keyConfidence, energyAt(candidate, 0), candidate?.loudnessLufs, candidate?.djMetadataVersion].map(value => value ?? '').join('|');
  return `${keyOf(source)}::${keyOf(candidate)}::${fingerprint}`;
}

export function scoreDjTransition(source = {}, candidate = {}, positionSeconds) {
  const sourceTempo = normaliseTempo(source.bpm);
  const candidateTempo = normaliseTempo(candidate.bpm);
  const tempoDelta = sourceTempo && candidateTempo ? Math.abs(sourceTempo - candidateTempo) : null;
  const tempoScore = tempoDelta == null ? 0 : clamp(1 - tempoDelta / DJ_MAX_TEMPO_DELTA);
  const key = harmonicCompatibility(source.keyConfidence != null && source.keyConfidence < .1 ? null : source.musicalKey,
    candidate.keyConfidence != null && candidate.keyConfidence < .1 ? null : candidate.musicalKey);
  const sourceEnergy = energyAt(source, positionSeconds);
  const candidateEnergy = energyAt(candidate, 0);
  const sourceLoudness = numberOrNull(source.loudnessLufs);
  const candidateLoudness = numberOrNull(candidate.loudnessLufs);
  const energyScore = sourceEnergy == null || candidateEnergy == null ? null : clamp(1 - Math.abs(sourceEnergy - candidateEnergy) / .35);
  const loudnessScore = sourceLoudness == null || candidateLoudness == null ? null : clamp(1 - Math.abs(sourceLoudness - candidateLoudness) / 8);
  const available = [tempoDelta != null, key.available, energyScore != null, loudnessScore != null].filter(Boolean).length;
  const weighted = [
    [tempoDelta != null, tempoScore, .52],
    [key.available, key.score, .28],
    [energyScore != null, energyScore, .12],
    [loudnessScore != null, loudnessScore, .08],
  ].filter(([present]) => present);
  const score = weighted.length ? weighted.reduce((sum, [, value, weight]) => sum + value * weight, 0) / weighted.reduce((sum, [, , weight]) => sum + weight, 0) : 0;
  const acceptable = tempoDelta != null && tempoDelta <= DJ_MAX_TEMPO_DELTA && (!key.available || key.compatible);
  return { cacheKey: transitionCacheKey(source, candidate, positionSeconds), sourceSongKey: keyOf(source), candidateSongKey: keyOf(candidate), score, acceptable, available, tempoDelta, tempoScore, keyScore: key.available ? key.score : null, harmonicCompatible: key.available ? key.compatible : null, energyScore, loudnessScore, metadataVersion: DJ_METADATA_VERSION };
}

export function rankDjCandidates({ source, songs = [], playbackEvents = [], likedSongKeys = [], transitionScores = new Map(), history = {}, positionSeconds, now = Date.now(), currentContext = getPlaybackContext(now, typeof navigator === 'undefined' ? '' : navigator.userAgent) } = {}) {
  const sourceKey = keyOf(source);
  const profile = buildContextualTasteProfile(songs, playbackEvents, { now, currentContext });
  const contextual = rankContextualSongs(songs.filter(song => song.driveFileId), {
    profile,
    likedSongKeys,
    excludeSongKeys: [sourceKey, ...(history.candidateKeys || [])],
    now,
    limit: 60,
  });
  return contextual.map((song, index) => {
    const transition = transitionScores.get(transitionCacheKey(source, song, positionSeconds)) || scoreDjTransition(source, song, positionSeconds);
    return { song, contextualRank: index, contextualScore: song.tasteScore ?? song.recommendationScore ?? 0, transition, score: (song.tasteScore ?? song.recommendationScore ?? 0) + transition.score * .34 };
  }).sort((a, b) => b.score - a.score || a.contextualRank - b.contextualRank);
}

export function chooseDjCandidate(ranked = [], { history = {}, random = Math.random } = {}) {
  if (!ranked.length) return null;
  const compatible = ranked.filter(item => item.transition.acceptable);
  // The fallback must be the recommender's first result, before DJ re-ranking.
  const pool = compatible.length ? compatible : [[...ranked].sort((a, b) => a.contextualRank - b.contextualRank)[0]];
  const fallback = compatible.length === 0;
  const topScore = pool[0].score;
  const recentKeys = new Set(history.candidateKeys || []);
  const nearTies = pool.filter(item => item.score >= topScore - DJ_NEAR_TIE_DELTA).slice(0, 3);
  const novel = nearTies.filter(item => !recentKeys.has(keyOf(item.song)));
  const candidates = novel.length ? novel : nearTies;
  const selected = candidates.length > 1 && random() < DJ_RANDOMIZATION_BUDGET
    ? candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))]
    : candidates[0];
  return { ...selected, fallback, poolSize: candidates.length, randomizationBudget: DJ_RANDOMIZATION_BUDGET };
}

export function chooseDjTransitionTime(prediction, duration, fadeSeconds, history = {}) {
  const earliest = prediction.positionSeconds + 1;
  const latest = Math.min(duration - fadeSeconds, prediction.predictedSkipAtSeconds - fadeSeconds);
  if (latest < earliest) return null;
  const recent = new Set(history.timingBuckets || []);
  // Vary earlier, never delay beyond the predicted skip to create variation.
  for (let position = latest; position >= earliest; position -= 5) {
    if (!recent.has(Math.floor(position / 5) * 5)) return position;
  }
  return earliest;
}

export function rememberDjTransition(history = {}, candidateSongKey, transitionAtSeconds) {
  const timingBucket = Math.max(0, Math.floor(Number(transitionAtSeconds || 0) / 5) * 5);
  return {
    candidateKeys: [candidateSongKey, ...(history.candidateKeys || []).filter(key => key !== candidateSongKey)].slice(0, 6),
    timingBuckets: [timingBucket, ...(history.timingBuckets || []).filter(bucket => bucket !== timingBucket)].slice(0, 4),
  };
}
