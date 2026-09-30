import { getSongKey, normalizeText } from '../songIdentity.js';
import {
  buildContextualTasteProfile,
  rankContextualSongs,
} from './contextualRecommendationService.js';

const GENRE_RULES = [
  ['Pop', ['pop', 'dance pop', 'synthpop']],
  ['Electronic', ['electronic', 'edm', 'house', 'techno', 'trance', 'synth', 'drum and bass']],
  ['Hip-hop', ['hip hop', 'hip-hop', 'rap', 'trap', 'drill']],
  ['Rock', ['rock', 'metal', 'punk', 'grunge', 'indie rock']],
  ['R&B', ['r&b', 'rnb', 'soul', 'neo soul']],
  ['Jazz', ['jazz', 'blues', 'swing']],
  ['Classical', ['classical', 'orchestral', 'symphony', 'opera']],
  ['Country', ['country', 'folk', 'americana']],
  ['Latin', ['latin', 'reggaeton', 'salsa', 'afrobeats']],
  ['Ambient', ['ambient', 'lofi', 'lo-fi', 'chillhop']],
];

const MOOD_RULES = [
  ['Chill', ['chill', 'lofi', 'lo-fi', 'slowed', 'reverb', 'ambient', 'calm', 'soft', 'rain']],
  ['Energy', ['energy', 'energetic', 'club', 'dance', 'workout', 'bass', 'phonk', 'party']],
  ['Focus', ['focus', 'instrumental', 'study', 'piano', 'soundtrack', 'theme']],
  ['Late night', ['night', 'midnight', 'after hours', 'moon', 'dream']],
  ['Romantic', ['love', 'heart', 'romance', 'valentine']],
  ['Melancholic', ['sad', 'melancholy', 'blue', 'rainy', 'lonely']],
  ['Uplifting', ['sun', 'summer', 'happy', 'uplifting', 'morning', 'bright']],
];

function songText(song = {}) {
  return normalizeText([
    song.track,
    song.artist,
    song.album,
    song.genre,
    song.description,
    song.lyrics,
  ].filter(Boolean).join(' '));
}

function splitMetadataGenres(value = '') {
  return String(value)
    .split(/[,/|;&]+/)
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 3);
}

function matchedLabels(song, rules, fallback) {
  const text = songText(song);
  const labels = [];
  for (const [label, terms] of rules) {
    if (terms.some(term => text.includes(normalizeText(term)))) labels.push(label);
  }
  return labels.length ? [...new Set(labels)] : fallback;
}

export function getSongGenres(song = {}) {
  const metadataGenres = splitMetadataGenres(song.genre);
  const matched = matchedLabels(song, GENRE_RULES, []);
  const labels = [...metadataGenres, ...matched].map(label => String(label).trim()).filter(Boolean);
  return labels.length ? [...new Set(labels)].slice(0, 3) : ['Open format'];
}

export function getSongMoods(song = {}) {
  return matchedLabels(song, MOOD_RULES, ['Discovery']);
}

export function isStreamableSong(song = {}) {
  return Boolean(song.driveFileId);
}

export function rankedExploreSearch(query = '', songs = []) {
  const normalizedQuery = normalizeText(query);
  const queryTokens = normalizedQuery.split(' ').filter(token => token.length >= 2);
  const source = [...songs];
  if (!queryTokens.length) {
    return source.sort((a, b) => (
      (Number(b.playCount) || 0) - (Number(a.playCount) || 0)
      || Number(b.lastPlayedAt || b.updatedAt || 0) - Number(a.lastPlayedAt || a.updatedAt || 0)
      || String(a.track || '').localeCompare(String(b.track || ''))
    ));
  }

  return source
    .map(song => {
      const track = normalizeText(song.track || '');
      const artist = normalizeText(song.artist || '');
      const album = normalizeText(song.album || '');
      const facets = normalizeText([...getSongGenres(song), ...getSongMoods(song)].join(' '));
      const fields = `${track} ${artist} ${album} ${facets}`.trim();
      let score = 0;
      if (track === normalizedQuery) score += 150;
      if (artist === normalizedQuery) score += 130;
      if (track.startsWith(normalizedQuery)) score += 90;
      if (artist.startsWith(normalizedQuery)) score += 75;
      if (fields.includes(normalizedQuery)) score += 36;
      for (const token of queryTokens) {
        if (track.includes(token)) score += 28;
        else if (artist.includes(token)) score += 23;
        else if (album.includes(token)) score += 14;
        else if (facets.includes(token)) score += 12;
      }
      return { song, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || (Number(b.song.playCount) || 0) - (Number(a.song.playCount) || 0))
    .map(item => item.song);
}

export function filterExploreSongs(songs = [], { genre = '', mood = '', availability = 'all' } = {}) {
  return songs.filter(song => {
    if (genre && !getSongGenres(song).some(value => normalizeText(value) === normalizeText(genre))) return false;
    if (mood && !getSongMoods(song).some(value => normalizeText(value) === normalizeText(mood))) return false;
    if (availability === 'ready' && !isStreamableSong(song)) return false;
    return true;
  });
}

export function getExploreFacets(songs = [], type = 'genre', limit = 8) {
  const labelsForSong = type === 'mood' ? getSongMoods : getSongGenres;
  const counts = new Map();
  for (const song of songs) {
    for (const label of labelsForSong(song)) counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

function songKey(song) {
  return song.songKey || getSongKey(song);
}

function dominantFacet(songs, getLabels) {
  const counts = new Map();
  for (const song of songs) {
    for (const label of getLabels(song)) counts.set(label, (counts.get(label) || 0) + Math.max(1, Number(song.playCount) || 0));
  }
  return [...counts.entries()].sort(([, a], [, b]) => b - a)[0]?.[0] || '';
}

export function buildExploreMixes(songs = [], {
  playbackEvents = [],
  likedSongKeys = [],
  now = Date.now(),
  currentContext,
} = {}) {
  const pool = songs.filter(song => songKey(song));
  const liked = new Set(likedSongKeys);
  const starts = playbackEvents.filter(event => ['playback-start', 'playback-resume'].includes(event.eventType));
  const playCountByKey = new Map();
  for (const event of starts) {
    if (event.songKey) playCountByKey.set(event.songKey, (playCountByKey.get(event.songKey) || 0) + 1);
  }
  const profile = buildContextualTasteProfile(pool, playbackEvents, { now, currentContext });
  const ranked = rankContextualSongs(pool, {
    profile,
    likedSongKeys: liked,
    playCountByKey,
    now,
    limit: pool.length,
  });
  const topMood = dominantFacet(ranked.slice(0, 30), getSongMoods);
  const topGenre = dominantFacet(ranked.slice(0, 30), getSongGenres);
  const moodSongs = topMood ? ranked.filter(song => getSongMoods(song).includes(topMood)) : [];
  const genreSongs = topGenre ? ranked.filter(song => getSongGenres(song).includes(topGenre)) : [];
  const notReady = ranked.filter(song => !isStreamableSong(song));
  const suggestions = ranked.filter(song => (Number(song.playCount) || 0) === 0 || !isStreamableSong(song));

  const mixes = [
    { id: 'your-taste', title: 'Your taste', subtitle: 'Your strongest local matches', songs: ranked.slice(0, 12) },
    topMood ? { id: `mood-${normalizeText(topMood)}`, title: `${topMood} mode`, subtitle: 'Built from the way you listen', songs: moodSongs.slice(0, 12) } : null,
    topGenre ? { id: `genre-${normalizeText(topGenre)}`, title: `${topGenre} shelf`, subtitle: 'A focused library mix', songs: genreSongs.slice(0, 12) } : null,
    notReady.length ? { id: 'not-ready', title: 'Not ready yet', subtitle: 'Queue the Mac worker to prepare these songs', songs: notReady.slice(0, 12) } : null,
  ].filter(mix => mix?.songs?.length);

  return {
    mixes,
    suggestions: (suggestions.length ? suggestions : ranked).slice(0, 12),
    topMood,
    topGenre,
    hasTasteSignal: Boolean(profile.hasSignal || liked.size || pool.some(song => Number(song.playCount) > 0)),
  };
}
