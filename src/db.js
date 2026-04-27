import Dexie from 'dexie';
import { asSongRecord, getPlaylistKey, getSongKey } from './songIdentity';

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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown IndexedDB error.');
}

function normalizeSongInput(input = {}) {
  const song = asSongRecord(input);
  return {
    songKey: song.songKey,
    track: song.track,
    artist: song.artist,
    album: song.album || '',
    driveFileId: song.driveFileId || null,
    isDownloaded: Boolean(song.isDownloaded),
    isCached: Boolean(song.isCached),
    cacheSizeBytes: song.cacheSizeBytes || 0,
    cachedAt: song.cachedAt || null,
    playCount: song.playCount || 0,
    lastPlayedAt: song.lastPlayedAt || null,
    dateAdded: song.dateAdded || Date.now(),
  };
}

function bestSongMerge(previous, incoming) {
  if (!previous) return incoming;
  return {
    ...previous,
    track: incoming.track || previous.track,
    artist: incoming.artist || previous.artist,
    album: incoming.album || previous.album || '',
    driveFileId: incoming.driveFileId || previous.driveFileId || null,
    isDownloaded: Boolean(previous.isDownloaded || incoming.isDownloaded),
    isCached: Boolean(previous.isCached || incoming.isCached),
    cacheSizeBytes: previous.cacheSizeBytes || incoming.cacheSizeBytes || 0,
    cachedAt: previous.cachedAt || incoming.cachedAt || null,
    playCount: Math.max(previous.playCount || 0, incoming.playCount || 0),
    lastPlayedAt: previous.lastPlayedAt || incoming.lastPlayedAt || null,
    dateAdded: previous.dateAdded || incoming.dateAdded || Date.now(),
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
  await tables.playlists.put({ playlistKey, name: playlistName, source });
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

export async function cacheSongBlob(songKey, blob, driveFileId, { explicit = false } = {}) {
  if (!songKey || !blob) return;
  const song = await db.songs.where('songKey').equals(songKey).first();
  if (!song) return;
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
    });
    await db.songs.update(song.id, {
      driveFileId: driveFileId || song.driveFileId || null,
      isDownloaded: Boolean(explicit || song.isDownloaded),
      isCached: true,
      cacheSizeBytes,
      cachedAt,
      blob: null,
    });
  });
}

export async function getCachedSongAudio(songKey) {
  if (!songKey) return null;
  const audio = await db.songAudio.where('songKey').equals(songKey).first();
  if (!isCachedAudioUsable(audio)) return null;
  return {
    blob: new Blob([audio.audioData], { type: audio.audioMimeType || 'audio/mpeg' }),
    hasBlob: true,
    isCached: true,
    cacheSizeBytes: audio.cacheSizeBytes || audio.audioData.byteLength || 0,
    cachedAt: audio.cachedAt || null,
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

export async function syncDownloadJobsToDb(jobs = []) {
  if (!jobs.length) return;
  await db.transaction('rw', db.downloadJobs, db.songs, async () => {
    for (const job of jobs) {
      if (!job?.jobId || !job?.songKey) continue;
      await db.downloadJobs.put({
        ...job,
        updatedAt: job.updatedAt || new Date().toISOString(),
      });
      if (job.status === 'done' && job.uploadedFileId) {
        const song = await db.songs.where('songKey').equals(job.songKey).first();
        if (song) await db.songs.update(song.id, { driveFileId: job.uploadedFileId });
      }
    }
  });
}

export async function getLibrarySnapshot() {
  try {
    const [songsRaw, playlistsRaw, links, jobsRaw, audioRows] = await Promise.all([
      db.songs.toArray(),
      db.playlists.toArray(),
      db.playlistSongs.toArray(),
      db.downloadJobs.toArray(),
      db.songAudio.toArray(),
    ]);

    const playlistByKey = new Map(playlistsRaw.map(pl => [pl.playlistKey, pl]));
    const audioBySongKey = new Map(audioRows.map(audio => [audio.songKey, audio]));
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
      };
    }).sort((a, b) => (a.track || '').localeCompare(b.track || ''));

    const playlists = playlistsRaw
      .map(pl => ({ ...pl, count: countsByPlaylist.get(pl.playlistKey) || 0 }))
      .filter(pl => pl.count > 0)
      .sort((a, b) => a.name.localeCompare(b.name));

    return { songs, playlists, downloadJobs: jobsRaw, error: '' };
  } catch (error) {
    console.error('Local music cache failed:', error);
    return { songs: [], playlists: [], downloadJobs: [], error: `Local music cache is unavailable: ${errorMessage(error)}` };
  }
}

export async function resetLocalDatabase() {
  await db.delete();
  await db.open();
}
