import { buildDevilMix } from './mixEngine.js';

let worker;
let workerFactory;
let nextRequestId = 1;
const pending = new Map();

function defaultCreateWorker() {
  return new Worker(new URL('../workers/devilMix.worker.js', import.meta.url), { type: 'module' });
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
    else request.resolve(reply.songKeys || []);
  };
  instance.onerror = event => {
    event.preventDefault?.();
    failPending(event.error || new Error(event.message || 'Devil mix worker failed'));
  };
  instance.onmessageerror = () => failPending(new Error('Could not read devil mix worker response'));
  return instance;
}

function synchronouslyCompute(context) {
  return buildDevilMix(context);
}

export async function computeDevilMix(context, { createWorker } = {}) {
  if (typeof Worker === 'undefined' && !createWorker) return synchronouslyCompute(context);

  const songsByKey = new Map(context.songs.map(song => [song.songKey, song]));
  const requestId = nextRequestId++;
  try {
    const instance = getWorker(createWorker);
    const songKeys = await new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      try {
        instance.postMessage({ requestId, ...context });
      } catch (error) {
        if (worker === instance) failPending(error);
        else {
          pending.delete(requestId);
          reject(error);
        }
      }
    });
    return songKeys.map(songKey => songsByKey.get(songKey)).filter(Boolean);
  } catch {
    return synchronouslyCompute(context);
  }
}
