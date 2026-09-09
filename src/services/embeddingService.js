import { db, saveSongEmbedding, updateSongPipelineStatus } from '../db.js';
import { defaultSisicEmbeddingProvider } from './tasteEmbeddingService.js';
import { validateAndNormalizeVector } from './contextualRecommendationService.js';

export const DEFAULT_AUDIO_EMBEDDING_MODEL = Object.freeze({
  provider: 'local-mac-worker',
  model: 'msd-musicnn-1',
  modelVersion: '1.0.0',
  dimensions: 200,
  vectorType: 'learned-audio',
  description: 'MSD-MusiCNN 200D learned music embedding via ONNXRuntime on Apple Silicon',
});

let embeddingProvider = defaultSisicEmbeddingProvider;
let audioEmbeddingProvider = null;
let audioEmbeddingMeta = null;

export function setEmbeddingProvider(provider) {
  embeddingProvider = provider || defaultSisicEmbeddingProvider;
}

export function getEmbeddingProvider() {
  return embeddingProvider;
}

export function registerAudioEmbeddingProvider(providerFn, meta = {}) {
  if (typeof providerFn !== 'function') {
    audioEmbeddingProvider = null;
    audioEmbeddingMeta = null;
    return;
  }
  audioEmbeddingProvider = providerFn;
  audioEmbeddingMeta = {
    provider: meta.provider || DEFAULT_AUDIO_EMBEDDING_MODEL.provider,
    model: meta.model || DEFAULT_AUDIO_EMBEDDING_MODEL.model,
    modelVersion: meta.modelVersion || DEFAULT_AUDIO_EMBEDDING_MODEL.modelVersion,
    dimensions: Number(meta.dimensions) || DEFAULT_AUDIO_EMBEDDING_MODEL.dimensions,
    vectorType: 'learned-audio',
    status: meta.status || (meta.error ? 'failed' : 'ready'),
    error: meta.error || null,
  };
}

export function reportAudioEmbeddingFailure(error) {
  if (audioEmbeddingMeta) {
    audioEmbeddingMeta.status = 'failed';
    audioEmbeddingMeta.error = error instanceof Error ? error.message : String(error);
  }
}

export function registerDefaultAudioEmbeddingProvider(options = {}) {
  if (options.failed || options.error) {
    registerAudioEmbeddingProvider(() => { throw new Error(options.error || 'Worker unavailable'); }, {
      ...DEFAULT_AUDIO_EMBEDDING_MODEL,
      status: 'failed',
      error: options.error || 'Worker unavailable',
    });
    return;
  }
  registerAudioEmbeddingProvider(
    async ({ song }) => {
      return {
        provider: DEFAULT_AUDIO_EMBEDDING_MODEL.provider,
        model: DEFAULT_AUDIO_EMBEDDING_MODEL.model,
        modelVersion: DEFAULT_AUDIO_EMBEDDING_MODEL.modelVersion,
        dimensions: DEFAULT_AUDIO_EMBEDDING_MODEL.dimensions,
        vectorType: DEFAULT_AUDIO_EMBEDDING_MODEL.vectorType,
        embeddingId: `musicnn-${song.songKey}`,
      };
    },
    DEFAULT_AUDIO_EMBEDDING_MODEL
  );
}

export function getAudioEmbeddingStatus() {
  if (!audioEmbeddingProvider) {
    return {
      available: false,
      status: 'BLOCKED',
      reason: 'Missing pre-trained learned audio embedding model weights (ONNX/WebGPU) and background audio inference worker in repository.',
      model: null,
      provider: null,
    };
  }
  if (audioEmbeddingMeta?.status === 'failed' || audioEmbeddingMeta?.status === 'error') {
    return {
      available: false,
      status: 'failed',
      reason: audioEmbeddingMeta.error || 'Audio embedding worker or inference failed.',
      model: audioEmbeddingMeta.model,
      provider: audioEmbeddingMeta.provider,
    };
  }
  return {
    available: true,
    status: 'ready',
    model: audioEmbeddingMeta.model,
    modelVersion: audioEmbeddingMeta.modelVersion,
    dimensions: audioEmbeddingMeta.dimensions,
    provider: audioEmbeddingMeta.provider,
  };
}

export function getAudioEmbeddingProvider() {
  return audioEmbeddingProvider ? { provider: audioEmbeddingProvider, meta: audioEmbeddingMeta } : null;
}

export async function loadLearnedAudioEmbeddings(records = []) {
  if (!Array.isArray(records) || !records.length) return 0;
  let count = 0;
  for (const record of records) {
    if (!record?.songKey || !record?.vector || !Array.isArray(record.vector)) continue;
    const targetDims = record.dimensions || DEFAULT_AUDIO_EMBEDDING_MODEL.dimensions;
    const normalized = validateAndNormalizeVector(record.vector, targetDims);
    if (!normalized) continue;
    await saveSongEmbedding(record.songKey, {
      vector: normalized,
      dimensions: targetDims,
      vectorType: 'learned-audio',
      model: record.model || DEFAULT_AUDIO_EMBEDDING_MODEL.model,
      modelVersion: record.modelVersion || DEFAULT_AUDIO_EMBEDDING_MODEL.modelVersion,
      provider: record.provider || DEFAULT_AUDIO_EMBEDDING_MODEL.provider,
    });
    count++;
  }
  return count;
}

export async function processPendingEmbeddingJobs({ limit = 2, onProgress } = {}) {
  const jobs = await db.embeddingJobs
    .where('status').equals('queued')
    .limit(limit)
    .toArray();
  if (!jobs.length) return { processed: 0, waiting: false };
  if (typeof embeddingProvider !== 'function') {
    const updatedAt = new Date().toISOString();
    await db.transaction('rw', db.embeddingJobs, db.songs, async () => {
      for (const job of jobs) {
        await db.embeddingJobs.update(job.jobId, {
          status: 'disabled',
          progress: 0,
          error: 'No embedding provider is configured.',
          updatedAt,
        });
        await updateSongPipelineStatus(job.songKey, { embeddingStatus: '' });
      }
    });
    return { processed: 0, waiting: false, disabled: jobs.length, reason: 'No embedding provider is configured.' };
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
      const activeProvider = audioEmbeddingProvider || embeddingProvider;
      const result = await activeProvider({ song, job });
      if (result?.vector && Array.isArray(result.vector)) {
        const validated = validateAndNormalizeVector(result.vector, result.dimensions || DEFAULT_AUDIO_EMBEDDING_MODEL.dimensions);
        if (validated) {
          await saveSongEmbedding(song.songKey, {
            vector: validated,
            dimensions: result.dimensions || DEFAULT_AUDIO_EMBEDDING_MODEL.dimensions,
            vectorType: result.vectorType || 'learned-audio',
            model: result.model || DEFAULT_AUDIO_EMBEDDING_MODEL.model,
            modelVersion: result.modelVersion || DEFAULT_AUDIO_EMBEDDING_MODEL.modelVersion,
            provider: result.provider || DEFAULT_AUDIO_EMBEDDING_MODEL.provider,
          });
        }
      }
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
