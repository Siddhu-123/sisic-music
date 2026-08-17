import { db, updateSongPipelineStatus } from '../db';

let embeddingProvider = null;

export function setEmbeddingProvider(provider) {
  embeddingProvider = provider || null;
}

export function getEmbeddingProvider() {
  return embeddingProvider;
}

export async function processPendingEmbeddingJobs({ limit = 2, onProgress } = {}) {
  const jobs = await db.embeddingJobs
    .where('status').equals('queued')
    .limit(limit)
    .toArray();
  if (!jobs.length) return { processed: 0, waiting: false };
  if (typeof embeddingProvider !== 'function') {
    return { processed: 0, waiting: true, reason: 'No embedding provider is configured.' };
  }

  let processed = 0;
  for (const job of jobs) {
    const song = await db.songs.where('songKey').equals(job.songKey).first();
    if (!song) continue;
    const attempts = Number(job.attempts || 0) + 1;
    await db.embeddingJobs.update(job.jobId, {
      status: 'processing',
      attempts,
      progress: 0.1,
      updatedAt: new Date().toISOString(),
    });
    await updateSongPipelineStatus(job.songKey, { embeddingStatus: 'processing' });
    onProgress?.({ ...job, status: 'processing', progress: 0.1 });
    try {
      const result = await embeddingProvider({ song, job });
      await db.embeddingJobs.update(job.jobId, {
        status: 'done',
        progress: 1,
        provider: result?.provider || 'custom',
        embeddingId: result?.embeddingId || '',
        error: '',
        updatedAt: new Date().toISOString(),
      });
      await updateSongPipelineStatus(job.songKey, {
        embeddingStatus: 'done',
        embeddingId: result?.embeddingId || '',
      });
      onProgress?.({ ...job, status: 'done', progress: 1 });
      processed++;
    } catch (error) {
      const status = attempts >= 3 ? 'failed' : 'queued';
      await db.embeddingJobs.update(job.jobId, {
        status,
        progress: 0,
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      });
      await updateSongPipelineStatus(job.songKey, { embeddingStatus: status });
      onProgress?.({ ...job, status, progress: 0, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { processed, waiting: false };
}
