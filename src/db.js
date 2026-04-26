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
  const existing = await db.songs.toArray();
  const existingMap = new Map(existing.map(s => [`${s.artist}|||${s.track}`, s]));

  let added = 0;
  let _updated = 0;

  for (const s of songs) {
    const key = `${s.artist}|||${s.track}`;
    const prev = existingMap.get(key);

    if (!prev) {
      // New song → insert
      await db.songs.add({
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
      added++;
    } else {
      // Existing song → upsert metadata (don't clobber local-only fields)
      const updates = {};
      if (s.album && s.album !== prev.album) updates.album = s.album;
      if (s.playlistName && s.playlistName !== prev.playlistName) updates.playlistName = s.playlistName;
      if ((s.playCount || 0) > (prev.playCount || 0)) updates.playCount = s.playCount;
      // If the incoming data has a driveFileId and we don't, use it
      if (s.driveFileId && !prev.driveFileId) updates.driveFileId = s.driveFileId;

      if (Object.keys(updates).length > 0) {
        await db.songs.update(prev.id, updates);
        _updated++;
      }
    }
  }

  return added;
}

export async function resetLocalDatabase() {
  await db.delete();
  await db.open();
}
