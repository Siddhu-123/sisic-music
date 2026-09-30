import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mulberry32,
  makeLibrary,
  tasteVector,
  tasteOf,
  DEFAULT_GENRES,
} from './djSimLibrary.mjs';

test('mulberry32 generates deterministic floats in [0, 1)', () => {
  const rng1 = mulberry32(12345);
  const rng2 = mulberry32(12345);
  const seq1 = Array.from({ length: 10 }, () => rng1());
  const seq2 = Array.from({ length: 10 }, () => rng2());

  assert.deepEqual(seq1, seq2);
  for (const val of seq1) {
    assert(val >= 0 && val < 1, `Expected float in [0, 1), got ${val}`);
  }

  const rng3 = mulberry32(54321);
  const seq3 = Array.from({ length: 10 }, () => rng3());
  assert.notDeepEqual(seq1, seq3);
});

test('determinism: same seed produces identical libraries', () => {
  const lib1 = makeLibrary({ size: 400, seed: 42 });
  const lib2 = makeLibrary({ size: 400, seed: 42 });
  assert.deepEqual(lib1, lib2);

  const lib3 = makeLibrary({ size: 400, seed: 999 });
  assert.notDeepEqual(lib1.songs[0], lib3.songs[0]);
});

test('size: generates expected number of songs', () => {
  const defaultLib = makeLibrary();
  assert.equal(defaultLib.songs.length, 400);

  const customLib = makeLibrary({ size: 250, seed: 10 });
  assert.equal(customLib.songs.length, 250);
});

test('unique songKeys across the library', () => {
  const { songs } = makeLibrary({ size: 400, seed: 7 });
  const keys = songs.map(s => s.songKey);
  const uniqueKeys = new Set(keys);
  assert.equal(uniqueKeys.size, songs.length);
  for (const key of keys) {
    assert(typeof key === 'string' && key.length > 0);
  }
});

test('60 artists with 3-12 songs each at size 400', () => {
  const { songs } = makeLibrary({ size: 400, seed: 101 });
  const artistCounts = new Map();
  for (const song of songs) {
    artistCounts.set(song.artist, (artistCounts.get(song.artist) || 0) + 1);
  }

  assert.equal(artistCounts.size, 60, `Expected 60 artists, got ${artistCounts.size}`);
  for (const [artist, count] of artistCounts.entries()) {
    assert(
      count >= 3 && count <= 12,
      `Artist ${artist} has ${count} songs, expected between 3 and 12`
    );
  }
});

test('defect shares are within +-3 points of targets at size 400', () => {
  const size = 400;
  const { songs, genres } = makeLibrary({ size, seed: 2024 });

  // Map genre names to genres for reference
  const genreMap = new Map(genres.map(g => [g.name, g]));

  let rubatoCount = 0;
  let unknownKeyCount = 0;
  let abruptEndCount = 0;
  let tempoDefectCount = 0;
  let crossGenreCount = 0;

  // Track artist home genres
  const artistHomeMap = new Map();
  for (const song of songs) {
    if (!artistHomeMap.has(song.artist)) {
      // First song determines home genre or check if it matches
    }
  }

  for (const song of songs) {
    // Rubato defect: gridCoverage === 0.4
    if (song.djRhythm.gridCoverage === 0.4) {
      rubatoCount++;
    }

    // Unknown key defect: musicalKey is null and keyConfidence === 0
    if (song.musicalKey === null && song.keyConfidence === 0) {
      unknownKeyCount++;
    }

    // Abrupt end defect: abruptEnd === true
    if (song.djRhythm.abruptEnd === true) {
      abruptEndCount++;
    }

    // Tempo defect: bpm halved or doubled relative to genre mean cluster
    const g = genreMap.get(song.genre);
    if (g) {
      const ratio = song.bpm / g.tempoMean;
      if (ratio < 0.7 || ratio > 1.4) {
        tempoDefectCount++;
      }
    }
  }

  // 15% rubato (within +-3 points: 12% to 18%)
  const rubatoShare = (rubatoCount / size) * 100;
  assert(
    rubatoShare >= 12 && rubatoShare <= 18,
    `Rubato share ${rubatoShare}% outside 12-18% range`
  );

  // 10% unknown key (within +-3 points: 7% to 13%)
  const unknownKeyShare = (unknownKeyCount / size) * 100;
  assert(
    unknownKeyShare >= 7 && unknownKeyShare <= 13,
    `Unknown key share ${unknownKeyShare}% outside 7-13% range`
  );

  // 8% abrupt end (within +-3 points: 5% to 11%)
  const abruptEndShare = (abruptEndCount / size) * 100;
  assert(
    abruptEndShare >= 5 && abruptEndShare <= 11,
    `Abrupt end share ${abruptEndShare}% outside 5-11% range`
  );

  // 10% tempo defect (within +-3 points: 7% to 13%)
  const tempoDefectShare = (tempoDefectCount / size) * 100;
  assert(
    tempoDefectShare >= 7 && tempoDefectShare <= 13,
    `Tempo defect share ${tempoDefectShare}% outside 7-13% range`
  );
});

test('every required field is present and finite', () => {
  const { songs } = makeLibrary({ size: 400, seed: 777 });

  for (const song of songs) {
    assert(typeof song.songKey === 'string' && song.songKey.length > 0);
    assert(typeof song.artist === 'string' && song.artist.length > 0);
    assert(typeof song.track === 'string' && song.track.length > 0);
    assert(typeof song.driveFileId === 'string' && song.driveFileId.length > 0);
    assert(Number.isFinite(song.bpm) && song.bpm > 0);
    assert(song.musicalKey === null || typeof song.musicalKey === 'string');
    assert(Number.isFinite(song.keyConfidence) && song.keyConfidence >= 0 && song.keyConfidence <= 1);
    assert(Number.isFinite(song.energy) && song.energy >= 0 && song.energy <= 1);
    assert(Array.isArray(song.djAudioWindows));
    assert(Number.isFinite(song.loudnessLufs));
    assert.equal(song.djMetadataVersion, 2);
    assert(Number.isFinite(song.duration) && song.duration >= 150 && song.duration <= 330);
    assert(typeof song.abruptEnd === 'boolean');

    const rhythm = song.djRhythm;
    assert(rhythm && typeof rhythm === 'object');
    assert(Number.isFinite(rhythm.bpm) && rhythm.bpm > 0);
    assert(Number.isFinite(rhythm.startBpm));
    assert(Number.isFinite(rhythm.outroBpm));

    // startBpm and outroBpm within 2% of bpm
    const startDiff = Math.abs(rhythm.startBpm - rhythm.bpm) / rhythm.bpm;
    const outroDiff = Math.abs(rhythm.outroBpm - rhythm.bpm) / rhythm.bpm;
    assert(startDiff <= 0.02, `startBpm ${rhythm.startBpm} differs from bpm ${rhythm.bpm} by ${startDiff * 100}%`);
    assert(outroDiff <= 0.02, `outroBpm ${rhythm.outroBpm} differs from bpm ${rhythm.bpm} by ${outroDiff * 100}%`);

    assert.equal(rhythm.rhythmStatus, 'ready');
    assert(Number.isFinite(rhythm.firstDownbeat) && rhythm.firstDownbeat >= 0);
    assert.equal(rhythm.barBeats, 4);
    assert(Number.isFinite(rhythm.gridCoverage) && rhythm.gridCoverage >= 0 && rhythm.gridCoverage <= 1);
    if (rhythm.gridCoverage === 0.4) {
      // Rubato
    } else {
      assert(rhythm.gridCoverage >= 0.85 && rhythm.gridCoverage <= 1);
    }
    assert(Number.isFinite(rhythm.downbeatAgreement) && rhythm.downbeatAgreement >= 0 && rhythm.downbeatAgreement <= 1);
    assert(Number.isFinite(rhythm.outroStart));

    // outroStart about 14-20 s before the end
    const outroOffset = rhythm.duration - rhythm.outroStart;
    assert(outroOffset >= 13.5 && outroOffset <= 20.5, `outroOffset was ${outroOffset}`);

    assert(Number.isFinite(rhythm.outroBars) && rhythm.outroBars > 0);
    assert(Number.isFinite(rhythm.introEnd) && rhythm.introEnd > 0);
    assert(Number.isFinite(rhythm.introBars) && rhythm.introBars > 0);
    assert(typeof rhythm.abruptEnd === 'boolean');
    assert(Number.isFinite(rhythm.duration) && rhythm.duration >= 150 && rhythm.duration <= 330);
  }
});

test('tempo clusters near their means', () => {
  const { songs, genres } = makeLibrary({ size: 400, seed: 333 });

  for (const genre of genres) {
    const genreSongs = songs.filter(s => s.genre === genre.name || s.genreId === genre.id);
    assert(genreSongs.length > 0, `Genre ${genre.name} should have songs`);

    // Normalize any half-time or double-time defects to find underlying tempo cluster
    const tempos = genreSongs.map(s => {
      let b = s.bpm;
      if (b < genre.tempoMean * 0.7) b *= 2;
      if (b > genre.tempoMean * 1.4) b /= 2;
      return b;
    });

    const mean = tempos.reduce((sum, v) => sum + v, 0) / tempos.length;
    const diff = Math.abs(mean - genre.tempoMean);
    assert(
      diff < 3.0,
      `Genre ${genre.name} tempo mean ${mean.toFixed(2)} differs from target ${genre.tempoMean} by ${diff.toFixed(2)}`
    );
  }
});

test('tasteVector and tasteOf produce values in 0..1', () => {
  const { songs, genres } = makeLibrary({ size: 400, seed: 88 });
  const vector = tasteVector(88, genres);

  assert(vector && typeof vector === 'object');
  for (const genre of genres) {
    const weight = vector[genre.name];
    assert(Number.isFinite(weight) && weight >= 0 && weight <= 1);
  }

  for (const song of songs) {
    const taste = tasteOf(song, vector);
    assert(
      Number.isFinite(taste) && taste >= 0 && taste <= 1,
      `Expected taste in [0, 1], got ${taste}`
    );
  }
});
