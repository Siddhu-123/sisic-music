import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExploreMixes,
  filterExploreSongs,
  getSongGenres,
  getSongMoods,
  rankedExploreSearch,
} from './exploreService.js';

const songs = [
  { songKey: 'a', artist: 'Night Artist', track: 'Midnight Lofi', genre: 'Electronic', playCount: 4 },
  { songKey: 'b', artist: 'Bright Band', track: 'Summer Rock', genre: 'Rock', playCount: 1, driveFileId: 'drive-b' },
  { songKey: 'c', artist: 'Focus Trio', track: 'Piano Study', genre: 'Classical', playCount: 0 },
];

test('Explore facets infer genres and moods from metadata and song text', () => {
  assert.ok(getSongGenres(songs[0]).includes('Electronic'));
  assert.ok(getSongGenres(songs[0]).includes('Ambient'));
  assert.ok(getSongMoods(songs[0]).includes('Chill'));
  assert.ok(getSongMoods(songs[2]).includes('Focus'));
});

test('Explore search ranks title and facet matches and filters streamability', () => {
  assert.equal(rankedExploreSearch('midnight', songs)[0].songKey, 'a');
  assert.equal(rankedExploreSearch('rock', songs)[0].songKey, 'b');
  assert.deepEqual(filterExploreSongs(songs, { availability: 'ready' }).map(song => song.songKey), ['b']);
});

test('Explore mixes are local smart collections and keep not-ready songs visible', () => {
  const result = buildExploreMixes(songs, { likedSongKeys: ['a'] });
  assert.ok(result.mixes.some(mix => mix.id === 'your-taste'));
  assert.ok(result.mixes.some(mix => mix.id === 'not-ready'));
  assert.ok(result.suggestions.length > 0);
});
