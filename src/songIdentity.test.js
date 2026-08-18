import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalAudioFilename,
  compareSongSimilarity,
  findSimilarSongMatch,
  getPlaylistKey,
  getSongKey,
  jobFilePrefix,
  normalizeText,
  tokenSet,
} from './songIdentity.js';

test('normalizes equivalent artist and track names to one song key', () => {
  assert.equal(
    getSongKey({ artist: 'Sai  Abhyankkar', track: 'Aasa Kooda - From "Think Indie"' }),
    'sai abhyankkar::aasa kooda from think indie',
  );
});

test('preserves the stable song key when editable metadata changes', () => {
  assert.equal(getSongKey({ songKey: 'original::identity', artist: 'New Artist', track: 'New Title' }), 'original::identity');
});

test('normalizes playlist names to stable keys', () => {
  assert.equal(getPlaylistKey('My Shazam Tracks'), 'my shazam tracks');
});

test('builds safe canonical filenames', () => {
  assert.equal(
    canonicalAudioFilename({ artist: 'A/B', track: 'C:D?' }),
    'A_B - C_D_.mp3',
  );
});

test('builds stable job file prefixes', () => {
  assert.equal(jobFilePrefix('artist name::track name'), 'sisic-job-artist-name-track-name');
});

test('normalizes punctuation and accents', () => {
  assert.equal(normalizeText('  Cafe & Love!!! '), 'cafe and love');
});

test('keeps video when it is part of a real track title', () => {
  assert.equal(tokenSet('Video Killed the Radio Star', { dropNoise: true }).has('video'), true);
});

test('scores high confidence for the same song with subtitle noise', () => {
  const similarity = compareSongSimilarity(
    { artist: 'Kendrick Lamar, SZA', track: 'All The Stars (with SZA) - From Black Panther' },
    { artist: 'Kendrick Lamar and SZA', track: 'All The Stars' },
  );

  assert.equal(similarity.confidence, 'high');
});

test('returns medium confidence when title looks related but not exact', () => {
  const similarity = compareSongSimilarity(
    { artist: 'SYML', track: "Where's My Love" },
    { artist: 'SYML', track: "Where's My Love Acoustic" },
  );

  assert.equal(similarity.confidence, 'medium');
});

test('finds the best similar candidate', () => {
  const match = findSimilarSongMatch({ artist: 'SYML', track: "Where's My Love" }, [
    { artist: 'Random Artist', track: 'Other Song' },
    { artist: 'SYML', track: "Where's My Love Acoustic" },
  ]);

  assert.equal(match.song.artist, 'SYML');
});
