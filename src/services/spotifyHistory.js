import { getSongKey, normalizeText, tokenSet } from '../songIdentity.js';

export const SPOTIFY_SESSION_GAP_MS = 30 * 60 * 1000;

const SPOTIFY_VARIANT_WORDS = new Set([
  'acoustic',
  'cover',
  'instrumental',
  'karaoke',
  'live',
  'lofi',
  'lo-fi',
  'mashup',
  'mix',
  'nightcore',
  'remix',
  'reverb',
  'slowed',
  'sped',
  'unplugged',
]);

function stripTrackDecorations(trackName = '') {
  return String(trackName || '')
    .replace(/\((?:from|feat\.?|ft\.?|with)\b[^)]*\)/gi, ' ')
    .replace(/\[(?:from|feat\.?|ft\.?|with)\b[^\]]*\]/gi, ' ')
    .replace(/\s+-\s+from\s+["“]?.*$/gi, ' ')
    .replace(/\s+(?:feat\.?|ft\.?)\s+[^([\n-]+$/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function variantSignature(text = '') {
  const words = [...tokenSet(text)].filter(token => SPOTIFY_VARIANT_WORDS.has(token));
  words.sort();
  return words.join('|');
}

function shareArtistToken(spotifyArtist, candidateArtist) {
  const left = tokenSet(spotifyArtist);
  const right = tokenSet(candidateArtist);
  if (!left.size || !right.size) return { overlap: 0, jaccard: 0 };
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  const union = left.size + right.size - overlap;
  return { overlap, jaccard: union > 0 ? overlap / union : 0 };
}

function buildIndexedSong(song) {
  const track = String(song?.track || '').trim();
  const artist = String(song?.artist || '').trim();
  const canonicalKey = getSongKey(artist, track);
  const songKey = song?.songKey || canonicalKey;
  if (!songKey || !track) return null;
  const strippedTrack = normalizeText(stripTrackDecorations(track));
  return {
    song,
    songKey,
    canonicalKey,
    track,
    artist,
    strippedTrack,
    variants: variantSignature(track),
    albumNorm: normalizeText(song?.album || ''),
  };
}

/**
 * Indexes library songs for fast exact and variant-safe Spotify track lookup.
 */
export function buildSpotifyLibraryIndex(librarySongs = []) {
  const byExactKey = new Map();
  const byStrippedTrack = new Map();
  const byVideoId = new Map();
  for (const rawSong of librarySongs || []) {
    const entry = buildIndexedSong(rawSong);
    if (!entry) continue;
    if (!byExactKey.has(entry.songKey)) byExactKey.set(entry.songKey, entry);
    if (!byExactKey.has(entry.canonicalKey)) byExactKey.set(entry.canonicalKey, entry);
    const vid = String(rawSong?.sourceVideoId || '').trim();
    if (vid && !byVideoId.has(vid)) byVideoId.set(vid, entry);
    if (!entry.strippedTrack) continue;
    const bucket = byStrippedTrack.get(entry.strippedTrack) || [];
    bucket.push(entry);
    byStrippedTrack.set(entry.strippedTrack, bucket);
  }
  return { byExactKey, byStrippedTrack, byVideoId };
}

/**
 * Matches external stream metadata (track, artist, album, optional YouTube video ID) against a library index.
 */
export function matchTrackMetadata({
  trackName = '',
  artistName = '',
  albumName = '',
  videoId = '',
} = {}, index) {
  if (!index) return null;
  const cleanVid = String(videoId || '').trim();
  if (cleanVid) {
    const byVid = index.byVideoId?.get(cleanVid);
    if (byVid) {
      return { song: byVid.song, songKey: byVid.songKey, matchTier: 'videoId' };
    }
  }

  const cleanTrack = String(trackName || '').trim();
  const cleanArtist = String(artistName || '').trim();
  if (!cleanTrack) return null;

  const exactKey = getSongKey(cleanArtist || 'unknown artist', cleanTrack);
  const exact = index.byExactKey.get(exactKey);
  if (exact) {
    return { song: exact.song, songKey: exact.songKey, matchTier: 'exactKey' };
  }

  const strippedTrack = normalizeText(stripTrackDecorations(cleanTrack));
  if (!strippedTrack) return null;
  const candidates = index.byStrippedTrack.get(strippedTrack);
  if (!candidates?.length) return null;

  const variants = variantSignature(cleanTrack);
  const albumNorm = normalizeText(albumName || '');
  const hasArtist = Boolean(cleanArtist && normalizeText(cleanArtist) !== 'unknown artist');

  let best = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    if (candidate.variants !== variants) continue;
    const { overlap, jaccard } = shareArtistToken(cleanArtist, candidate.artist);
    if (hasArtist && overlap === 0) continue;
    if (!hasArtist && candidates.length > 1) continue;

    const albumBonus = albumNorm && candidate.albumNorm && (
      candidate.albumNorm === albumNorm
      || candidate.albumNorm.includes(albumNorm)
      || albumNorm.includes(candidate.albumNorm)
    ) ? 0.25 : 0;
    const score = jaccard + overlap * 0.1 + albumBonus;
    if (score > bestScore || (score === bestScore && candidate.songKey < (best?.songKey || ''))) {
      best = candidate;
      bestScore = score;
    }
  }

  if (!best) return null;
  return { song: best.song, songKey: best.songKey, matchTier: 'artistTokenTrack' };
}

/**
 * Matches one Spotify Extended Streaming History record against a prebuilt library index.
 */
export function matchSpotifyRecord(record, index) {
  return matchTrackMetadata({
    trackName: record?.master_metadata_track_name || '',
    artistName: record?.master_metadata_album_artist_name || '',
    albumName: record?.master_metadata_album_album_name || '',
  }, index);
}

/**
 * Classifies a Spotify streaming record into playback outcome signals.
 */
export function classifySpotifyOutcome(record, durationSeconds = null) {
  const msPlayed = Math.max(0, Number(record?.ms_played || 0) || 0);
  const positionSeconds = msPlayed / 1000;
  const duration = Number(durationSeconds);
  const hasDuration = Number.isFinite(duration) && duration > 0;
  const skippedFlag = Boolean(record?.skipped) || record?.reason_end === 'fwdbtn';
  const completionRatio = hasDuration ? positionSeconds / duration : null;

  if (
    record?.reason_end === 'trackdone'
    || (!skippedFlag && (positionSeconds >= 90 || (completionRatio !== null && completionRatio >= 0.75)))
  ) {
    return { outcome: 'complete', positionSeconds, msPlayed };
  }

  if (skippedFlag && positionSeconds < 60) {
    return { outcome: 'skip', positionSeconds, msPlayed };
  }

  if (positionSeconds >= 30) {
    return { outcome: 'partial', positionSeconds, msPlayed };
  }

  return { outcome: 'ignore', positionSeconds, msPlayed };
}

/**
 * Converts matched Spotify Extended Streaming History records into sorted playbackEvents.
 */
export function convertSpotifyStreamsToPlaybackEvents(records = [], librarySongs = [], {
  sessionGapMs = SPOTIFY_SESSION_GAP_MS,
  includePartialStarts = true,
} = {}) {
  const index = buildSpotifyLibraryIndex(librarySongs);
  const parsed = [];

  for (const record of records || []) {
    const startMs = Date.parse(record?.ts || '');
    if (!Number.isFinite(startMs)) continue;
    const match = matchSpotifyRecord(record, index);
    if (!match) continue;
    const trackDuration = match.song?.durationSeconds ?? match.song?.sourceDuration;
    const classified = classifySpotifyOutcome(record, trackDuration);
    if (classified.outcome === 'ignore') continue;
    if (classified.outcome === 'partial' && !includePartialStarts) continue;
    parsed.push({ record, startMs, match, classified, trackDuration });
  }

  parsed.sort((a, b) => a.startMs - b.startMs);

  const events = [];
  let sessionIndex = 0;
  let positionInQueue = 0;
  let lastEndMs = null;

  const stats = {
    totalRecords: Array.isArray(records) ? records.length : 0,
    matchedStreams: 0,
    exactMatches: 0,
    artistTokenMatches: 0,
    uniqueMatchedSongs: new Set(),
    completes: 0,
    skips: 0,
    partials: 0,
    sessions: 0,
  };

  for (const item of parsed) {
    const { startMs, match, classified, record, trackDuration } = item;
    if (lastEndMs === null || startMs - lastEndMs > sessionGapMs) {
      sessionIndex += 1;
      positionInQueue = 0;
      stats.sessions = sessionIndex;
    }
    const queueId = `spotify-s${sessionIndex}`;
    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(startMs + classified.msPlayed).toISOString();
    const durationSeconds = Number(trackDuration);

    stats.matchedStreams += 1;
    stats.uniqueMatchedSongs.add(match.songKey);
    if (match.matchTier === 'exactKey') stats.exactMatches += 1;
    else stats.artistTokenMatches += 1;

    const base = {
      songKey: match.songKey,
      queueId,
      positionInQueue,
      sourceType: 'spotify-history',
      spotifyReasonStart: record?.reason_start || null,
      spotifyReasonEnd: record?.reason_end || null,
      ...(Number.isFinite(durationSeconds) && durationSeconds > 0 ? { durationSeconds } : {}),
    };

    events.push({
      ...base,
      eventType: 'playback-start',
      createdAt: startIso,
    });

    if (classified.outcome === 'complete') {
      stats.completes += 1;
      events.push({
        ...base,
        eventType: 'playback-complete',
        positionSeconds: classified.positionSeconds,
        createdAt: endIso,
      });
    } else if (classified.outcome === 'skip') {
      stats.skips += 1;
      events.push({
        ...base,
        eventType: 'user-skip',
        positionSeconds: classified.positionSeconds,
        createdAt: endIso,
      });
    } else {
      stats.partials += 1;
    }

    positionInQueue += 1;
    lastEndMs = startMs + classified.msPlayed;
  }

  return {
    events,
    stats: {
      ...stats,
      uniqueMatchedSongs: stats.uniqueMatchedSongs.size,
    },
  };
}
