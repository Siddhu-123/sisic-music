import test from 'node:test';
import assert from 'node:assert/strict';
import { getActiveRadio, startRadio, stopRadio } from './infiniteRadio.js';

test('radio registry keeps the active generator until it is stopped', () => {
  const songs = Array.from({ length: 80 }, (_, index) => ({ songKey: `song-${index}`, artist: 'Artist', track: `Track ${index}` }));
  const gemmaVectors = new Map(songs.map(song => [song.songKey, { vector: [1, (Number(song.songKey.slice(5)) + 1) / 100] }]));
  const { songs: initial } = startRadio({ songs, gemmaVectors }, 'song-0');
  const radio = getActiveRadio();

  assert.equal(initial.length, 50);
  assert.ok(radio);
  assert.ok(radio.next());
  radio.observe({ songKey: 'song-1', eventType: 'playback-complete', positionSeconds: 120, durationSeconds: 180 });
  assert.equal(stopRadio(), true);
  assert.equal(getActiveRadio(), null);
  assert.equal(stopRadio(), false);
});
