const SPACE_RE = /\s+/g;

export function normalizeText(value = '') {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(SPACE_RE, ' ');
}

export function getSongKey(songOrArtist, maybeTrack) {
  const artist = typeof songOrArtist === 'object'
    ? songOrArtist?.artist
    : songOrArtist;
  const track = typeof songOrArtist === 'object'
    ? songOrArtist?.track || songOrArtist?.title || songOrArtist?.name
    : maybeTrack;
  return `${normalizeText(artist) || 'unknown artist'}::${normalizeText(track) || 'unknown track'}`;
}

export function getPlaylistKey(name = 'Saved Tracks') {
  return normalizeText(name) || 'saved tracks';
}

export function unsafeFilenameChars(value = '') {
  return [...String(value || '')]
    .map(char => (char.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(char) ? '_' : char))
    .join('')
    .trim();
}

export function displayTrack(song = {}) {
  return song.track || song.title || song.name || 'Unknown Track';
}

export function displayArtist(song = {}) {
  return song.artist || 'Unknown Artist';
}

export function canonicalAudioFilename(song = {}) {
  return `${unsafeFilenameChars(`${displayArtist(song)} - ${displayTrack(song)}`) || 'Untitled'}.mp3`;
}

export function jobFilePrefix(songKey = '') {
  const safeKey = normalizeText(songKey).replace(/[:\s]+/g, '-').toLowerCase();
  return `sisic-job-${safeKey || 'unknown'}`;
}

export function asSongRecord(song = {}) {
  const artist = displayArtist(song);
  const track = displayTrack(song);
  return {
    ...song,
    songKey: song.songKey || getSongKey({ artist, track }),
    artist,
    track,
    album: song.album || '',
  };
}
