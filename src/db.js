import Dexie from 'dexie';
import { asSongRecord, getPlaylistKey, getSongKey } from './songIdentity.js';

export const AUDIO_CACHE_LIMIT_BYTES = 500 * 1024 * 1024;
export const db = new Dexie('SisicMusicDB');

db.version(2).stores({
  songs: '++id, track, artist, album, driveFileId, isDownloaded, playlistName, playCount',
  metadata: 'key',
});

db.version(3).stores({
  songs: '++id, &songKey, track, artist, album, driveFileId, isDownloaded, isCached, playCount, lastPlayedAt, cachedAt',
  playlists: '&playlistKey, name, source',
  playlistSongs: '[playlistKey+songKey], playlistKey, songKey',
  downloadJobs: '&jobId, songKey, status, updatedAt, createdAt',
  metadata: 'key',
}).upgrade(async tx => {
  const songsTable = tx.table('songs');
  const playlistsTable = tx.table('playlists');
  const playlistSongsTable = tx.table('playlistSongs');
  const oldSongs = await songsTable.toArray();

  const bySongKey = new Map();
  const playlistLinks = new Map();

  for (const old of oldSongs) {
    const base = asSongRecord(old);
    const previous = bySongKey.get(base.songKey);
    const candidate = {
      track: base.track,
      artist: base.artist,
      album: base.album || previous?.album || '',
      songKey: base.songKey,
      driveFileId: base.driveFileId || previous?.driveFileId || null,
      isDownloaded: Boolean(base.isDownloaded || previous?.isDownloaded),
      isCached: Boolean(base.isCached || old.blob || previous?.isCached),
      cacheSizeBytes: base.cacheSizeBytes || old.blob?.size || previous?.cacheSizeBytes || 0,
      cachedAt: base.cachedAt || previous?.cachedAt || (old.blob ? Date.now() : null),
      playCount: Math.max(base.playCount || 0, previous?.playCount || 0),
      lastPlayedAt: base.lastPlayedAt || previous?.lastPlayedAt || null,
      dateAdded: base.dateAdded || previous?.dateAdded || Date.now(),
    };
    bySongKey.set(base.songKey, candidate);

    const playlistName = old.playlistName || 'Saved Tracks';
    const playlistKey = getPlaylistKey(playlistName);
    playlistLinks.set(`${playlistKey}|||${base.songKey}`, {
      playlistKey,
      songKey: base.songKey,
      playlistName,
      addedAt: old.dateAdded || Date.now(),
    });
  }

  await songsTable.clear();
  if (bySongKey.size > 0) await songsTable.bulkAdd([...bySongKey.values()]);

  const playlists = new Map();
  for (const link of playlistLinks.values()) {
    playlists.set(link.playlistKey, {
      playlistKey: link.playlistKey,
      name: link.playlistName,
      source: 'spotify',
    });
  }
  if (playlists.size > 0) await playlistsTable.bulkPut([...playlists.values()]);
  if (playlistLinks.size > 0) await playlistSongsTable.bulkPut([...playlistLinks.values()]);
  await tx.table('metadata').put({ key: 'schemaVersion', value: 3 });
});

db.version(4).stores({
  songs: '++id, &songKey, track, artist, album, driveFileId, isDownloaded, isCached, playCount, lastPlayedAt, cachedAt',
  playlists: '&playlistKey, name, source',
  playlistSongs: '[playlistKey+songKey], playlistKey, songKey',
  downloadJobs: '&jobId, songKey, status, updatedAt, createdAt',
  songAudio: '&songKey, cachedAt, cacheSizeBytes, explicit',
  metadata: 'key',
}).upgrade(async tx => {
  const songsTable = tx.table('songs');
  const audioTable = tx.table('songAudio');
  const songs = await songsTable.toArray();

  for (const song of songs) {
    if (!song.blob) {
      if (song.isCached || song.isDownloaded || song.cacheSizeBytes || song.cachedAt) {
        await songsTable.update(song.id, {
          blob: null,
          isDownloaded: false,
          isCached: false,
          cacheSizeBytes: 0,
          cachedAt: null,
        });
      }
      continue;
    }

    const cachedAt = song.cachedAt || Date.now();
    const cacheSizeBytes = song.cacheSizeBytes || song.blob.size || 0;
    let storedAudio = false;

    try {
      const audioData = await song.blob.arrayBuffer();
      await audioTable.put({
        songKey: song.songKey,
        audioData,
        audioMimeType: song.blob.type || 'audio/mpeg',
        cacheSizeBytes: cacheSizeBytes || audioData.byteLength || 0,
        cachedAt,
        explicit: Boolean(song.isDownloaded),
      });
      storedAudio = true;
    } catch (error) {
      console.warn('Dropping legacy cached audio that could not be migrated:', song.songKey, error);
    }

    await songsTable.update(song.id, {
      blob: null,
      isDownloaded: storedAudio ? Boolean(song.isDownloaded) : false,
      isCached: storedAudio,
      cacheSizeBytes: storedAudio ? cacheSizeBytes : 0,
      cachedAt: storedAudio ? cachedAt : null,
    });
  }

  await tx.table('metadata').put({ key: 'schemaVersion', value: 4 });
});

db.version(5).stores({
  songs: '++id, &songKey, track, artist, album, driveFileId, isDownloaded, isCached, playCount, lastPlayedAt, cachedAt',
  playlists: '&playlistKey, name, source, updatedAt',
  playlistSongs: '[playlistKey+songKey], playlistKey, songKey',
  downloadJobs: '&jobId, songKey, status, updatedAt, createdAt',
  songAudio: '&songKey, cachedAt, cacheSizeBytes, explicit',
  metadata: 'key',
}).upgrade(async tx => {
  await tx.table('metadata').put({ key: 'schemaVersion', value: 5 });
});

db.version(6).stores({
  songs: '++id, &songKey, track, artist, album, driveFileId, isDownloaded, isCached, playCount, lastPlayedAt, cachedAt, fileIdentity, importStatus, syncStatus, embeddingStatus',
  playlists: '&playlistKey, name, source, updatedAt',
  playlistSongs: '[playlistKey+songKey], playlistKey, songKey',
  downloadJobs: '&jobId, songKey, status, updatedAt, createdAt',
  songAudio: '&songKey, cachedAt, cacheSizeBytes, explicit',
  importJobs: '&jobId, songKey, status, updatedAt, createdAt, fileIdentity',
  embeddingJobs: '&jobId, songKey, status, updatedAt, createdAt',
  syncOutbox: '&opId, entityType, status, updatedAt, createdAt',
  metadata: 'key',
}).upgrade(async tx => {
  await tx.table('metadata').put({ key: 'schemaVersion', value: 6 });
});

db.version(7).stores({
  songs: '++id, &songKey, track, artist, album, driveFileId, isDownloaded, isCached, playCount, lastPlayedAt, cachedAt, fileIdentity, importStatus, syncStatus, embeddingStatus',
  playlists: '&playlistKey, name, source, updatedAt',
  playlistSongs: '[playlistKey+songKey], playlistKey, songKey',
  downloadJobs: '&jobId, songKey, status, updatedAt, createdAt',
  songAudio: '&songKey, cachedAt, cacheSizeBytes, explicit',
  importJobs: '&jobId, songKey, status, updatedAt, createdAt, fileIdentity',
  embeddingJobs: '&jobId, songKey, status, updatedAt, createdAt',
  syncOutbox: '&opId, entityType, status, updatedAt, createdAt',
  playbackEvents: '&eventId, songKey, eventType, createdAt',
  metadata: 'key',
}).upgrade(async tx => {
  await tx.table('metadata').put({ key: 'schemaVersion', value: 7 });
});

db.version(8).stores({
  songs: '++id, &songKey, track, artist, album, driveFileId, isDownloaded, isCached, playCount, lastPlayedAt, cachedAt, fileIdentity, importStatus, syncStatus, embeddingStatus, coverArtUrl',
  playlists: '&playlistKey, name, source, updatedAt',
  playlistSongs: '[playlistKey+songKey], playlistKey, songKey',
  downloadJobs: '&jobId, songKey, status, updatedAt, createdAt',
  songAudio: '&songKey, cachedAt, cacheSizeBytes, explicit',
  songArt: '&songKey, coverArtUrl, cachedAt',
  songEmbeddings: '&songKey, updatedAt',
  importJobs: '&jobId, songKey, status, updatedAt, createdAt, fileIdentity',
  embeddingJobs: '&jobId, songKey, status, updatedAt, createdAt',
  syncOutbox: '&opId, entityType, status, updatedAt, createdAt',
  playbackEvents: '&eventId, songKey, eventType, createdAt',
  metadata: 'key',
}).upgrade(async tx => {
  await tx.table('metadata').put({ key: 'schemaVersion', value: 8 });
});

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown IndexedDB error.');
}

function completedAudioFileId(job = {}) {
  const fileId = String(job.uploadedFileId || '');
  if (!fileId || fileId.startsWith('queue:') || fileId === String(job.jobFileId || '')) return '';
  return fileId;
}

function normalizeSongInput(input = {}) {
  const song = asSongRecord(input);
  return {
    songKey: song.songKey,
    track: song.track,
    artist: song.artist,
    album: song.album || '',
    description: song.description || '',
    lyrics: song.lyrics || '',
    genre: song.genre || '',
    releaseDate: song.releaseDate || '',
    dateCreated: song.dateCreated || '',
    coverArtUrl: song.coverArtUrl || '',
    metadataStatus: song.metadataStatus || '',
    metadataSource: song.metadataSource || '',
    driveFileId: song.driveFileId || null,
    isDownloaded: Boolean(song.isDownloaded),
    isCached: Boolean(song.isCached),
    cacheSizeBytes: song.cacheSizeBytes || 0,
    cachedAt: song.cachedAt || null,
    playCount: song.playCount || 0,
    lastPlayedAt: song.lastPlayedAt || null,
    dateAdded: song.dateAdded || Date.now(),
    durationSeconds: Number(song.durationSeconds || 0) || null,
    format: song.format || '',
    fileIdentity: song.fileIdentity || '',
    localFileName: song.localFileName || '',
    sourceType: song.sourceType || '',
    driveImportJobId: song.driveImportJobId || '',
    importStatus: song.importStatus || '',
    syncStatus: song.syncStatus || '',
    embeddingStatus: song.embeddingStatus || '',
  };
}

function bestSongMerge(previous, incoming) {
  if (!previous) return incoming;
  return {
    ...previous,
    track: incoming.track || previous.track,
    artist: incoming.artist || previous.artist,
    album: incoming.album || previous.album || '',
    description: incoming.description || previous.description || '',
    lyrics: incoming.lyrics || previous.lyrics || '',
    genre: incoming.genre || previous.genre || '',
    releaseDate: incoming.releaseDate || previous.releaseDate || '',
    dateCreated: incoming.dateCreated || previous.dateCreated || '',
    coverArtUrl: incoming.coverArtUrl || previous.coverArtUrl || '',
    metadataStatus: incoming.metadataStatus || previous.metadataStatus || '',
    metadataSource: incoming.metadataSource || previous.metadataSource || '',
    driveFileId: incoming.driveFileId || previous.driveFileId || null,
    isDownloaded: Boolean(previous.isDownloaded || incoming.isDownloaded),
    isCached: Boolean(previous.isCached || incoming.isCached),
    cacheSizeBytes: previous.cacheSizeBytes || incoming.cacheSizeBytes || 0,
    cachedAt: previous.cachedAt || incoming.cachedAt || null,
    playCount: Math.max(previous.playCount || 0, incoming.playCount || 0),
    lastPlayedAt: previous.lastPlayedAt || incoming.lastPlayedAt || null,
    dateAdded: previous.dateAdded || incoming.dateAdded || Date.now(),
    durationSeconds: previous.durationSeconds || incoming.durationSeconds || null,
    format: previous.format || incoming.format || '',
    fileIdentity: previous.fileIdentity || incoming.fileIdentity || '',
    localFileName: previous.localFileName || incoming.localFileName || '',
    sourceType: previous.sourceType || incoming.sourceType || '',
    driveImportJobId: incoming.driveImportJobId || previous.driveImportJobId || '',
    importStatus: incoming.importStatus || previous.importStatus || '',
    syncStatus: incoming.syncStatus || previous.syncStatus || '',
    embeddingStatus: incoming.embeddingStatus || previous.embeddingStatus || '',
  };
}

function withoutLegacyBlob(song) {
  const copy = { ...song };
  delete copy.blob;
  return copy;
}

function isCachedAudioUsable(audio = {}) {
  const mimeType = String(audio.audioMimeType || '').toLowerCase();
  return Boolean(audio.audioData && (!mimeType || mimeType.startsWith('audio/')));
}

async function putPlaylistMembership(tables, playlistName, songKey, source = 'spotify') {
  if (!playlistName) return false;
  const playlistKey = getPlaylistKey(playlistName);
  await tables.playlists.put({ playlistKey, name: playlistName, source, updatedAt: new Date().toISOString() });
  await tables.playlistSongs.put({
    playlistKey,
    songKey,
    playlistName,
    addedAt: Date.now(),
  });
  return true;
}

export async function requestPersistentStorage() {
  if (navigator.storage?.persist) {
    const granted = await navigator.storage.persist();
    console.log(`Persistent storage ${granted ? 'granted' : 'denied'}`);
    return granted;
  }
  return false;
}

export async function getStorageEstimate() {
  if (navigator.storage?.estimate) {
    const est = await navigator.storage.estimate();
    return {
      usedBytes: est.usage || 0,
      quotaBytes: est.quota || 0,
      usedMB: ((est.usage || 0) / 1024 / 1024).toFixed(1),
      quotaMB: ((est.quota || 0) / 1024 / 1024).toFixed(0),
    };
  }
  return null;
}

export async function upsertSongToDb(input, playlistName = '') {
  const incoming = normalizeSongInput(input);
  return await db.transaction('rw', db.songs, db.playlists, db.playlistSongs, async () => {
    const previous = await db.songs.where('songKey').equals(incoming.songKey).first();
    const merged = bestSongMerge(previous, incoming);
    if (previous) {
      await db.songs.update(previous.id, merged);
    } else {
      await db.songs.add(merged);
    }
    if (playlistName) {
      await putPlaylistMembership(db, playlistName, incoming.songKey, input.source || 'spotify');
    }
    return await db.songs.where('songKey').equals(incoming.songKey).first();
  });
}

function jobTimestamp() {
  return new Date().toISOString();
}

export async function findSongByFileIdentity(fileIdentity) {
  if (!fileIdentity) return null;
  return await db.songs.where('fileIdentity').equals(fileIdentity).first();
}

export async function createImportJob(input = {}) {
  const now = jobTimestamp();
  const job = {
    schemaVersion: 1,
    jobId: input.jobId || crypto.randomUUID(),
    songKey: input.songKey || '',
    fileIdentity: input.fileIdentity || '',
    fileName: input.fileName || '',
    status: input.status || 'waiting',
    progress: Number(input.progress || 0),
    message: input.message || '',
    error: input.error || '',
    createdAt: input.createdAt || now,
    updatedAt: now,
  };
  await db.importJobs.put(job);
  return job;
}

export async function updateImportJob(jobId, updates = {}) {
  const existing = await db.importJobs.get(jobId);
  if (!existing) return null;
  const next = { ...existing, ...updates, updatedAt: jobTimestamp() };
  await db.importJobs.put(next);
  return next;
}

export async function enqueueEmbeddingJob(songInput) {
  const song = asSongRecord(songInput);
  const existing = await db.embeddingJobs.where('songKey').equals(song.songKey).toArray();
  const active = existing.find(job => ['queued', 'processing', 'done'].includes(job.status));
  if (active) return active;
  const now = jobTimestamp();
  const job = {
    schemaVersion: 1,
    jobId: crypto.randomUUID(),
    songKey: song.songKey,
    status: 'queued',
    attempts: 0,
    progress: 0,
    provider: '',
    error: '',
    createdAt: now,
    updatedAt: now,
  };
  await db.transaction('rw', db.embeddingJobs, db.songs, async () => {
    await db.embeddingJobs.put(job);
    const stored = await db.songs.where('songKey').equals(song.songKey).first();
    if (stored) await db.songs.update(stored.id, { embeddingStatus: 'queued' });
  });
  return job;
}

export async function enqueueSyncOutbox(input = {}) {
  const entityKey = input.entityKey || input.songKey || '';
  if (!entityKey) return null;
  const existing = await db.syncOutbox
    .where('entityType').equals(input.entityType || 'song')
    .filter(item => item.entityKey === entityKey && ['queued', 'processing'].includes(item.status))
    .first();
  if (existing) return existing;
  const now = jobTimestamp();
  const operation = {
    schemaVersion: 1,
    opId: crypto.randomUUID(),
    entityType: input.entityType || 'song',
    entityKey,
    payload: input.payload || {},
    status: 'queued',
    attempts: 0,
    error: input.error || '',
    nextAttemptAt: input.nextAttemptAt || '',
    createdAt: now,
    updatedAt: now,
  };
  await db.syncOutbox.put(operation);
  return operation;
}

export async function updateSyncOutbox(opId, updates = {}) {
  const existing = await db.syncOutbox.get(opId);
  if (!existing) return null;
  const next = { ...existing, ...updates, updatedAt: jobTimestamp() };
  await db.syncOutbox.put(next);
  return next;
}

export async function updateSongPipelineStatus(songKey, updates = {}) {
  const song = await db.songs.where('songKey').equals(songKey).first();
  if (!song) return null;
  await db.songs.update(song.id, updates);
  return await db.songs.get(song.id);
}

export async function updateSongMetadataInDb(songKey, updates = {}) {
  const song = await db.songs.where('songKey').equals(songKey).first();
  if (!song) return null;
  const allowedFields = ['artist', 'track', 'album', 'description', 'lyrics', 'genre', 'releaseDate', 'coverArtUrl', 'metadataStatus', 'metadataSource', 'syncStatus'];
  const patch = Object.fromEntries(
    allowedFields
      .filter(field => Object.prototype.hasOwnProperty.call(updates, field))
      .map(field => [field, String(updates[field] || '').trim()]),
  );
  patch.metadataUpdatedAt = new Date().toISOString();
  await db.songs.update(song.id, patch);
  return await db.songs.get(song.id);
}

export async function addSongToPlaylist(songInput, playlistName, source = 'sisic') {
  const song = normalizeSongInput(songInput);
  const cleanName = String(playlistName || '').trim();
  if (!cleanName) throw new Error('Choose a playlist first.');
  return await db.transaction('rw', db.songs, db.playlists, db.playlistSongs, async () => {
    const previous = await db.songs.where('songKey').equals(song.songKey).first();
    const merged = bestSongMerge(previous, song);
    if (previous) {
      await db.songs.update(previous.id, merged);
    } else {
      await db.songs.add(merged);
    }
    await putPlaylistMembership(db, cleanName, song.songKey, source);
    return await db.songs.where('songKey').equals(song.songKey).first();
  });
}

export async function removeSongFromPlaylist(songKeyOrSong, playlistKey) {
  const songKey = typeof songKeyOrSong === 'string' ? songKeyOrSong : getSongKey(songKeyOrSong);
  if (!songKey || !playlistKey) return false;
  await db.playlistSongs.delete([playlistKey, songKey]);
  const remaining = await db.playlistSongs.where('playlistKey').equals(playlistKey).count();
  if (remaining === 0) await db.playlists.delete(playlistKey);
  return true;
}

export async function markSongPlayable(songKeyOrSong, driveFileId) {
  const songKey = typeof songKeyOrSong === 'string' ? songKeyOrSong : getSongKey(songKeyOrSong);
  await db.songs.where('songKey').equals(songKey).modify({ driveFileId });
}

export async function clearSongPlayable(songKeyOrSong) {
  const songKey = typeof songKeyOrSong === 'string' ? songKeyOrSong : getSongKey(songKeyOrSong);
  await db.transaction('rw', db.songs, db.songAudio, async () => {
    await db.songAudio.delete(songKey);
    const song = await db.songs.where('songKey').equals(songKey).first();
    if (!song) return;
    await db.songs.update(song.id, {
      driveFileId: null,
      isDownloaded: false,
      isCached: false,
      cacheSizeBytes: 0,
      cachedAt: null,
      blob: null,
    });
  });
}

export async function touchSongPlayed(songKey) {
  if (!songKey) return;
  const song = await db.songs.where('songKey').equals(songKey).first();
  if (!song) return;
  await db.songs.update(song.id, {
    playCount: (song.playCount || 0) + 1,
    lastPlayedAt: Date.now(),
  });
}

export async function recordPlaybackEvent(event = {}) {
  if (!event?.id) return null;
  const row = { eventId: event.id, ...event };
  await db.playbackEvents.put(row);
  return row;
}

export async function cacheSongBlob(songKey, blob, driveFileId, { explicit = false } = {}) {
  if (!songKey || !blob) return;
  const song = await db.songs.where('songKey').equals(songKey).first();
  if (!song) return;
  const cachedDriveFileId = driveFileId || song.driveFileId || null;
  const audioData = await blob.arrayBuffer();
  const cacheSizeBytes = blob.size || audioData.byteLength || 0;
  const cachedAt = Date.now();
  await db.transaction('rw', db.songs, db.songAudio, async () => {
    await db.songAudio.put({
      songKey,
      audioData,
      audioMimeType: blob.type || 'audio/mpeg',
      cacheSizeBytes,
      cachedAt,
      explicit: Boolean(explicit),
      driveFileId: cachedDriveFileId,
    });
    await db.songs.update(song.id, {
      driveFileId: cachedDriveFileId,
      isDownloaded: Boolean(explicit || song.isDownloaded),
      isCached: true,
      cacheSizeBytes,
      cachedAt,
      blob: null,
    });
  });
}

export async function getCachedSongAudio(songKey, expectedDriveFileId = '') {
  if (!songKey) return null;
  const audio = await db.songAudio.where('songKey').equals(songKey).first();
  if (!isCachedAudioUsable(audio)) return null;
  if (expectedDriveFileId && String(audio.driveFileId || '') !== String(expectedDriveFileId)) return null;
  return {
    blob: new Blob([audio.audioData], { type: audio.audioMimeType || 'audio/mpeg' }),
    hasBlob: true,
    isCached: true,
    cacheSizeBytes: audio.cacheSizeBytes || audio.audioData.byteLength || 0,
    cachedAt: audio.cachedAt || null,
    driveFileId: audio.driveFileId || null,
  };
}

export async function enforceAudioCacheLimit(limitBytes = AUDIO_CACHE_LIMIT_BYTES) {
  const cached = await db.songAudio
    .filter(audio => !audio.explicit)
    .toArray();
  let total = cached.reduce((sum, audio) => sum + (audio.cacheSizeBytes || audio.audioData?.byteLength || 0), 0);
  if (total <= limitBytes) return 0;

  const songs = await db.songs.bulkGet(cached.map(audio => audio.songKey));
  const lastPlayedBySong = new Map(songs.filter(Boolean).map(song => [song.songKey, song.lastPlayedAt || 0]));
  cached.sort((a, b) => {
    const aLastUsed = lastPlayedBySong.get(a.songKey) || a.cachedAt || 0;
    const bLastUsed = lastPlayedBySong.get(b.songKey) || b.cachedAt || 0;
    return aLastUsed - bLastUsed;
  });
  let removed = 0;
  for (const audio of cached) {
    if (total <= limitBytes) break;
    total -= audio.cacheSizeBytes || audio.audioData?.byteLength || 0;
    await db.transaction('rw', db.songAudio, db.songs, async () => {
      await db.songAudio.delete(audio.songKey);
      const song = await db.songs.where('songKey').equals(audio.songKey).first();
      if (song && !song.isDownloaded) {
        await db.songs.update(song.id, {
          isCached: false,
          cacheSizeBytes: 0,
          cachedAt: null,
        });
      }
    });
    removed++;
  }
  return removed;
}

export async function syncLibraryToDb(songs) {
  return await db.transaction('rw', db.songs, db.playlists, db.playlistSongs, db.metadata, async () => {
    let added = 0;
    let updated = 0;
    let playlistLinks = 0;

    for (const raw of songs) {
      const incoming = normalizeSongInput(raw);
      const previous = await db.songs.where('songKey').equals(incoming.songKey).first();
      const merged = bestSongMerge(previous, incoming);
      if (previous) {
        await db.songs.update(previous.id, merged);
        updated++;
      } else {
        await db.songs.add(merged);
        added++;
      }
      if (raw.playlistName) {
        const linked = await putPlaylistMembership(db, raw.playlistName, incoming.songKey, raw.source || 'spotify');
        if (linked) playlistLinks++;
      }
    }

    await db.metadata.put({ key: 'lastSync', value: new Date().toISOString() });
    return { added, updated, playlistLinks, totalSongs: await db.songs.count() };
  });
}

export async function syncPlaylistIndexToDb(playlists = []) {
  if (!Array.isArray(playlists) || playlists.length === 0) return;
  await db.transaction('rw', db.playlists, db.playlistSongs, async () => {
    for (const playlist of playlists) {
      const name = String(playlist.name || '').trim();
      const playlistKey = playlist.playlistKey || getPlaylistKey(name);
      if (!playlistKey || !name || !Array.isArray(playlist.songKeys)) continue;
      await db.playlists.put({
        playlistKey,
        name,
        source: playlist.source || 'sisic',
        updatedAt: playlist.updatedAt || new Date().toISOString(),
      });
      for (const songKey of playlist.songKeys) {
        if (!songKey) continue;
        await db.playlistSongs.put({
          playlistKey,
          songKey,
          playlistName: name,
          addedAt: Date.now(),
        });
      }
    }
  });
}

export async function getPlaylistSnapshotForDrive({ excludePlaylistKeys = [] } = {}) {
  const excluded = new Set(excludePlaylistKeys);
  const [playlistsRaw, links] = await Promise.all([
    db.playlists.toArray(),
    db.playlistSongs.toArray(),
  ]);
  const linksByPlaylist = new Map();
  for (const link of links) {
    if (!link.playlistKey || !link.songKey || excluded.has(link.playlistKey)) continue;
    if (!linksByPlaylist.has(link.playlistKey)) linksByPlaylist.set(link.playlistKey, []);
    linksByPlaylist.get(link.playlistKey).push(link.songKey);
  }
  return playlistsRaw
    .filter(playlist => playlist.playlistKey && !excluded.has(playlist.playlistKey))
    .map(playlist => ({
      playlistKey: playlist.playlistKey,
      name: playlist.name,
      source: playlist.source || 'sisic',
      songKeys: [...new Set(linksByPlaylist.get(playlist.playlistKey) || [])],
      updatedAt: playlist.updatedAt || new Date().toISOString(),
    }))
    .filter(playlist => playlist.songKeys.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function syncDownloadJobsToDb(jobs = [], { replaceSnapshot = false } = {}) {
  if (!replaceSnapshot && !jobs.length) return;
  await db.transaction('rw', db.downloadJobs, db.songs, db.songAudio, async () => {
    if (replaceSnapshot) {
      const remoteJobIds = new Set(jobs.map(job => job?.jobId).filter(Boolean));
      const staleJobIds = (await db.downloadJobs.toArray())
        .map(job => job.jobId)
        .filter(jobId => jobId && !remoteJobIds.has(jobId));
      if (staleJobIds.length) await db.downloadJobs.bulkDelete(staleJobIds);
    }
    const latestJobsBySongKey = new Map();
    const considerLatestJob = job => {
      if (!job?.jobId || !job?.songKey) return;
      const previous = latestJobsBySongKey.get(job.songKey);
      if (!previous || String(job.updatedAt || '') >= String(previous.updatedAt || '')) {
        latestJobsBySongKey.set(job.songKey, job);
      }
    };
    (await db.downloadJobs.toArray()).forEach(considerLatestJob);
    jobs.forEach(considerLatestJob);

    for (const job of jobs) {
      if (!job?.jobId || !job?.songKey) continue;
      await db.downloadJobs.put({
        ...job,
        updatedAt: job.updatedAt || new Date().toISOString(),
      });
    }

    for (const job of latestJobsBySongKey.values()) {
      const uploadedFileId = completedAudioFileId(job);
      if (job.status !== 'done' || !uploadedFileId) continue;
      const song = await db.songs.where('songKey').equals(job.songKey).first();
      const cachedAudio = await db.songAudio.get(job.songKey);
      const cachedFileId = String(cachedAudio?.driveFileId || '');
      const cacheBelongsToUploadedFile = Boolean(cachedAudio && cachedFileId && cachedFileId === uploadedFileId);
      const isReplacement = Boolean(job.replacementForFileId);
      const shouldInvalidateCache = Boolean(cachedAudio && (
        (cachedFileId && !cacheBelongsToUploadedFile)
        || (!cachedFileId && isReplacement)
      ));

      if (shouldInvalidateCache) await db.songAudio.delete(job.songKey);
      else if (cachedAudio && !cachedFileId) {
        // A legacy local-import cache has no provenance, but it is the source
        // file for a first upload. Adopt the uploaded Drive ID so future
        // playback can distinguish it from a later replacement.
        await db.songAudio.update(job.songKey, { driveFileId: uploadedFileId });
      }
      if (song) {
        await db.songs.update(song.id, {
          driveFileId: uploadedFileId,
          ...(shouldInvalidateCache ? {
            isDownloaded: false,
            isCached: false,
            cacheSizeBytes: 0,
            cachedAt: null,
          } : {}),
        });
      }
    }
  });
}

export async function getLibrarySnapshot() {
  try {
    const [songsRaw, playlistsRaw, links, jobsRaw, audioRows, embeddingRows, importJobs, embeddingJobs, syncOutbox, playbackEvents] = await Promise.all([
      db.songs.toArray(),
      db.playlists.toArray(),
      db.playlistSongs.toArray(),
      db.downloadJobs.toArray(),
      db.songAudio.toArray(),
      db.songEmbeddings.toArray(),
      db.importJobs.toArray(),
      db.embeddingJobs.toArray(),
      db.syncOutbox.toArray(),
      db.playbackEvents.toArray(),
    ]);

    const playlistByKey = new Map(playlistsRaw.map(pl => [pl.playlistKey, pl]));
    const audioBySongKey = new Map(audioRows.map(audio => [audio.songKey, audio]));
    const embeddingsBySongKey = new Map(embeddingRows.map(embedding => [embedding.songKey, embedding]));
    const linksBySong = new Map();
    const countsByPlaylist = new Map();
    for (const link of links) {
      if (!linksBySong.has(link.songKey)) linksBySong.set(link.songKey, []);
      linksBySong.get(link.songKey).push(link.playlistKey);
      countsByPlaylist.set(link.playlistKey, (countsByPlaylist.get(link.playlistKey) || 0) + 1);
    }

    const jobsBySong = new Map();
    const jobFileIds = new Set();
    for (const job of jobsRaw) {
      if (job.jobFileId) jobFileIds.add(job.jobFileId);
      const prev = jobsBySong.get(job.songKey);
      if (!prev || String(job.updatedAt || '') > String(prev.updatedAt || '')) {
        jobsBySong.set(job.songKey, job);
      }
    }

    const songs = songsRaw.map(rawSong => {
      const song = withoutLegacyBlob(rawSong);
      const playlistKeys = linksBySong.get(song.songKey) || [];
      const playlistNames = playlistKeys.map(key => playlistByKey.get(key)?.name).filter(Boolean);
      const audio = audioBySongKey.get(song.songKey);
      const embedding = embeddingsBySongKey.get(song.songKey);
      const hasAudio = isCachedAudioUsable(audio);
      const hasJobFileAsDriveFile = Boolean(song.driveFileId && jobFileIds.has(song.driveFileId));
      return {
        ...song,
        driveFileId: hasJobFileAsDriveFile ? null : song.driveFileId,
        hasBlob: hasAudio,
        isDownloaded: Boolean(song.isDownloaded && hasAudio),
        isCached: hasAudio,
        cacheSizeBytes: hasAudio ? (song.cacheSizeBytes || audio?.cacheSizeBytes || 0) : 0,
        cachedAt: hasAudio ? (song.cachedAt || audio?.cachedAt || null) : null,
        playlistKeys,
        playlists: playlistNames,
        playlistName: playlistNames[0] || '',
        downloadJob: jobsBySong.get(song.songKey) || null,
        ...(embedding?.vector?.length === 64 ? {
          vector: embedding.vector,
          embeddingProvider: embedding.provider || '',
          embeddingUpdatedAt: embedding.updatedAt || '',
        } : {}),
      };
    }).sort((a, b) => (a.track || '').localeCompare(b.track || ''));

    const playlists = playlistsRaw
      .map(pl => ({ ...pl, count: countsByPlaylist.get(pl.playlistKey) || 0 }))
      .filter(pl => pl.count > 0)
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      songs,
      playlists,
      downloadJobs: jobsRaw,
      importJobs: importJobs.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))),
      embeddingJobs: embeddingJobs.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))),
      syncOutbox: syncOutbox.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))),
      playbackEvents: playbackEvents.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))),
      error: '',
    };
  } catch (error) {
    console.error('Local music cache failed:', error);
    return { songs: [], playlists: [], downloadJobs: [], importJobs: [], embeddingJobs: [], syncOutbox: [], playbackEvents: [], error: `Local music cache is unavailable: ${errorMessage(error)}` };
  }
}

export async function resetLocalDatabase() {
  await db.delete();
  await db.open();
}

export async function saveSongArtwork(songKey, artworkData = {}) {
  if (!songKey || !db?.songArt) return;
  await db.songArt.put({
    songKey,
    coverArtUrl: artworkData.coverArtUrl || '',
    imageData: artworkData.imageData || null,
    imageMimeType: artworkData.imageMimeType || '',
    album: artworkData.album || '',
    genre: artworkData.genre || '',
    releaseYear: artworkData.releaseYear || null,
    isProcedural: Boolean(artworkData.isProcedural),
    cachedAt: Date.now(),
  });
  if (artworkData.coverArtUrl && db.songs) {
    const existing = await db.songs.where('songKey').equals(songKey).first();
    if (existing) {
      await db.songs.update(existing.id, {
        coverArtUrl: artworkData.coverArtUrl,
        album: artworkData.album || existing.album || '',
      });
    }
  }
}

export async function getStoredSongArtwork(songKey) {
  if (!songKey || !db?.songArt) return null;
  return await db.songArt.get(songKey);
}

export async function saveSongEmbedding(songKey, embeddingData = {}) {
  if (!songKey || !db?.songEmbeddings) return;
  await db.songEmbeddings.put({
    songKey,
    vector: embeddingData.vector || [],
    dimensions: embeddingData.vector?.length || 0,
    tags: embeddingData.tags || [],
    provider: embeddingData.provider || 'sisic-client',
    updatedAt: new Date().toISOString(),
  });
}

export async function getStoredSongEmbedding(songKey) {
  if (!songKey || !db?.songEmbeddings) return null;
  return await db.songEmbeddings.get(songKey);
}

export async function getAllSongEmbeddings() {
  if (!db?.songEmbeddings) return [];
  return await db.songEmbeddings.toArray();
}
