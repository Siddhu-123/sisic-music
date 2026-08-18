import { db } from '../db.js';
import { getSongKey } from '../songIdentity.js';

const memoryArtCache = new Map();
const activeFetchPromises = new Map();

/**
 * Deterministically hashes a string to a 32-bit unsigned integer.
 */
export function hashString(str = '') {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function escapeXmlText(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generates dynamic, aesthetic procedural artwork as an SVG data URI
 * based on the song's identity hash.
 */
export function generateProceduralArtwork({ artist = '', track = '', songKey = '' }) {
  const effectiveKey = songKey || getSongKey({ artist, track });
  const hash = hashString(effectiveKey);

  const hue1 = hash % 360;
  const hue2 = (hue1 + 40 + ((hash >> 4) % 80)) % 360;
  const hue3 = (hue1 + 180 + ((hash >> 8) % 60)) % 360;
  const angle = (hash >> 3) % 360;

  const initials = escapeXmlText([
    (artist || 'A').trim().charAt(0).toUpperCase(),
    (track || 'T').trim().charAt(0).toUpperCase(),
  ].join(''));

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="g_${hash}" x1="0%" y1="0%" x2="100%" y2="100%" gradientTransform="rotate(${angle})">
      <stop offset="0%" stop-color="hsl(${hue1}, 75%, 52%)" />
      <stop offset="50%" stop-color="hsl(${hue2}, 70%, 45%)" />
      <stop offset="100%" stop-color="hsl(${hue3}, 80%, 35%)" />
    </linearGradient>
    <radialGradient id="ring_${hash}" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="rgba(255,255,255,0.25)" />
      <stop offset="70%" stop-color="rgba(255,255,255,0.05)" />
      <stop offset="100%" stop-color="rgba(0,0,0,0.4)" />
    </radialGradient>
  </defs>
  <rect width="400" height="400" rx="28" fill="url(#g_${hash})" />
  <rect width="400" height="400" rx="28" fill="url(#ring_${hash})" />
  <!-- Concentric subtle vinyl grooves -->
  <circle cx="200" cy="200" r="160" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="1.5" />
  <circle cx="200" cy="200" r="125" fill="none" stroke="rgba(255,255,255,0.10)" stroke-width="1.5" />
  <circle cx="200" cy="200" r="90" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="1.5" />
  <circle cx="200" cy="200" r="55" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="2" />
  <!-- Center badge -->
  <circle cx="200" cy="200" r="42" fill="rgba(20,20,28,0.65)" stroke="rgba(255,255,255,0.3)" stroke-width="1.5" />
  <text x="200" y="208" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="22" font-weight="700" fill="rgba(255,255,255,0.92)" letter-spacing="1">${initials}</text>
</svg>`;

  const dataUri = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  return {
    coverArtUrl: dataUri,
    isProcedural: true,
    hue: hue1,
    colors: {
      primary: `hsl(${hue1}, 75%, 52%)`,
      secondary: `hsl(${hue2}, 70%, 45%)`,
      shadow: `hsla(${hue1}, 60%, 25%, 0.35)`,
    },
  };
}

/**
 * Extracts complementary neumorphic shadow and highlight colors
 * from a song's artwork or identity.
 */
export function getArtworkThemeColors(song = {}) {
  const key = song.songKey || getSongKey(song);
  const hash = hashString(key);
  const hue = song.artHue ?? (hash % 360);
  return {
    hue,
    accent: `hsl(${hue}, 80%, 55%)`,
    glow: `hsla(${hue}, 85%, 60%, 0.4)`,
    shadowSoft: `hsla(${hue}, 50%, 20%, 0.18)`,
  };
}

/**
 * Tier 1: Look up official cover art via Apple iTunes Search API.
 * iTunes Search API natively supports browser CORS without requiring an API key.
 */
export async function searchITunesArtwork({ artist = '', track = '', album = '' }) {
  if (!artist && !track) return null;
  const cleanArtist = String(artist || '').replace(/[()[\]{}]/g, '').trim();
  const cleanTrack = String(track || '').replace(/\([^)]*(feat|remix|version|edit)[^)]*\)/gi, '').trim();
  const query = `${cleanArtist} ${cleanTrack}`.trim();

  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=1`;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data.results || data.results.length === 0) return null;

    const result = data.results[0];
    const rawArtworkUrl = result.artworkUrl100 || result.artworkUrl60 || '';
    // Upgrade 100x100 to 600x600 high resolution cover art
    const highResArtworkUrl = rawArtworkUrl.replace(/\/\d+x\d+bb\./i, '/600x600bb.');

    return {
      coverArtUrl: highResArtworkUrl || rawArtworkUrl,
      album: result.collectionName || album || '',
      genre: result.primaryGenreName || '',
      releaseYear: result.releaseDate ? new Date(result.releaseDate).getFullYear() : null,
      durationMs: result.trackTimeMillis || null,
      source: 'itunes',
      isProcedural: false,
    };
  } catch (error) {
    console.debug('iTunes artwork lookup failed (network or rate limit):', error);
    return null;
  }
}

/**
 * Unified artwork getter. Checks memory cache -> IndexedDB -> iTunes API -> Procedural fallback.
 */
export async function getSongArtwork(song = {}) {
  const songKey = song.songKey || getSongKey(song);
  if (!songKey) return generateProceduralArtwork(song);

  // 1. Memory cache
  if (memoryArtCache.has(songKey)) {
    return memoryArtCache.get(songKey);
  }

  // 2. Direct property on song object
  if (song.coverArtUrl && !song.coverArtUrl.startsWith('data:image/svg+xml')) {
    const result = {
      coverArtUrl: song.coverArtUrl,
      album: song.album || '',
      isProcedural: false,
    };
    memoryArtCache.set(songKey, result);
    return result;
  }

  // 3. Prevent duplicate in-flight network requests
  if (activeFetchPromises.has(songKey)) {
    return activeFetchPromises.get(songKey);
  }

  const fetchPromise = (async () => {
    try {
      // Check IndexedDB
      if (db?.songArt) {
        const stored = await db.songArt.get(songKey);
        if (stored?.coverArtUrl) {
          const result = {
            coverArtUrl: stored.coverArtUrl,
            album: stored.album || song.album || '',
            genre: stored.genre || '',
            releaseYear: stored.releaseYear || null,
            isProcedural: Boolean(stored.isProcedural),
          };
          memoryArtCache.set(songKey, result);
          return result;
        }
      }

      // Check iTunes API
      const iTunesResult = await searchITunesArtwork({
        artist: song.artist,
        track: song.track,
        album: song.album,
      });

      if (iTunesResult?.coverArtUrl) {
        memoryArtCache.set(songKey, iTunesResult);
        if (db?.songArt) {
          await db.songArt.put({
            songKey,
            coverArtUrl: iTunesResult.coverArtUrl,
            album: iTunesResult.album || song.album || '',
            genre: iTunesResult.genre || '',
            releaseYear: iTunesResult.releaseYear || null,
            cachedAt: Date.now(),
            isProcedural: false,
          }).catch(() => {});
        }
        return iTunesResult;
      }
    } catch (err) {
      console.debug('Error in artwork pipeline:', err);
    } finally {
      activeFetchPromises.delete(songKey);
    }

    // Fallback: Deterministic procedural art
    const procedural = generateProceduralArtwork(song);
    memoryArtCache.set(songKey, procedural);
    return procedural;
  })();

  activeFetchPromises.set(songKey, fetchPromise);
  return fetchPromise;
}
