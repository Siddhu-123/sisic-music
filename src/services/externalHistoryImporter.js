import { convertSpotifyStreamsToPlaybackEvents } from './spotifyHistory.js';
import {
  convertYoutubeMusicToPlaybackEvents,
  extractYoutubeMusicLikes,
  parseTakeoutWatchHistoryHtml,
} from './youtubeMusicHistory.js';

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

async function decompressDeflateRaw(bytes) {
  if (typeof DecompressionStream === 'function') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  }
  const zlib = await import('node:zlib');
  return new Uint8Array(zlib.inflateRawSync(bytes));
}

function decodeUtf8(bytes) {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/**
 * Reads only matching filenames from a Blob/File ZIP via its Central Directory (safe for 2GB+ Takeout archives).
 */
export async function extractMatchingZipEntries(blob, matcher) {
  if (!blob || typeof blob.slice !== 'function') {
    throw new TypeError('Expected a Blob or File ZIP archive');
  }
  const tailSize = Math.min(blob.size, 65536 + 22);
  const tailOffset = blob.size - tailSize;
  const tailBuf = await blob.slice(tailOffset, blob.size).arrayBuffer();
  const tailView = new DataView(tailBuf);

  let eocdPos = -1;
  for (let i = tailBuf.byteLength - 22; i >= 0; i--) {
    if (tailView.getUint32(i, true) === EOCD_SIG) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos < 0) throw new Error('Invalid ZIP archive: End of Central Directory not found');

  const cdSize = tailView.getUint32(eocdPos + 12, true);
  const cdOffset = tailView.getUint32(eocdPos + 16, true);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new Error('ZIP64 central directory is not supported in browser slice mode');
  }

  const cdBuf = await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer();
  const cdView = new DataView(cdBuf);
  const cdBytes = new Uint8Array(cdBuf);

  const selected = [];
  let cursor = 0;
  while (cursor + 46 <= cdBytes.length) {
    if (cdView.getUint32(cursor, true) !== CD_SIG) break;
    const method = cdView.getUint16(cursor + 10, true);
    const compSize = cdView.getUint32(cursor + 20, true);
    const nameLen = cdView.getUint16(cursor + 28, true);
    const extraLen = cdView.getUint16(cursor + 30, true);
    const commentLen = cdView.getUint16(cursor + 32, true);
    const localHeaderOffset = cdView.getUint32(cursor + 42, true);
    const name = decodeUtf8(cdBytes.subarray(cursor + 46, cursor + 46 + nameLen));
    if (matcher(name)) {
      selected.push({ name, method, compSize, localHeaderOffset });
    }
    cursor += 46 + nameLen + extraLen + commentLen;
  }

  const out = new Map();
  for (const item of selected) {
    const lfhBuf = await blob.slice(item.localHeaderOffset, item.localHeaderOffset + 30).arrayBuffer();
    const lfhView = new DataView(lfhBuf);
    if (lfhView.getUint32(0, true) !== LFH_SIG) continue;
    const lfhNameLen = lfhView.getUint16(26, true);
    const lfhExtraLen = lfhView.getUint16(28, true);
    const dataStart = item.localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
    const payload = new Uint8Array(await blob.slice(dataStart, dataStart + item.compSize).arrayBuffer());
    const rawBytes = item.method === 0
      ? payload
      : item.method === 8
        ? await decompressDeflateRaw(payload)
        : null;
    if (rawBytes) out.set(item.name, decodeUtf8(rawBytes));
  }
  return out;
}

/**
 * Parses an imported Spotify ZIP, Google Takeout YouTube Music ZIP, or merged JSON history pack.
 */
export async function importExternalListeningFile(file, librarySongs = []) {
  const name = String(file?.name || '').toLowerCase();

  if (name.endsWith('.json')) {
    const parsed = JSON.parse(await file.text());
    if (parsed && Array.isArray(parsed.events)) {
      return {
        source: 'json-pack',
        spotifyEvents: parsed.sources?.spotify ? parsed.events.filter(e => e.sourceType === 'spotify-history') : [],
        youtubeMusicEvents: parsed.sources?.youtubeMusic ? parsed.events.filter(e => e.sourceType === 'youtube-music-takeout') : [],
        extraEvents: parsed.events.filter(e => e.sourceType !== 'spotify-history' && e.sourceType !== 'youtube-music-takeout'),
        likedSongKeys: Array.isArray(parsed.likedSongKeys) ? parsed.likedSongKeys : [],
        summary: parsed.sources || { totalEvents: parsed.events.length },
      };
    }
    if (Array.isArray(parsed)) {
      const converted = convertSpotifyStreamsToPlaybackEvents(parsed, librarySongs);
      return {
        source: 'spotify',
        spotifyEvents: converted.events,
        likedSongKeys: [],
        summary: converted.stats,
      };
    }
    throw new Error('Unsupported history JSON format');
  }

  const entries = await extractMatchingZipEntries(file, entry => (
    /Streaming_History_Audio_.*\.json$/i.test(entry)
    || /history\/watch-history\.html$/i.test(entry)
    || /music library songs\.csv$/i.test(entry)
    || /playlists\/playlists\.csv$/i.test(entry)
    || /playlists\/.*-videos\.csv$/i.test(entry)
  ));

  const spotifyJsonKeys = [...entries.keys()].filter(k => /Streaming_History_Audio_.*\.json$/i.test(k));
  if (spotifyJsonKeys.length > 0) {
    const records = [];
    for (const key of spotifyJsonKeys) {
      const arr = JSON.parse(entries.get(key));
      if (Array.isArray(arr)) records.push(...arr);
    }
    const converted = convertSpotifyStreamsToPlaybackEvents(records, librarySongs);
    return {
      source: 'spotify',
      spotifyEvents: converted.events,
      likedSongKeys: [],
      summary: converted.stats,
    };
  }

  const watchKey = [...entries.keys()].find(k => /history\/watch-history\.html$/i.test(k));
  const libCsvKey = [...entries.keys()].find(k => /music library songs\.csv$/i.test(k));
  const plCsvKey = [...entries.keys()].find(k => /playlists\/playlists\.csv$/i.test(k));

  if (!watchKey && !libCsvKey && !plCsvKey) {
    throw new Error('No Spotify streaming JSON or YouTube Music Takeout files found in archive');
  }

  const parsedWatch = parseTakeoutWatchHistoryHtml(watchKey ? entries.get(watchKey) : '');
  const converted = convertYoutubeMusicToPlaybackEvents(parsedWatch.youtubeMusicRecords, librarySongs);
  const plVideoCsvs = {};
  for (const [k, v] of entries.entries()) {
    if (/playlists\/.*-videos\.csv$/i.test(k)) {
      plVideoCsvs[k.split('/').pop()] = v;
    }
  }
  const likes = extractYoutubeMusicLikes({
    librarySongs,
    musicLibraryCsv: libCsvKey ? entries.get(libCsvKey) : '',
    playlistsCsv: plCsvKey ? entries.get(plCsvKey) : '',
    playlistVideoCsvs: plVideoCsvs,
  });

  return {
    source: 'youtube-music',
    youtubeMusicEvents: converted.events,
    likedSongKeys: likes.likedSongKeys,
    summary: {
      filteredOutYouTubeVideos: parsedWatch.youtubeVideoCount,
      ...converted.stats,
      likedSongs: likes.likedSongKeys.length,
    },
  };
}

/**
 * Merges newly imported history slices into any existing persisted external history pack.
 */
export function mergeExternalHistoryPack(existingPack = null, imported = {}) {
  const prev = existingPack || {};
  const bySource = {
    spotify: imported.source === 'spotify'
      ? (imported.spotifyEvents || [])
      : imported.source === 'json-pack'
        ? (imported.spotifyEvents || [])
        : (prev.bySource?.spotify || []),
    youtubeMusic: imported.source === 'youtube-music'
      ? (imported.youtubeMusicEvents || [])
      : imported.source === 'json-pack'
        ? (imported.youtubeMusicEvents || [])
        : (prev.bySource?.youtubeMusic || []),
    extra: imported.source === 'json-pack'
      ? (imported.extraEvents || [])
      : (prev.bySource?.extra || []),
  };

  const events = [...bySource.spotify, ...bySource.youtubeMusic, ...bySource.extra]
    .sort((a, b) => Date.parse(a?.createdAt || 0) - Date.parse(b?.createdAt || 0));

  const likedSongKeys = [...new Set([
    ...(prev.likedSongKeys || []),
    ...(imported.likedSongKeys || []),
  ])];

  const sources = {
    ...(prev.sources || {}),
    ...(imported.source === 'spotify' ? { spotify: imported.summary } : {}),
    ...(imported.source === 'youtube-music' ? { youtubeMusic: imported.summary } : {}),
    ...(imported.source === 'json-pack' ? imported.summary : {}),
  };

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    bySource,
    events,
    likedSongKeys,
    sources,
  };
}
