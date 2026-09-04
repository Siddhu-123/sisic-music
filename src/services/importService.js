import {
  createImportJob,
  enqueueEmbeddingJob,
  enqueueSyncOutbox,
  findSongByFileIdentity,
  updateImportJob,
  upsertSongToDb,
} from '../db';
import { asSongRecord } from '../songIdentity';
import { dedupeFileList, extensionFor, isSupportedAudioFile, parseAudioFilename, fileSignature } from '../importIdentity';

let embeddingServicePromise;

function loadEmbeddingService() {
  embeddingServicePromise ||= import('./embeddingService');
  return embeddingServicePromise;
}

async function hashFile(file) {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  return fileSignature(file);
}

async function readAudioMetadata(file) {
  const fallback = parseAudioFilename(file.name);
  if (typeof Audio === 'undefined' || typeof URL === 'undefined') return { ...fallback, durationSeconds: null };
  const url = URL.createObjectURL(file);
  try {
    const metadata = await new Promise(resolve => {
      const audio = new Audio();
      const timeout = window.setTimeout(() => resolve(null), 4000);
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => {
        window.clearTimeout(timeout);
        resolve({ durationSeconds: Number.isFinite(audio.duration) ? audio.duration : null });
      };
      audio.onerror = () => {
        window.clearTimeout(timeout);
        resolve(null);
      };
      audio.src = url;
    });
    return { ...fallback, ...(metadata || {}) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function collectAudioFiles(items = []) {
  const files = [];
  const visitEntry = async entry => {
    if (!entry) return;
    if (entry.isFile) {
      await new Promise(resolve => entry.file(file => { files.push(file); resolve(); }, resolve));
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      const readBatch = () => new Promise(resolve => reader.readEntries(async entries => {
        if (!entries.length) return resolve();
        for (const child of entries) await visitEntry(child);
        await readBatch();
        resolve();
      }, resolve));
      await readBatch();
    }
  };

  for (const item of items) {
    const entry = item?.webkitGetAsEntry?.();
    if (entry) await visitEntry(entry);
    else {
      const file = item?.getAsFile ? item.getAsFile() : item;
      if (file) files.push(file);
    }
  }
  return files.filter(isSupportedAudioFile);
}

export async function importAudioFile(file, { onProgress, driveService = null, driveFolderId = '' } = {}) {
  if (!isSupportedAudioFile(file)) throw new Error(`Unsupported audio format: ${file?.name || 'unknown file'}`);
  const job = await createImportJob({ fileName: file.name, status: 'waiting', progress: 0 });
  const update = updates => updateImportJob(job.jobId, updates);
  try {
    await update({ status: 'importing', progress: 0.1, message: 'Calculating file identity' });
    onProgress?.({ ...job, status: 'importing', progress: 0.1 });
    const fileIdentity = await hashFile(file);
    const duplicate = await findSongByFileIdentity(fileIdentity);
    if (duplicate) {
      await update({ status: 'duplicate', progress: 1, songKey: duplicate.songKey, fileIdentity, message: `Already imported as ${duplicate.track}` });
      return { status: 'duplicate', song: duplicate, jobId: job.jobId };
    }

    await update({ status: 'reading-metadata', progress: 0.35, fileIdentity, message: 'Reading audio metadata' });
    onProgress?.({ ...job, status: 'reading-metadata', progress: 0.35 });
    const metadata = await readAudioMetadata(file);
    const { getEmbeddingProvider } = await loadEmbeddingService();
    const hasEmbeddingProvider = typeof getEmbeddingProvider() === 'function';
    const song = asSongRecord({
      ...metadata,
      album: '',
      fileIdentity,
      localFileName: file.name,
      format: extensionFor(file.name),
      durationSeconds: metadata.durationSeconds,
      sourceType: 'local-import',
      importStatus: 'importing',
      syncStatus: 'queued',
      embeddingStatus: hasEmbeddingProvider ? 'queued' : '',
    });
    await update({ status: 'importing', progress: 0.6, songKey: song.songKey, message: 'Saving import metadata' });
    await upsertSongToDb(song);
    const storedSong = await upsertSongToDb({ ...song, importStatus: 'complete' });
    if (hasEmbeddingProvider) {
      await enqueueEmbeddingJob(storedSong || song);
    }
    await enqueueSyncOutbox({ entityType: 'song', entityKey: song.songKey, songKey: song.songKey, payload: {
      songKey: song.songKey,
      artist: song.artist,
      track: song.track,
      album: song.album,
      fileIdentity,
      localFileName: file.name,
      durationSeconds: song.durationSeconds,
      format: song.format,
      sourceType: 'local-import',
    } });
    let driveJob = null;
    let finalSong = storedSong || song;
    if (driveService && driveFolderId) {
      await update({ status: 'importing', progress: 0.85, message: 'Uploading source to Drive for the Mac worker' });
      onProgress?.({ ...job, status: 'importing', progress: 0.85, message: 'Uploading source to Drive for the Mac worker' });
      driveJob = await driveService.createImportedAudioJob(song, file, driveFolderId);
      finalSong = await upsertSongToDb({ ...finalSong, driveImportJobId: driveJob.jobId, syncStatus: 'queued' });
    }
    const completionMessage = driveJob
      ? 'Imported locally · Queued for Mac upload'
      : 'Imported metadata only · Re-import the source after signing in to queue Mac upload';
    await update({ status: 'complete', progress: 1, message: completionMessage, driveJobId: driveJob?.jobId || '' });
    onProgress?.({ ...job, status: 'complete', progress: 1 });
    return { status: 'complete', song: finalSong, jobId: job.jobId, driveJob };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await update({ status: 'failed', error: message, message });
    onProgress?.({ ...job, status: 'failed', error: message });
    return { status: 'failed', error: message, jobId: job.jobId };
  }
}

export async function importAudioFiles(files, options = {}) {
  const results = [];
  for (const file of dedupeFileList(files)) {
    results.push(await importAudioFile(file, options));
  }
  return results;
}
