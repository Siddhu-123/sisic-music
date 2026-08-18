const SPACE_RE = /\s+/g;
const TRACK_NOISE_WORDS = new Set([
  'a',
  'an',
  'and',
  'audio',
  'deluxe',
  'edit',
  'explicit',
  'feat',
  'featuring',
  'from',
  'live',
  'lyric',
  'lyrics',
  'mix',
  'music',
  'official',
  'remaster',
  'remastered',
  'single',
  'the',
  'version',
  'video',
  'visualizer',
  'with',
]);
const TRACK_VARIANT_WORDS = new Set([
  'acoustic',
  'cover',
  'instrumental',
  'karaoke',
  'live',
  'nightcore',
  'remix',
  'slowed',
  'sped',
]);

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
  if (typeof songOrArtist === 'object' && songOrArtist?.songKey) return String(songOrArtist.songKey);
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

export function tokenSet(value = '', { dropNoise = false } = {}) {
  const tokens = normalizeText(value).split(' ').filter(Boolean);
  return new Set(dropNoise ? tokens.filter(token => !TRACK_NOISE_WORDS.has(token)) : tokens);
}

function jaccard(left, right) {
  if (!left.size && !right.size) return 1;
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap++;
  }
  return overlap / (left.size + right.size - overlap);
}

function containment(left, right) {
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap++;
  }
  return overlap / Math.min(left.size, right.size);
}

export function compareSongSimilarity(leftInput = {}, rightInput = {}) {
  const left = asSongRecord(leftInput);
  const right = asSongRecord(rightInput);
  const leftKey = getSongKey(left);
  const rightKey = getSongKey(right);
  if (leftKey === rightKey) {
    return { score: 1, confidence: 'exact', artistScore: 1, trackScore: 1, reason: 'Exact song key match' };
  }

  const leftArtist = tokenSet(left.artist);
  const rightArtist = tokenSet(right.artist);
  const leftTrack = tokenSet(left.track, { dropNoise: true });
  const rightTrack = tokenSet(right.track, { dropNoise: true });
  const artistScore = Math.max(jaccard(leftArtist, rightArtist), containment(leftArtist, rightArtist));
  let trackScore = Math.max(jaccard(leftTrack, rightTrack), containment(leftTrack, rightTrack));
  const variantDifference = [...TRACK_VARIANT_WORDS].some(token => leftTrack.has(token) !== rightTrack.has(token));
  if (variantDifference) trackScore = Math.min(trackScore, 0.62);
  const score = (artistScore * 0.58) + (trackScore * 0.42);

  let confidence = 'none';
  if (artistScore >= 0.92 && trackScore >= 0.78 && score >= 0.86) {
    confidence = 'high';
  } else if (artistScore >= 0.78 && trackScore >= 0.55 && score >= 0.68) {
    confidence = 'medium';
  }

  return {
    score,
    confidence,
    artistScore,
    trackScore,
    reason: `artist ${artistScore.toFixed(2)}, track ${trackScore.toFixed(2)}`,
  };
}

export function findSimilarSongMatch(song, candidates = [], minimumConfidence = 'medium') {
  const allowed = minimumConfidence === 'high' ? new Set(['exact', 'high']) : new Set(['exact', 'high', 'medium']);
  let best = null;
  for (const candidate of candidates) {
    const similarity = compareSongSimilarity(song, candidate);
    if (!allowed.has(similarity.confidence)) continue;
    if (!best || similarity.score > best.similarity.score) {
      best = { song: candidate, similarity };
    }
  }
  return best;
}
