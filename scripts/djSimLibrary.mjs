/**
 * Seeded synthetic music library generator for DJ simulation.
 */

export const DEFAULT_GENRES = [
  { id: 'downtempo', name: 'Downtempo', tempoMean: 78, tempoSd: 6, majorShare: 0.35, energyMean: 0.30 },
  { id: 'hiphop', name: 'Hip-Hop', tempoMean: 92, tempoSd: 5, majorShare: 0.45, energyMean: 0.45 },
  { id: 'pop', name: 'Pop', tempoMean: 100, tempoSd: 6, majorShare: 0.65, energyMean: 0.55 },
  { id: 'disco', name: 'Disco', tempoMean: 110, tempoSd: 6, majorShare: 0.60, energyMean: 0.65 },
  { id: 'deephouse', name: 'Deep House', tempoMean: 122, tempoSd: 4, majorShare: 0.50, energyMean: 0.70 },
  { id: 'house', name: 'House', tempoMean: 128, tempoSd: 3, majorShare: 0.55, energyMean: 0.75 },
  { id: 'techno', name: 'Techno', tempoMean: 140, tempoSd: 5, majorShare: 0.35, energyMean: 0.78 },
  { id: 'dnb', name: 'Drum & Bass', tempoMean: 160, tempoSd: 8, majorShare: 0.40, energyMean: 0.80 },
];

const ROOTS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export function mulberry32(seed) {
  let s = (typeof seed === 'number' ? seed : 1) >>> 0;
  return function next() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalRandom(rng, mean = 0, sd = 1) {
  const u1 = Math.max(1e-15, rng());
  const u2 = rng();
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return mean + z0 * sd;
}

function shuffle(array, rng) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const temp = array[i];
    array[i] = array[j];
    array[j] = temp;
  }
  return array;
}

export function tasteVector(seed, genres = DEFAULT_GENRES) {
  const rng = typeof seed === 'function' ? seed : mulberry32(seed ?? 1);
  const vector = {};
  for (const g of genres) {
    const w = Number(rng().toFixed(4));
    if (typeof g === 'string') {
      vector[g] = w;
    } else if (g && typeof g === 'object') {
      if (g.id) vector[g.id] = w;
      if (g.name) vector[g.name] = w;
    }
  }
  return vector;
}

export function tasteOf(song, vector) {
  if (!song || !vector) return 0.5;
  let val;
  if (vector instanceof Map) {
    val = vector.get(song.genre) ?? vector.get(song.genreId);
  } else if (typeof vector === 'object') {
    val = vector[song.genre] ?? vector[song.genreId];
  }
  if (val == null) return 0.5;
  const num = Number(val);
  return Number.isFinite(num) ? Math.max(0, Math.min(1, num)) : 0.5;
}

export function makeLibrary({ size = 400, seed = 1 } = {}) {
  const rng = mulberry32(seed);
  const genres = DEFAULT_GENRES.map(g => ({ ...g }));

  // 60 artists with 3-12 songs each at size 400
  const artistCount = (size === 400) ? 60 : Math.max(1, Math.min(60, Math.floor(size / 3)));
  const artistNames = Array.from(
    { length: artistCount },
    (_, i) => `Artist ${String(i + 1).padStart(2, '0')}`
  );

  // Assign home genres to artists evenly
  const artistHomeGenres = artistNames.map((_, i) => genres[i % genres.length]);

  // Distribute song counts per artist
  const songCounts = new Array(artistCount).fill(0);
  let assignedSongs = 0;
  if (size === 400 && artistCount === 60) {
    // Exactly 3 songs base per artist = 180
    songCounts.fill(3);
    assignedSongs = 180;
    let remaining = size - assignedSongs;
    while (remaining > 0) {
      const idx = Math.floor(rng() * artistCount);
      if (songCounts[idx] < 12) {
        songCounts[idx]++;
        remaining--;
      }
    }
  } else {
    // General size distribution
    const minPerArtist = Math.max(1, Math.floor(size / artistCount));
    songCounts.fill(minPerArtist);
    assignedSongs = minPerArtist * artistCount;
    let remaining = size - assignedSongs;
    while (remaining > 0) {
      const idx = Math.floor(rng() * artistCount);
      songCounts[idx]++;
      remaining--;
    }
  }

  // Pre-allocate defects with exact shares to guarantee shares within +-3 points
  // 10% tempo defect (5% half-time, 5% double-time)
  const tempoDefectTotal = Math.round(size * 0.10);
  const halfTempoCount = Math.floor(tempoDefectTotal / 2);
  const doubleTempoCount = tempoDefectTotal - halfTempoCount;
  const tempoDefects = new Array(size).fill(null);
  for (let i = 0; i < halfTempoCount; i++) tempoDefects[i] = 'half';
  for (let i = halfTempoCount; i < halfTempoCount + doubleTempoCount; i++) tempoDefects[i] = 'double';
  shuffle(tempoDefects, rng);

  // 15% rubato
  const rubatoTotal = Math.round(size * 0.15);
  const rubatoFlags = new Array(size).fill(false);
  for (let i = 0; i < rubatoTotal; i++) rubatoFlags[i] = true;
  shuffle(rubatoFlags, rng);

  // 10% unknown key
  const unknownKeyTotal = Math.round(size * 0.10);
  const unknownKeyFlags = new Array(size).fill(false);
  for (let i = 0; i < unknownKeyTotal; i++) unknownKeyFlags[i] = true;
  shuffle(unknownKeyFlags, rng);

  // 8% abruptEnd
  const abruptEndTotal = Math.round(size * 0.08);
  const abruptEndFlags = new Array(size).fill(false);
  for (let i = 0; i < abruptEndTotal; i++) abruptEndFlags[i] = true;
  shuffle(abruptEndFlags, rng);

  // 15% cross-genre (song gets another genre)
  const crossGenreTotal = Math.round(size * 0.15);
  const crossGenreFlags = new Array(size).fill(false);
  for (let i = 0; i < crossGenreTotal; i++) crossGenreFlags[i] = true;
  shuffle(crossGenreFlags, rng);

  // Generate songs
  const songs = [];
  let songIndex = 0;

  for (let a = 0; a < artistCount; a++) {
    const artistName = artistNames[a];
    const homeGenre = artistHomeGenres[a];
    const count = songCounts[a];

    for (let trackNum = 1; trackNum <= count; trackNum++) {
      if (songIndex >= size) break;
      const currentIdx = songIndex;

      // Select genre: 15% get another genre
      let songGenre = homeGenre;
      if (crossGenreFlags[currentIdx]) {
        const otherGenres = genres.filter(g => g.id !== homeGenre.id);
        songGenre = otherGenres[Math.floor(rng() * otherGenres.length)];
      }

      // Sample base tempo from genre cluster
      const sampledTempo = normalRandom(rng, songGenre.tempoMean, songGenre.tempoSd);
      const baseTempo = Math.max(30, Math.min(260, Number(sampledTempo.toFixed(2))));

      // Inject tempo defect (10% half-time or double-time)
      let finalBpm = baseTempo;
      const defectType = tempoDefects[currentIdx];
      if (defectType === 'half') {
        finalBpm = Number((baseTempo * 0.5).toFixed(2));
      } else if (defectType === 'double') {
        finalBpm = Number((baseTempo * 2.0).toFixed(2));
      }

      // startBpm and outroBpm within 2% of bpm
      const startBpm = Number((finalBpm * (1 + (rng() * 0.03 - 0.015))).toFixed(2));
      const outroBpm = Number((finalBpm * (1 + (rng() * 0.03 - 0.015))).toFixed(2));

      // Key & key confidence (10% unknown key)
      let musicalKey = null;
      let keyConfidence = 0;
      if (!unknownKeyFlags[currentIdx]) {
        const mode = rng() < songGenre.majorShare ? 'major' : 'minor';
        const root = ROOTS[Math.floor(rng() * ROOTS.length)];
        musicalKey = `${root} ${mode}`;
        keyConfidence = Number((0.60 + rng() * 0.38).toFixed(3));
      }

      // Energy sampled from genre cluster
      const sampledEnergy = normalRandom(rng, songGenre.energyMean, 0.08);
      const energy = Math.max(0.01, Math.min(0.99, Number(sampledEnergy.toFixed(3))));

      // Rubato defect: gridCoverage 0.4 for rubato, else 0.85-1
      const isRubato = rubatoFlags[currentIdx];
      const gridCoverage = isRubato ? 0.4 : Number((0.85 + rng() * 0.15).toFixed(3));
      const downbeatAgreement = isRubato
        ? Number((0.30 + rng() * 0.20).toFixed(3))
        : Number((0.85 + rng() * 0.14).toFixed(3));

      // Duration: 150-330 s; outroStart about 14-20 s before end
      const duration = Number((150 + rng() * 180).toFixed(1));
      const outroOffset = 14 + rng() * 6;
      const outroStart = Number((duration - outroOffset).toFixed(2));
      const introEnd = Number((8 + rng() * 16).toFixed(2));
      const firstDownbeat = Number((0.2 + rng() * 0.8).toFixed(3));
      const abruptEnd = abruptEndFlags[currentIdx];
      const loudnessLufs = Number((-14 + rng() * 8).toFixed(1));

      const trackName = `Track ${trackNum}`;
      const songKey = `${artistName.toLowerCase()}::${trackName.toLowerCase()}`;
      const driveFileId = `sim_file_${seed}_${currentIdx + 1}`;

      const djRhythm = {
        bpm: finalBpm,
        startBpm,
        outroBpm,
        rhythmStatus: 'ready',
        firstDownbeat,
        barBeats: 4,
        gridCoverage,
        downbeatAgreement,
        outroStart,
        outroBars: 8,
        introEnd,
        introBars: 4,
        abruptEnd,
        duration,
      };

      const song = {
        songKey,
        artist: artistName,
        track: trackName,
        driveFileId,
        genre: songGenre.name,
        genreId: songGenre.id,
        bpm: finalBpm,
        musicalKey,
        keyConfidence,
        energy,
        djAudioWindows: [],
        loudnessLufs,
        djMetadataVersion: 2,
        duration,
        abruptEnd,
        djRhythm,
      };

      songs.push(song);
      songIndex++;
    }
  }

  return { songs, genres };
}
