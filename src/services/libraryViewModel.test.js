import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeExternalAndNativeEvents,
  mergeLikedSongKeys,
  resolveEffectiveLibrarySongs,
  selectCanonicalDriveSongs,
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
});
