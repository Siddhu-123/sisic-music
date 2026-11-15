/**
 * Pure policies governing playlist Drive sync snapshots and deletion tombstones.
 */

/**
 * Returns playlist keys that have an un-synced ('queued' or 'processing') deletion
 * record in `syncOutbox`. Completed ('done') deletion records have already been
 * flushed to Drive and must not shadow a recreated playlist.
 */
export function activeDeletedPlaylistKeys(syncOutbox = []) {
  const keys = new Set();
  for (const op of syncOutbox || []) {
    if (op?.entityType === 'playlist-delete' && op?.entityKey && op.status !== 'done') {
      keys.add(op.entityKey);
    }
  }
  return keys;
}

/**
 * Builds the canonical Drive playlist index snapshot, preserving intentionally
 * empty playlists while excluding explicitly excluded or pending-delete keys.
 */
export function buildDrivePlaylistSnapshot(
  playlistsRaw = [],
  links = [],
  { excludePlaylistKeys = [], activeDeletedKeys = [] } = {},
) {
  const excluded = new Set(excludePlaylistKeys);
  for (const key of activeDeletedKeys) {
    if (key) excluded.add(key);
  }

  const linksByPlaylist = new Map();
  for (const link of links || []) {
    if (!link?.playlistKey || !link?.songKey || excluded.has(link.playlistKey)) continue;
    if (!linksByPlaylist.has(link.playlistKey)) linksByPlaylist.set(link.playlistKey, []);
    linksByPlaylist.get(link.playlistKey).push(link.songKey);
  }

  return (playlistsRaw || [])
    .filter(playlist => playlist?.playlistKey && String(playlist.name || '').trim() && !excluded.has(playlist.playlistKey))
    .map(playlist => ({
      playlistKey: playlist.playlistKey,
      name: String(playlist.name).trim(),
      source: playlist.source || 'sisic',
      songKeys: [...new Set(linksByPlaylist.get(playlist.playlistKey) || [])],
      updatedAt: playlist.updatedAt || new Date().toISOString(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
