import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePlaylistMembershipDiff,
  mergeExternalAndNativeEvents,
  mergeLikedSongKeys,
  resolveEffectiveLibrarySongs,
  resolveLibrarySearchSongs,
  resolveSongPlaylistKeys,
  selectCanonicalDriveSongs,
  selectUpcomingQueueItems,
} from './libraryViewModel.js';

describe('libraryViewModel', () => {
  it('preserves fuller dev cache songs when partial Drive scan arrives in dev', () => {
    const devCache = [{ songKey: 'a::1' }, { songKey: 'b::2' }, { songKey: 'c::3' }];
    const partialDrive = [{ songKey: 'a::1' }];
    assert.equal(selectCanonicalDriveSongs(devCache, partialDrive, { isDev: true }).length, 3);
    assert.equal(selectCanonicalDriveSongs(devCache, partialDrive, { isDev: false }).length, 1);
  });

  it('resolves fuller driveIndexSongs in dev when dbSongs lags behind', () => {
    const dbSongs = [{ songKey: 'a::1' }];
    const driveIndexSongs = [{ songKey: 'a::1' }, { songKey: 'b::2' }];
    assert.equal(resolveEffectiveLibrarySongs({ dbSongs, driveIndexSongs, isDev: true }).length, 2);
    assert.equal(resolveEffectiveLibrarySongs({ dbSongs, driveIndexSongs, isDev: false }).length, 1);
  });

  it('merges native and external liked keys without duplicates', () => {
    assert.deepEqual(
      mergeLikedSongKeys(['a::1', 'b::2'], ['b::2', 'c::3', '']),
      ['a::1', 'b::2', 'c::3'],
    );
  });

  it('merges external and native playback events in chronological order', () => {
    const merged = mergeExternalAndNativeEvents(
      [{ songKey: 's1', createdAt: '2026-10-01T10:00:00Z' }],
      [{ songKey: 's2', createdAt: '2026-09-01T10:00:00Z' }],
    );
    assert.deepEqual(merged.map(e => e.songKey), ['s2', 's1']);
  });

  it('includes catalogue matches when universal search runs outside a playlist', () => {
    const ready = [{ songKey: 'r1', track: 'Ready Song', artist: 'Other', driveFileId: 'drv-1' }];
    const browse = [
      ...ready,
      { songKey: 'c1', track: 'Toxic', artist: 'Britney Spears', isCatalogueOnly: true },
      { songKey: 'c2', track: '...Baby One More Time', artist: 'Britney Spears', isCatalogueOnly: true },
    ];
    const results = resolveLibrarySearchSongs({
      searchQuery: 'Britney Spears',
      selectedPlaylistKey: null,
      driveReadySongs: ready,
      browseSongs: browse,
    });
    assert.deepEqual(results.map(s => s.songKey), ['c1', 'c2']);
    assert.deepEqual(
      resolveLibrarySearchSongs({ searchQuery: '', selectedPlaylistKey: null, driveReadySongs: ready, browseSongs: browse }).map(s => s.songKey),
      ['r1'],
    );
  });

  it('scopes search to the selected playlist when inside a playlist view', () => {
    const playlist = [{ songKey: 'p1', track: 'Theme Song', artist: 'Composer' }];
    const browse = [...playlist, { songKey: 'c1', track: 'Toxic', artist: 'Britney Spears', isCatalogueOnly: true }];
    assert.equal(
      resolveLibrarySearchSongs({ searchQuery: 'Britney', selectedPlaylistKey: 'pl-1', playlistSongs: playlist, browseSongs: browse }).length,
      0,
    );
  });

  it('keeps queueIndex track in upcoming items when no currentSong is selected, and excludes it when playing', () => {
    const queue = [{ songKey: 'sky' }, { songKey: 'timeless' }, { songKey: 'blinding' }];
    assert.deepEqual(
      selectUpcomingQueueItems({ queue, queueIndex: 0, currentSong: null }).map(entry => [entry.song.songKey, entry.position]),
      [['sky', 0], ['timeless', 1], ['blinding', 2]],
    );
    assert.deepEqual(
      selectUpcomingQueueItems({ queue, queueIndex: 0, currentSong: queue[0] }).map(entry => [entry.song.songKey, entry.position]),
      [['timeless', 1], ['blinding', 2]],
    );
  });

  it('resolves existing visible playlist membership and computes add/remove diffs', () => {
    const visiblePlaylists = [{ playlistKey: 'bass' }, { playlistKey: 'chill' }];
    const song = { songKey: 'dzyz::chaos', playlistKeys: ['bass', 'listening history', 'bass'] };
    assert.deepEqual(resolveSongPlaylistKeys(song, visiblePlaylists), ['bass']);

    assert.deepEqual(
      computePlaylistMembershipDiff({ initialKeys: ['bass'], selectedKeys: ['chill'] }),
      { toAddKeys: ['chill'], toRemoveKeys: ['bass'] },
    );
    assert.deepEqual(
      computePlaylistMembershipDiff({ initialKeys: ['bass'], selectedKeys: [] }),
      { toAddKeys: [], toRemoveKeys: ['bass'] },
    );
  });
});
