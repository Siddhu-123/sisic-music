export const STREAM_WORKER_FILENAME = 'stream-sw.js';

export function getDriveAppBaseUrl(baseUrl = './', locationHref = 'http://localhost/') {
  return new URL(baseUrl || './', locationHref);
}

export function getDriveStreamWorkerUrl(baseUrl = './', locationHref = 'http://localhost/') {
  return new URL(STREAM_WORKER_FILENAME, getDriveAppBaseUrl(baseUrl, locationHref)).toString();
}

export function getDriveAudioStreamUrl(fileId, baseUrl = './', locationHref = 'http://localhost/') {
  if (!fileId) return '';
  return new URL(`stream/${encodeURIComponent(fileId)}`, getDriveAppBaseUrl(baseUrl, locationHref)).toString();
}

export function isDriveStreamWorker(worker, expectedWorkerUrl) {
  if (!worker?.scriptURL || !expectedWorkerUrl) return false;
  try {
    const actual = new URL(worker.scriptURL);
    const expected = new URL(expectedWorkerUrl);
    return actual.origin === expected.origin && actual.pathname === expected.pathname;
  } catch {
    return false;
  }
}

export function isAudioStreamResponse(response) {
  const contentType = String(response?.headers?.get?.('Content-Type') || '').toLowerCase();
  return Boolean(response?.ok && contentType.startsWith('audio/'));
}

export function streamFailureMessage(response) {
  const status = Number(response?.status || 0);
  const contentType = String(response?.headers?.get?.('Content-Type') || '').toLowerCase();
  if (status === 401) {
    return 'Google Drive no longer authorizes this audio stream. Reconnect Drive, then try again.';
  }
  if (status === 403) {
    return 'This Drive account cannot access the audio file. Check its sharing access or prepare the song again.';
  }
  if (status === 404) {
    return 'This Drive audio file is no longer available. Refresh the library or prepare the song again.';
  }
  if (status === 503) {
    return 'Drive streaming is still getting ready. Please try this song again.';
  }
  if (status === 502) {
    return 'Google Drive could not provide this audio stream. Please try again.';
  }
  if (status >= 400) {
    return `Drive streaming failed (${status}). Please try this song again.`;
  }
  if (contentType && !contentType.startsWith('audio/')) {
    return 'The audio stream route returned non-audio content. Reload the app, then try this song again.';
  }
  return 'Google Drive responded, but the browser could not decode this audio file. Re-prepare the song or choose another source.';
}
