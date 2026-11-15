const MAX_FILE_METADATA_ENTRIES = 128;

let driveAccessToken = '';
let driveTokenVersion = '';
const fileMetadataCache = new Map();
const tokenWaiters = new Set();

function rememberFileMetadata(fileId, metadata) {
  fileMetadataCache.delete(fileId);
  fileMetadataCache.set(fileId, metadata);
  while (fileMetadataCache.size > MAX_FILE_METADATA_ENTRIES) {
    fileMetadataCache.delete(fileMetadataCache.keys().next().value);
  }
  return metadata;
}

async function requestDriveToken() {
  if (driveAccessToken) return true;
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (!clients.length) return false;
  const result = new Promise(resolve => {
    const waiter = tokenAvailable => {
      clearTimeout(timeout);
      tokenWaiters.delete(waiter);
      resolve(tokenAvailable);
    };
    const timeout = setTimeout(() => waiter(false), 1500);
    tokenWaiters.add(waiter);
  });
  clients.forEach(client => client.postMessage({ type: 'SISIC_DRIVE_TOKEN_REQUEST' }));
  return await result;
}

async function notifyDriveAuthFailure(message, failedVersion = driveTokenVersion) {
  // An old in-flight request must not revoke a freshly refreshed token.
  if (failedVersion !== driveTokenVersion) return;
  driveAccessToken = '';
  fileMetadataCache.clear();
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach(client => client.postMessage({
    type: 'SISIC_DRIVE_AUTH_ERROR',
    message,
    tokenVersion: failedVersion,
  }));
}

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.filter(name => name.startsWith('sisic-app-shell-')).map(name => caches.delete(name)));
    fileMetadataCache.clear();
    await self.clients.claim();
  })());
});

function isTrustedMessage(event) {
  if (event.origin && event.origin !== self.location.origin) return false;
  const sourceUrl = event.source?.url;
  if (!sourceUrl) return true;
  try {
    return new URL(sourceUrl).origin === self.location.origin;
  } catch {
    return false;
  }
}

self.addEventListener('message', event => {
  if (!isTrustedMessage(event)) return;
  if (event.data?.type === 'SISIC_DRIVE_TOKEN') {
    if (typeof event.data.accessToken !== 'string') return;
    const nextToken = event.data.accessToken.trim();
    if (!nextToken || nextToken.length > 4096) return;
    const nextVersion = typeof event.data.tokenVersion === 'string'
      ? event.data.tokenVersion.slice(0, 128)
      : '';
    if (nextToken !== driveAccessToken || nextVersion !== driveTokenVersion) {
      fileMetadataCache.clear();
    }
    driveAccessToken = nextToken;
    driveTokenVersion = nextVersion;
    tokenWaiters.forEach(resolve => resolve(Boolean(driveAccessToken)));
    event.source?.postMessage?.({
      type: 'SISIC_DRIVE_TOKEN_READY',
      tokenVersion: driveTokenVersion,
    });
  } else if (event.data?.type === 'SISIC_DRIVE_CLEAR_TOKEN') {
    driveAccessToken = '';
    driveTokenVersion = '';
    fileMetadataCache.clear();
    tokenWaiters.forEach(resolve => resolve(false));
  }
});

function streamFileId(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const streamIndex = parts.lastIndexOf('stream');
  if (streamIndex < 0 || !parts[streamIndex + 1]) return '';
  try { return decodeURIComponent(parts[streamIndex + 1]); } catch { return ''; }
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const streamBase = new URL('./stream/', self.location.href).pathname;
  if (!url.pathname.startsWith(streamBase)) return;
  const fileId = streamFileId(url);
  if (fileId) {
    event.respondWith(streamDriveFile(fileId, event.request));
  }
});

function partialContentRange(start, end, totalSize) {
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || !Number.isSafeInteger(totalSize)
    || start < 0
    || end < start
    || end >= totalSize
  ) {
    throw new Error('Invalid partial-content byte range.');
  }
  return `bytes ${start}-${end}/${totalSize}`;
}

async function streamDriveFile(fileId, request) {
  if (!driveAccessToken && !(await requestDriveToken())) {
    return new Response('Drive connection is not ready.', {
      status: 503,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain',
        'Retry-After': '1',
      },
    });
  }

  try {
    const metadata = await getFileMetadata(fileId, request.signal);
    const rangeHeader = request.headers.get('Range');
    const range = requestedRange(rangeHeader, metadata.size);
    if (!range) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${metadata.size}`, 'Cache-Control': 'no-store' } });
    const { start, end } = range;
    const requestVersion = driveTokenVersion;
    const upstream = await fetchDriveRange(fileId, start, end, request.signal);

    if (!upstream.ok && upstream.status !== 206) {
      const message = await upstream.text();
      if (upstream.status === 401) await notifyDriveAuthFailure(message || 'Google Drive access expired.', requestVersion);
      return streamError(message || `Drive stream failed: ${upstream.status}`, upstream.status, upstream.statusText);
    }

    if (!upstream.body) throw new Error(`Drive returned an empty range for bytes ${start}-${end}.`);
    const contentLength = upstream.headers.get('Content-Length')
      || String(upstream.status === 206 ? end - start + 1 : metadata.size);
    const responseStatus = upstream.status === 206 && rangeHeader ? 206 : 200;
    const responseHeaders = new Headers({
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Length': contentLength,
      'Content-Type': metadata.mimeType || 'audio/mpeg',
    });
    // Google Drive does return Content-Range, but does not expose it to a
    // cross-origin browser fetch. Construct the required header from the
    // request we sent and the verified Drive file size instead.
    if (responseStatus === 206) {
      responseHeaders.set('Content-Range', partialContentRange(start, end, metadata.size));
    }

    return new Response(upstream.body, {
      status: responseStatus,
      statusText: responseStatus === 206 ? 'Partial Content' : 'OK',
      headers: responseHeaders,
    });
  } catch (error) {
    const candidateStatus = Number(error?.status);
    const status = Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus <= 599
      ? candidateStatus
      : 502;
    return streamError(
      error instanceof Error ? error.message : 'Drive stream failed.',
      status,
      status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : 'Bad Gateway',
    );
  }
}

async function getFileMetadata(fileId, signal) {
  const requestVersion = driveTokenVersion;
  const cached = fileMetadataCache.get(fileId);
  if (cached) return rememberFileMetadata(fileId, cached);

  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=size,mimeType`,
    {
      cache: 'no-store',
      signal,
      headers: {
        Authorization: `Bearer ${driveAccessToken}`,
      },
    }
  );

  if (!response.ok) {
    const message = await response.text();
    if (response.status === 401) {
      await notifyDriveAuthFailure(message || 'Google Drive access expired.', requestVersion);
    }
    const error = new Error(message || `Drive metadata failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const MAX_AUDIO_FILE_SIZE_BYTES = 500 * 1024 * 1024;
  const metadata = await response.json();
  const size = Number(metadata.size || 0);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error('Drive file size is unavailable.');
  }
  if (size > MAX_AUDIO_FILE_SIZE_BYTES) {
    throw new Error(`Drive file size (${size} bytes) exceeds maximum supported limit (500MB).`);
  }

  let mimeType = metadata.mimeType || 'audio/mpeg';
  if (mimeType === 'application/octet-stream') {
    mimeType = 'audio/mpeg';
  }

  const normalized = {
    mimeType,
    size,
  };
  if (requestVersion === driveTokenVersion) rememberFileMetadata(fileId, normalized);
  return normalized;
}

function requestedRange(rangeHeader, fileSize) {
  if (!rangeHeader) return { start: 0, end: fileSize - 1 };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, fileSize - suffix), end: fileSize - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : fileSize - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= fileSize || end < start) return null;
  return { start, end: Math.min(end, fileSize - 1) };
}

async function fetchDriveRange(fileId, start, end, signal, attempt = 0) {
  try {
    signal?.throwIfAborted();
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
      {
        cache: 'no-store',
        signal,
        headers: {
          Authorization: `Bearer ${driveAccessToken}`,
          Range: `bytes=${start}-${end}`,
        },
      }
    );
    if (response.status >= 500 && attempt < 2) {
      await response.body?.cancel();
      await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
      return fetchDriveRange(fileId, start, end, signal, attempt + 1);
    }
    return response;
  } catch (error) {
    if (signal?.aborted || error.name === 'AbortError' || attempt >= 2) throw error;
    await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
    return fetchDriveRange(fileId, start, end, signal, attempt + 1);
  }
}

function streamError(message, status, statusText = '') {
  return new Response(message, {
    status,
    statusText,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain',
    },
  });
}
