import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeFileList,
  fileSignature,
  isSupportedAudioFile,
  parseAudioFilename,
} from './importIdentity.js';

test('import identity accepts supported audio and rejects unrelated files', () => {
  assert.equal(isSupportedAudioFile({ name: 'Artist - Track.flac' }), true);
  assert.equal(isSupportedAudioFile({ name: 'cover.jpg' }), false);
});

test('import identity parses common artist-track filenames and deduplicates drops', () => {
  assert.deepEqual(parseAudioFilename('Joy Division - Disorder.mp3'), {
    artist: 'Joy Division',
    track: 'Disorder',
  });
  const files = [
    { name: 'song.mp3', size: 10, lastModified: 1 },
    { name: 'song.mp3', size: 10, lastModified: 1 },
    { name: 'song.mp3', size: 11, lastModified: 1 },
  ];
  assert.equal(fileSignature(files[0]), 'song.mp3:10:1');
  assert.equal(dedupeFileList(files).length, 2);
});
