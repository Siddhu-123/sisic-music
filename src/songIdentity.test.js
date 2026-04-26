import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalAudioFilename,
  getPlaylistKey,
  getSongKey,
  jobFilePrefix,
  normalizeText,
} from './songIdentity.js';

test('normalizes equivalent artist and track names to one song key', () => {
  assert.equal(
    getSongKey({ artist: 'Sai  Abhyankkar', track: 'Aasa Kooda - From "Think Indie"' }),
    'sai abhyankkar::aasa kooda from think indie',
  );
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
