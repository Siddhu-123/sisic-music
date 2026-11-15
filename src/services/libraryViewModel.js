/**
 * Canonical library & playback-history selectors.
 *
 * Keeps one authoritative source of truth for song lists, liked tracks, and
 * merged playback events across Home, Explore, Galaxy, Recommendations, and
 * Taste Profile so individual views cannot drift out of sync.
 */
import { normalizeText } from '../songIdentity.js';
import { rankedExploreSearch } from './exploreService.js';

/**
 * Selects the fuller song index in dev mode so partial live Drive scans do not
 * clobber the local dev-cache snapshot.
 */
export function selectCanonicalDriveSongs(prevSongs = [], incomingSongs = [], { isDev = false } = {}) {
  const safeIncoming = Array.isArray(incomingSongs) ? incomingSongs : [];
  if (isDev && Array.isArray(prevSongs) && prevSongs.length > safeIncoming.length) {
    return prevSongs;
  }
  return safeIncoming;
}

/**
 * Resolves the canonical song list for UI surfaces and analytics.
 */
export function resolveEffectiveLibrarySongs({ dbSongs = [], driveIndexSongs = [], isDev = false } = {}) {
  const safeDb = Array.isArray(dbSongs) ? dbSongs : [];
  const safeDrive = Array.isArray(driveIndexSongs) ? driveIndexSongs : [];
  if (isDev && safeDrive.length > safeDb.length) {
    return safeDrive;
  }
  return safeDb;
}

/**
 * Merges native playlist likes with liked tracks imported from external
 * histories (e.g. YouTube Music / Spotify) without duplicates.
 */
export function mergeLikedSongKeys(nativeKeys = [], externalKeys = []) {
  const safeNative = Array.isArray(nativeKeys) ? nativeKeys : [];
  const safeExternal = Array.isArray(externalKeys) ? externalKeys : [];
  if (!safeExternal.length) return safeNative;
  return [...new Set([...safeNative, ...safeExternal].filter(Boolean))];
}

/**
 * Combines native/Drive playback events with imported external listening events
 * in chronological order without mutating either input array.
 */
export function mergeExternalAndNativeEvents(externalEvents = [], nativeEvents = []) {
  const safeExternal = Array.isArray(externalEvents) ? externalEvents : [];
  const safeNative = Array.isArray(nativeEvents) ? nativeEvents : [];
  if (!safeExternal.length) return safeNative;
  return [...externalEvents, ...nativeEvents].sort((a, b) => Date.parse(a?.createdAt || 0) - Date.parse(b?.createdAt || 0));
}

function substringMatchSongs(query, songs = []) {
  const normalized = normalizeText(query);
  const rawLower = String(query || '').trim().toLowerCase();
  return songs.filter(song => {
    const hay = `${song?.track || ''} ${song?.artist || ''} ${song?.album || ''}`;
    return hay.toLowerCase().includes(rawLower) || (normalized && normalizeText(hay).includes(normalized));
  });
}

/**
 * Resolves the visible song list for Library / Playlist / Universal Search:
 * - Inside a selected playlist: returns playlist songs filtered by `query`.
 * - Outside a playlist with an active `query`: searches across `browseSongs`
 *   (Drive-ready + library + catalogue songs) so Request tracks are discoverable.
 * - Outside a playlist with an empty `query`: returns `driveReadySongs`.
 */
export function resolveLibrarySearchSongs({
  searchQuery = '',
  selectedPlaylistKey = null,
  playlistSongs = [],
  driveReadySongs = [],
  browseSongs = [],
} = {}) {
  const trimmed = String(searchQuery || '').trim();
  if (selectedPlaylistKey) {
    return trimmed ? substringMatchSongs(trimmed, playlistSongs) : playlistSongs;
  }
  if (!trimmed) {
    return driveReadySongs;
  }
  const source = browseSongs.length ? browseSongs : driveReadySongs;
  const normalized = normalizeText(trimmed);
  const hasRankableToken = normalized.split(' ').some(token => token.length >= 2);
  const matches = hasRankableToken
    ? rankedExploreSearch(trimmed, source)
    : substringMatchSongs(trimmed, source);
  // Prefer Drive-ready songs above catalogue-only entries when relevance scores are similar.
  return [...matches].sort((a, b) => Number(Boolean(b?.driveFileId)) - Number(Boolean(a?.driveFileId)));
}
