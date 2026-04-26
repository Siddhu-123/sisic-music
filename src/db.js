import Dexie from 'dexie';

export const db = new Dexie('SpotiCloneDB');

db.version(1).stores({
  // track & artist for searching; driveFileId & isDownloaded for storage logic
  songs: '++id, track, artist, album, driveFileId, isDownloaded, playlistName',
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
  const existingKeys = new Set(existing.map(s => `${s.artist}|||${s.track}`));

  const newSongs = songs
    .filter(s => !existingKeys.has(`${s.artist}|||${s.track}`))
    .map(s => ({
      track: s.track || s.name || 'Unknown Track',
      artist: s.artist || 'Unknown Artist',
      album: s.album || '',
      driveFileId: s.driveFileId || null,
      isDownloaded: false,
      playlistName: s.playlistName || 'Saved Tracks',
      blob: null,
      dateAdded: Date.now(),
    }));

  if (newSongs.length > 0) {
    await db.songs.bulkAdd(newSongs);
  }
  return newSongs.length;
}
