import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { activeDeletedPlaylistKeys, buildDrivePlaylistSnapshot } from './playlistSyncPolicy.js';

describe('playlistSyncPolicy', () => {
  it('preserves empty playlists in Drive sync export snapshot', () => {
    const playlists = [
      { playlistKey: 'empty-mix', name: 'Empty Mix', source: 'sisic', updatedAt: '2026-11-16T00:00:00Z' },
      { playlistKey: 'bass', name: 'Bass', source: 'sisic', updatedAt: '2026-11-16T00:00:00Z' },
    ];
    const links = [{ playlistKey: 'bass', songKey: 'dzyz::chaos' }];
    const snapshot = buildDrivePlaylistSnapshot(playlists, links);
    assert.deepEqual(
      snapshot.map(p => ({ key: p.playlistKey, count: p.songKeys.length })),
      [
        { key: 'bass', count: 1 },
        { key: 'empty-mix', count: 0 },
      ],
    );
  });

  it('ignores done playlist-delete outbox entries and honors active queued/processing deletes', () => {
    const outbox = [
      { entityType: 'playlist-delete', entityKey: 'recreated-after-sync', status: 'done' },
      { entityType: 'playlist-delete', entityKey: 'pending-delete', status: 'queued' },
      { entityType: 'playlist-delete', entityKey: 'inflight-delete', status: 'processing' },
    ];
    const active = activeDeletedPlaylistKeys(outbox);
    assert.equal(active.has('recreated-after-sync'), false);
    assert.equal(active.has('pending-delete'), true);
    assert.equal(active.has('inflight-delete'), true);

    const playlists = [
      { playlistKey: 'recreated-after-sync', name: 'Recreated', updatedAt: '2026-11-16T00:00:00Z' },
      { playlistKey: 'pending-delete', name: 'Pending', updatedAt: '2026-11-16T00:00:00Z' },
    ];
    const snapshot = buildDrivePlaylistSnapshot(playlists, [], { activeDeletedKeys: active });
    assert.deepEqual(snapshot.map(p => p.playlistKey), ['recreated-after-sync']);
  });
});
