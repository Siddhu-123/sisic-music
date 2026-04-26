import Dexie from 'dexie';

export const db = new Dexie('SisicMusicDB');

db.version(2).stores({
  // track & artist for searching; driveFileId & isDownloaded for storage logic
  songs: '++id, track, artist, album, driveFileId, isDownloaded, playlistName, playCount',
  metadata: 'key', // For sync timestamps etc.
});

/**
 * Request persistent storage so the browser doesn't evict our 4GB of music.
 * Must be called during a user gesture (button click).
 */
export async function requestPersistentStorage() {
  if (navigator.storage && navigator.storage.persist) {
    const granted = await navigator.storage.persist();
    console.log(`Persistent storage ${granted ? 'granted ✅' : 'denied ❌'}`);
    return granted;
  }
  return false;
}

export async function getStorageEstimate() {
  if (navigator.storage && navigator.storage.estimate) {
    const est = await navigator.storage.estimate();
    return {
      usedMB: ((est.usage || 0) / 1024 / 1024).toFixed(1),
      quotaMB: ((est.quota || 0) / 1024 / 1024).toFixed(0),
    };
  }
  return null;
}

/**
 * Import an array of songs from spotify_data.json into IndexedDB.
 * Won't duplicate songs already in DB (matched by driveFileId or track+artist key).
 */
export async function syncLibraryToDb(songs) {
  // First: deduplicate existing rows (from pre-upsert syncs)
  await deduplicateSongs();

  const existing = await db.songs.toArray();
  const existingMap = new Map(existing.map(s => [`${s.artist}|||${s.track}`, s]));

  let added = 0;
  let _updated = 0;

  for (const s of songs) {
    const key = `${s.artist}|||${s.track}`;
    const prev = existingMap.get(key);

    if (!prev) {
      // New song → insert
      const newId = await db.songs.add({
        track: s.track || s.name || 'Unknown Track',
        artist: s.artist || 'Unknown Artist',
        album: s.album || '',
        driveFileId: s.driveFileId || null,
        isDownloaded: false,
        playlistName: s.playlistName || 'Saved Tracks',
        playCount: s.playCount || 0,
        blob: null,
        dateAdded: Date.now(),
      });
      existingMap.set(key, { id: newId, ...s }); // Prevent duplicate inserts within same batch
      added++;
    } else {
      // Existing song → upsert metadata (don't clobber local-only fields)
      const updates = {};
      if (s.album && s.album !== prev.album) updates.album = s.album;
      if (s.playlistName && s.playlistName !== prev.playlistName) updates.playlistName = s.playlistName;
      if ((s.playCount || 0) > (prev.playCount || 0)) updates.playCount = s.playCount;
      if (s.driveFileId && !prev.driveFileId) updates.driveFileId = s.driveFileId;

      if (Object.keys(updates).length > 0) {
        await db.songs.update(prev.id, updates);
        _updated++;
      }
    }
  }

  return added;
}

/**
 * Remove duplicate song rows (same artist+track), keeping the one with
 * the most useful data (has driveFileId, blob, or highest playCount).
 */
async function deduplicateSongs() {
  const all = await db.songs.toArray();
  const groups = new Map();

  for (const song of all) {
    const key = `${song.artist}|||${song.track}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(song);
  }

  const toDelete = [];
  for (const [, dupes] of groups) {
    if (dupes.length <= 1) continue;

    // Sort: prefer rows with blob > driveFileId > highest playCount > lowest id
    dupes.sort((a, b) => {
      if (a.blob && !b.blob) return -1;
      if (!a.blob && b.blob) return 1;
      if (a.driveFileId && !b.driveFileId) return -1;
      if (!a.driveFileId && b.driveFileId) return 1;
      if ((a.playCount || 0) !== (b.playCount || 0)) return (b.playCount || 0) - (a.playCount || 0);
      return a.id - b.id;
    });

    // Keep first (best), delete rest
    for (let i = 1; i < dupes.length; i++) {
      toDelete.push(dupes[i].id);
    }
  }

  if (toDelete.length > 0) {
    await db.songs.bulkDelete(toDelete);
    console.log(`Dedup: removed ${toDelete.length} duplicate song rows`);
  }
}

export async function resetLocalDatabase() {
  await db.delete();
  await db.open();
}
