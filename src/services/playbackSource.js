import { driveService } from './GoogleDriveService.js';
import { getDriveAppBaseUrl, getDriveStreamWorkerUrl, isAudioStreamResponse, isDriveStreamWorker, streamFailureMessage } from './driveStream.js';

const STREAM_WORKER_READY_TIMEOUT_MS = 5000;
const STREAM_TOKEN_READY_TIMEOUT_MS = 1500;
async function waitForStreamWorker(signal) {
  signal?.throwIfAborted();
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return null;
  const baseUrl = import.meta.env.BASE_URL || './';
  const appBase = getDriveAppBaseUrl(baseUrl, window.location.href);
  const expectedWorkerUrl = getDriveStreamWorkerUrl(baseUrl, window.location.href);
  const currentStreamWorker = () => {
    const controller = navigator.serviceWorker.controller;
    return isDriveStreamWorker(controller, expectedWorkerUrl) ? controller : null;
  };

  const controlledWorker = currentStreamWorker();
  if (controlledWorker) return controlledWorker;

  try {
    const registration = await navigator.serviceWorker.register(expectedWorkerUrl, { scope: appBase.pathname });
    registration.update().catch(() => {});
    if (currentStreamWorker()) return currentStreamWorker();

    return await new Promise(resolve => {
      let settled = false;
      let timeout = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timeout !== null) window.clearTimeout(timeout);
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
        signal?.removeEventListener('abort', finish);
        resolve(currentStreamWorker());
      };
      const onControllerChange = () => {
        if (currentStreamWorker()) finish();
      };
      signal?.addEventListener('abort', finish, { once: true });
      if (signal?.aborted) { finish(); return; }
      timeout = window.setTimeout(finish, STREAM_WORKER_READY_TIMEOUT_MS);
      navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
      navigator.serviceWorker.ready.then(() => {
        if (currentStreamWorker()) finish();
      }).catch(() => {});
      if (currentStreamWorker()) finish();
    });
  } catch {
    return null;
  }
}

async function syncDriveStreamWorkerToken(worker, signal) {
  signal?.throwIfAborted();
  if (!worker || !driveService.isAuthenticated || typeof window === 'undefined') return false;
  const expectedTokenVersion = driveService.tokenVersion;

  return await new Promise(resolve => {
    let settled = false;
    let timeout = null;
    const finish = value => {
      if (settled) return;
      settled = true;
      if (timeout !== null) window.clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener('message', onMessage);
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finish(false);
    const onMessage = event => {
      if (event.data?.type !== 'SISIC_DRIVE_TOKEN_READY') return;
      if (expectedTokenVersion && event.data.tokenVersion !== expectedTokenVersion) return;
      finish(true);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { finish(false); return; }
    navigator.serviceWorker.addEventListener('message', onMessage);
    if (!driveService.syncTokenToServiceWorker(worker)) {
      finish(false);
      return;
    }
    timeout = window.setTimeout(() => finish(false), STREAM_TOKEN_READY_TIMEOUT_MS);
  });
}

async function probeDriveStream(streamUrl, signal) {
  try {
    const response = await fetch(streamUrl, {
      cache: 'no-store',
      signal,
      headers: { Range: 'bytes=0-0' },
    });
    const ready = isAudioStreamResponse(response);
    const message = ready ? '' : streamFailureMessage(response);
    try {
      await response.body?.cancel?.();
    } catch {
      // The response was already consumed or does not expose a cancelable body.
    }
    return { ready, message };
  } catch {
    return {
      ready: false,
      message: 'The Drive stream could not be reached. Check your connection and try again.',
    };
  }
}

export async function resolvePlaybackUrl(song, signal) {
  signal?.throwIfAborted();
  if (!song?.driveFileId) throw new Error(`"${song?.track || 'This song'}" is queued for Mac preparation.`);
  if (!driveService.isAuthenticated) throw Object.assign(new Error('Reconnect Google Drive to continue streaming.'), { name: 'AuthenticationError' });
  const worker = await waitForStreamWorker(signal);
  signal?.throwIfAborted();
  if (!worker) throw new Error('Drive streaming is not ready. Reload the app once, then try again.');
  const streamUrl = driveService.getAudioStreamUrl(song.driveFileId);
  const tokenReady = await syncDriveStreamWorkerToken(worker, signal);
  signal?.throwIfAborted();
  if (!tokenReady) {
    const probe = await probeDriveStream(streamUrl, signal);
    signal?.throwIfAborted();
    if (!probe.ready) throw new Error(probe.message);
  }
  return streamUrl;
}
