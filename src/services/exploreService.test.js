import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExploreMixes,
  buildExploreTextMix,
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

test('Explore free-text mix queries the Gemma /query service', async () => {
  const vectors = new Map([['a', { vector: [1, 0] }], ['b', { vector: [0, 1] }], ['c', { vector: [-1, 0] }]]);
  let requestedUrl = '';
  const mix = await buildExploreTextMix('rainy night', { songs, gemmaVectors: vectors }, {
    baseUrl: 'https://gemma.example/api', token: 'test-token', size: 3,
    fetchImpl: async url => {
      requestedUrl = url;
      return { ok: true, json: async () => ({ vector: [0, 1] }) };
    },
  });
  assert.ok(requestedUrl.endsWith('/query'));
  assert.equal(mix.id, 'text-rainy night');
  assert.ok(mix.songs.some(song => song.songKey === 'b'));
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

test('Explore adds Gemma-powered artist, decade, genre, mood, daily and niche mixes only when supplied', () => {
  const vectors = new Map(songs.map((song, index) => [song.songKey || ['a', 'b', 'c'][index], { vector: [index === 0 ? 1 : 0, index === 1 ? 1 : 0, index === 2 ? 1 : 0] }]));
  const withoutGemma = buildExploreMixes(songs);
  assert.ok(!withoutGemma.mixes.some(mix => mix.id === 'niche'));
  const result = buildExploreMixes(songs, { gemmaVectors: vectors, now: Date.parse('2026-10-16T12:00:00Z') });
  assert.ok(result.mixes.some(mix => mix.id === 'niche'));
  assert.ok(result.mixes.some(mix => mix.id.startsWith('daily-')));
  assert.ok(result.mixes.some(mix => mix.id.startsWith('artist-')));
});
