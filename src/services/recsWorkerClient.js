import { buildUpNextRecommendations } from './contextualRecommendationService.js';

let worker;
let workerFactory;
let nextRequestId = 1;
const pending = new Map();
const WORKER_CATALOG_THRESHOLD = 300;

function defaultCreateWorker() {
  return new Worker(new URL('../workers/recsRanker.worker.js', import.meta.url), { type: 'module' });
}

function clearWorker() {
  worker?.terminate?.();
  worker = undefined;
  workerFactory = undefined;
}

function failPending(error) {
  const requests = [...pending.values()];
  pending.clear();
  clearWorker();
  requests.forEach(({ reject }) => reject(error));
}

function getWorker(createWorker) {
  const factory = createWorker || defaultCreateWorker;
  if (worker && workerFactory === factory) return worker;
  if (worker) clearWorker();

  const instance = factory();
  worker = instance;
  workerFactory = factory;
  instance.onmessage = event => {
    const reply = event.data || {};
    const request = pending.get(reply.requestId);
    if (!request) return;
    pending.delete(reply.requestId);
    if (reply.error) request.reject(new Error(reply.error));
    else request.resolve(reply.items || []);
  };
  instance.onerror = event => {
    event.preventDefault?.();
    failPending(event.error || new Error(event.message || 'Recommendations worker failed'));
  };
  instance.onmessageerror = () => failPending(new Error('Could not read recommendations worker response'));
  return instance;
}

function stripNonCloneables(params = {}) {
  const { signal: _signal, getEmbedding: _getEmbedding, sessionSteer: _steer, ...serializable } = params;
  return serializable;
}

/**
 * Compute up-next recommendations off the main thread in a dedicated Web Worker when the
 * catalog is large enough to justify worker messaging overhead (>= 300 tracks).
 */
export async function computeUpNextRecommendationsAsync(params = {}, { createWorker } = {}) {
  const catalogSize = params?.librarySongs?.length || 0;
  const canUseWorker = (typeof Worker !== 'undefined' || Boolean(createWorker))
    && catalogSize >= WORKER_CATALOG_THRESHOLD
    && typeof params?.getEmbedding !== 'function'
    && !params?.sessionSteer;

  if (!canUseWorker) {
    return buildUpNextRecommendations(params);
  }

  const requestId = nextRequestId++;
  try {
    const instance = getWorker(createWorker);
    const items = await new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      try {
        instance.postMessage({ requestId, mode: 'up-next', payload: stripNonCloneables(params) });
      } catch (error) {
        if (worker === instance) failPending(error);
        else {
          pending.delete(requestId);
          reject(error);
        }
      }
    });
    return Array.isArray(items) ? items : [];
  } catch {
    return buildUpNextRecommendations(params);
  }
}
