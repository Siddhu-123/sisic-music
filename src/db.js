import Dexie from 'dexie';
import { asSongRecord, getPlaylistKey, getSongKey } from './songIdentity.js';
import { parseDurationSeconds } from './services/downloadPolicy.js';

export const db = new Dexie('SisicMusicDB');

const LEGACY_AUDIO_FIELDS = new Set([
  'blob',
  'isDownloaded',
  'isCached',
  'hasBlob',
  'cacheSizeBytes',
  'cachedAt',
  'audioData',
  'audioMimeType',
  'imageData',
  'imageMimeType',
]);

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
  const bySongKey = new Map();
  const playlistLinks = new Map();

  await songsTable.toCollection().each(old => {
    // Read one legacy record at a time and never retain its binary payload in
    // the migration maps. Version 4 drops the payload instead of migrating it.
    const metadataOnly = Object.fromEntries(
      Object.entries(old).filter(([key]) => !LEGACY_AUDIO_FIELDS.has(key)),
    );
    const base = asSongRecord(metadataOnly);
    const previous = bySongKey.get(base.songKey);
    const candidate = {
      track: base.track,
      artist: base.artist,
      album: base.album || previous?.album || '',
      songKey: base.songKey,
      driveFileId: base.driveFileId || previous?.driveFileId || null,
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
  });

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
  // Do not deserialize or copy legacy media. This migration intentionally
  // drops old browser audio instead of moving it into another binary store.
  await songsTable.toCollection().modify(song => {
    LEGACY_AUDIO_FIELDS.forEach(field => delete song[field]);
  });
  await audioTable.clear();
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

// Remove persisted media bytes from existing installations before dropping the
// old stores in version 10. Library metadata, playlists, jobs, and embeddings
// remain intact.
db.version(9).stores({
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
  const songs = tx.table('songs');
  await songs.toCollection().modify(song => {
    LEGACY_AUDIO_FIELDS.forEach(field => delete song[field]);
  });
  await tx.table('songAudio').clear();
  await tx.table('songArt').clear();
  await tx.table('metadata').put({ key: 'schemaVersion', value: 9 });
});

db.version(10).stores({
  songs: '++id, &songKey, track, artist, album, driveFileId, playCount, lastPlayedAt, fileIdentity, importStatus, syncStatus, embeddingStatus, coverArtUrl',
  playlists: '&playlistKey, name, source, updatedAt',
  playlistSongs: '[playlistKey+songKey], playlistKey, songKey',
  downloadJobs: '&jobId, songKey, status, updatedAt, createdAt',
  songEmbeddings: '&songKey, updatedAt',
  importJobs: '&jobId, songKey, status, updatedAt, createdAt, fileIdentity',
  embeddingJobs: '&jobId, songKey, status, updatedAt, createdAt',
  syncOutbox: '&opId, entityType, status, updatedAt, createdAt',
  playbackEvents: '&eventId, songKey, eventType, createdAt',
  metadata: 'key',
}).upgrade(async tx => {
  await tx.table('metadata').put({ key: 'schemaVersion', value: 10 });
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
  const durationSeconds = parseDurationSeconds(song.durationSeconds ?? song.duration)
    || parseDurationSeconds(Number(song.durationMs || 0) / 1000);
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
    playCount: song.playCount || 0,
    lastPlayedAt: song.lastPlayedAt || null,
    dateAdded: song.dateAdded || Date.now(),
    durationSeconds,
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
  const previousWithoutLegacyAudio = Object.fromEntries(
    Object.entries(previous).filter(([key]) => !LEGACY_AUDIO_FIELDS.has(key)),
  );
  return {
    ...previousWithoutLegacyAudio,
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

function withoutLegacyAudioState(song) {
  const copy = { ...song };
  LEGACY_AUDIO_FIELDS.forEach(field => delete copy[field]);
  return copy;
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
  await db.transaction('rw', db.songs, async () => {
    const song = await db.songs.where('songKey').equals(songKey).first();
    if (!song) return;
    await db.songs.update(song.id, {
      driveFileId: null,
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
  await db.transaction('rw', db.downloadJobs, db.songs, async () => {
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
      if (song) {
        await db.songs.update(song.id, { driveFileId: uploadedFileId });
      }
    }
  });
}

export async function getLibrarySnapshot() {
  try {
    const [songsRaw, playlistsRaw, links, jobsRaw, embeddingRows, importJobs, embeddingJobs, syncOutbox, playbackEvents] = await Promise.all([
      db.songs.toArray(),
      db.playlists.toArray(),
      db.playlistSongs.toArray(),
      db.downloadJobs.toArray(),
      db.songEmbeddings.toArray(),
      db.importJobs.toArray(),
      db.embeddingJobs.toArray(),
      db.syncOutbox.toArray(),
      db.playbackEvents.toArray(),
    ]);

    const playlistByKey = new Map(playlistsRaw.map(pl => [pl.playlistKey, pl]));
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
      const song = withoutLegacyAudioState(rawSong);
      const playlistKeys = linksBySong.get(song.songKey) || [];
      const playlistNames = playlistKeys.map(key => playlistByKey.get(key)?.name).filter(Boolean);
      const embedding = embeddingsBySongKey.get(song.songKey);
      const hasJobFileAsDriveFile = Boolean(song.driveFileId && jobFileIds.has(song.driveFileId));
      return {
        ...song,
        driveFileId: hasJobFileAsDriveFile ? null : song.driveFileId,
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
    console.error('Local library read failed:', error);
    return { songs: [], playlists: [], downloadJobs: [], importJobs: [], embeddingJobs: [], syncOutbox: [], playbackEvents: [], error: `Local library is unavailable: ${errorMessage(error)}` };
  }
}

export async function resetLocalDatabase() {
  await db.delete();
  await db.open();
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
