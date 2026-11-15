import { buildSpotifyLibraryIndex, matchTrackMetadata, SPOTIFY_SESSION_GAP_MS } from './spotifyHistory.js';

const TZ_OFFSETS = Object.freeze({
  ACDT: '+10:30',
  ACST: '+09:30',
  AEDT: '+11:00',
  AEST: '+10:00',
  AWST: '+08:00',
  UTC: '+00:00',
  GMT: '+00:00',
  IST: '+05:30',
  PST: '-08:00',
  PDT: '-07:00',
  MST: '-07:00',
  MDT: '-06:00',
  CST: '-06:00',
  CDT: '-05:00',
  EST: '-05:00',
  EDT: '-04:00',
});

const NON_MUSIC_PLAYLIST_TITLES = new Set([
  'ai',
  'blender',
  'food',
  'robot',
  'useful',
  'watch later',
]);

function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

/**
 * Parses Google Takeout timestamp strings (e.g. "Nov 15, 2026, 2:41:46 AM ACDT") into epoch ms.
 */
export function parseTakeoutTimestampMs(raw = '') {
  const cleaned = String(raw || '')
    .replace(/[\u202f\u00a0]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  const tzMatch = cleaned.match(/\s([A-Z]{2,5})$/);
  let normalized = cleaned;
  if (tzMatch && TZ_OFFSETS[tzMatch[1]]) {
    normalized = `${cleaned.slice(0, tzMatch.index)} GMT${TZ_OFFSETS[tzMatch[1]]}`;
  }
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

function cleanChannelArtist(channel = '') {
  return String(channel || '').replace(/\s*-\s*Topic$/i, '').trim();
}

function extractVideoId(url = '') {
  const match = String(url || '').match(/[?&]v=([A-Za-z0-9_-]+)/);
  return match ? match[1] : '';
}

/**
 * Separates YouTube Music entries from general YouTube video entries in Takeout watch-history.html.
 */
export function parseTakeoutWatchHistoryHtml(html = '') {
  const blocks = String(html || '').split('<div class="outer-cell ').slice(1);
  const youtubeMusicRecords = [];
  let youtubeVideoCount = 0;

  for (const block of blocks) {
    const headerMatch = block.match(/class="mdl-typography--title">([^<]+)</);
    const product = headerMatch ? decodeHtmlEntities(headerMatch[1]).trim() : '';
    if (product !== 'YouTube Music') {
      if (product === 'YouTube') youtubeVideoCount += 1;
      continue;
    }

    const contentMatch = block.match(/class="content-cell[^"]*mdl-typography--body-1">([\s\S]*?)<\/div>/);
    if (!contentMatch) continue;
    const content = contentMatch[1];

    const links = [...content.matchAll(/<a\s+href="([^"]+)">([^<]*)<\/a>/g)];
    if (!links.length) continue;

    const videoUrl = links[0][1];
    const title = decodeHtmlEntities(links[0][2]).trim();
    const channelLink = links.find(([, href]) => href.includes('/channel/'));
    const channel = channelLink ? decodeHtmlEntities(channelLink[2]).trim() : '';
    const artist = cleanChannelArtist(channel);

    const lines = content
      .split(/<br\s*\/?>/i)
      .map(part => decodeHtmlEntities(part.replace(/<[^>]+>/g, '')).trim())
      .filter(Boolean);
    const tsRaw = lines[lines.length - 1] || '';
    const startMs = parseTakeoutTimestampMs(tsRaw);
    if (!title || startMs === null) continue;

    youtubeMusicRecords.push({
      videoId: extractVideoId(videoUrl),
      url: videoUrl,
      title,
      channel,
      artist,
      tsRaw,
      startMs,
    });
  }

  return {
    youtubeMusicRecords,
    youtubeVideoCount,
    totalBlocks: blocks.length,
  };
}

function parseCsvRows(csvText = '') {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  const text = String(csvText || '').replace(/^\uFEFF/, '');

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.some(cell => cell.length > 0)) rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some(cell => cell.length > 0)) rows.push(row);
  if (rows.length < 2) return [];

  const header = rows[0].map(h => h.trim());
  return rows.slice(1).map(values => {
    const out = {};
    for (let i = 0; i < header.length; i++) {
      out[header[i]] = (values[i] ?? '').trim();
    }
    return out;
  });
}

/**
 * Extracts liked/saved songKeys from Takeout YouTube Music CSVs ("music library songs.csv" & music playlists).
 */
export function extractYoutubeMusicLikes({
  librarySongs = [],
  musicLibraryCsv = '',
  playlistsCsv = '',
  playlistVideoCsvs = {},
} = {}) {
  const index = buildSpotifyLibraryIndex(librarySongs);
  const likedKeys = new Set();
  const matchedLibraryRows = [];
  const musicPlaylists = [];

  for (const row of parseCsvRows(musicLibraryCsv)) {
    const artists = [];
    for (let i = 1; i <= 9; i++) {
      const a = row[`Artist Name ${i}`];
      if (a) artists.push(a);
    }
    const match = matchTrackMetadata({
      trackName: row['Song Title'] || '',
      artistName: artists.join(', '),
      albumName: row['Album Title'] || '',
      videoId: row['Video ID'] || '',
    }, index);
    if (match) {
      likedKeys.add(match.songKey);
      matchedLibraryRows.push(match.songKey);
    }
  }

  for (const pl of parseCsvRows(playlistsCsv)) {
    const title = pl['Playlist Title (Original)'] || '';
    const desc = pl['Playlist Description (Original)'] || '';
    if (!title || NON_MUSIC_PLAYLIST_TITLES.has(title.toLowerCase())) continue;
    const isTuneMyMusic = desc.toLowerCase().includes('tunemymusic');
    const csvKey = Object.keys(playlistVideoCsvs).find(k => k.toLowerCase() === `${title.toLowerCase()}-videos.csv` || k.toLowerCase() === title.toLowerCase());
    const entries = csvKey ? parseCsvRows(playlistVideoCsvs[csvKey]) : [];
    if (!isTuneMyMusic && !entries.length) continue;

    let hits = 0;
    for (const item of entries) {
      const match = matchTrackMetadata({ videoId: item['Video ID'] || '' }, index);
      if (match) {
        likedKeys.add(match.songKey);
        hits += 1;
      }
    }
    musicPlaylists.push({ title, tracks: entries.length, matchedLibraryTracks: hits });
  }

  return {
    likedSongKeys: [...likedKeys],
    matchedLibrarySongs: matchedLibraryRows.length,
    musicPlaylists,
  };
}

function matchYtmWithTitleFallback(record, index) {
  const direct = matchTrackMetadata({
    trackName: record.title,
    artistName: record.artist,
    videoId: record.videoId,
  }, index);
  if (direct) return direct;

  // Handle YouTube Music uploads formatted as "Artist - Title" or "Title - Artist"
  const parts = String(record.title || '').split(/\s+-\s+|\s+\|\s+/).map(p => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const first = matchTrackMetadata({ trackName: parts[1], artistName: parts[0] }, index);
    if (first) return first;
    const reversed = matchTrackMetadata({ trackName: parts[0], artistName: parts[1] }, index);
    if (reversed) return reversed;
  }
  return null;
}

/**
 * Converts sorted YouTube Music history records into session-grouped playbackEvents,
 * inferring skips vs completions from inter-track start deltas before filtering unmatched tracks.
 */
export function convertYoutubeMusicToPlaybackEvents(records = [], librarySongs = [], {
  sessionGapMs = SPOTIFY_SESSION_GAP_MS,
  includePartialStarts = true,
} = {}) {
  const index = buildSpotifyLibraryIndex(librarySongs);
  const chronological = [...(records || [])]
    .filter(r => r && Number.isFinite(r.startMs))
    .sort((a, b) => a.startMs - b.startMs);

  const events = [];
  let sessionIndex = 0;
  let positionInQueue = 0;
  let lastMatchedSessionEndMs = null;

  const stats = {
    ytmStreams: chronological.length,
    matchedStreams: 0,
    videoIdMatches: 0,
    exactMatches: 0,
    artistTokenMatches: 0,
    uniqueMatchedSongs: new Set(),
    completes: 0,
    skips: 0,
    partials: 0,
    sessions: 0,
  };

  for (let i = 0; i < chronological.length; i++) {
    const item = chronological[i];
    const nextItem = chronological[i + 1] || null;
    const rawGapMs = nextItem ? nextItem.startMs - item.startMs : null;
    const sameRawSession = rawGapMs !== null && rawGapMs >= 0 && rawGapMs <= sessionGapMs;

    const match = matchYtmWithTitleFallback(item, index);
    if (!match) continue;

    const rawDuration = Number(match.song?.durationSeconds ?? match.song?.sourceDuration);
    const hasDuration = Number.isFinite(rawDuration) && rawDuration > 0;
    const gapSec = sameRawSession ? rawGapMs / 1000 : null;

    let outcome = 'partial';
    let positionSeconds = 0;
    if (gapSec !== null && gapSec < 60) {
      outcome = 'skip';
      positionSeconds = gapSec;
    } else if (gapSec !== null && (gapSec >= 90 || (hasDuration && gapSec >= rawDuration * 0.7))) {
      outcome = 'complete';
      positionSeconds = hasDuration ? Math.min(rawDuration, gapSec) : gapSec;
    }

    if (outcome === 'partial' && !includePartialStarts) continue;

    if (lastMatchedSessionEndMs === null || item.startMs - lastMatchedSessionEndMs > sessionGapMs) {
      sessionIndex += 1;
      positionInQueue = 0;
      stats.sessions = sessionIndex;
    }

    const queueId = `ytm-s${sessionIndex}`;
    const startIso = new Date(item.startMs).toISOString();
    const endOffsetMs = outcome === 'partial'
      ? (gapSec !== null ? rawGapMs : 0)
      : Math.round(positionSeconds * 1000);
    const endIso = new Date(item.startMs + Math.max(1000, endOffsetMs)).toISOString();

    stats.matchedStreams += 1;
    stats.uniqueMatchedSongs.add(match.songKey);
    if (match.matchTier === 'videoId') stats.videoIdMatches += 1;
    else if (match.matchTier === 'exactKey') stats.exactMatches += 1;
    else stats.artistTokenMatches += 1;

    const base = {
      songKey: match.songKey,
      queueId,
      positionInQueue,
      sourceType: 'youtube-music-takeout',
      videoId: item.videoId || null,
      ...(hasDuration ? { durationSeconds: rawDuration } : {}),
    };

    events.push({
      ...base,
      eventType: 'playback-start',
      createdAt: startIso,
    });

    if (outcome === 'complete') {
      stats.completes += 1;
      events.push({
        ...base,
        eventType: 'playback-complete',
        positionSeconds,
        createdAt: endIso,
      });
    } else if (outcome === 'skip') {
      stats.skips += 1;
      events.push({
        ...base,
        eventType: 'user-skip',
        positionSeconds,
        createdAt: endIso,
      });
    } else {
      stats.partials += 1;
    }

    positionInQueue += 1;
    lastMatchedSessionEndMs = item.startMs + Math.max(0, endOffsetMs);
  }

  return {
    events,
    stats: {
      ...stats,
      uniqueMatchedSongs: stats.uniqueMatchedSongs.size,
    },
  };
}
