const DEFAULT_CHUNK_BYTES = 256 * 1024;
const MAX_RANGE_BYTES = 2 * 1024 * 1024;
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

async function notifyDriveAuthFailure(message) {
  driveAccessToken = '';
  fileMetadataCache.clear();
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach(client => client.postMessage({
    type: 'SISIC_DRIVE_AUTH_ERROR',
    message,
    tokenVersion: driveTokenVersion,
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
  }
});

function streamFileId(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const streamIndex = parts.lastIndexOf('stream');
  if (streamIndex < 0 || !parts[streamIndex + 1]) return '';
  return decodeURIComponent(parts[streamIndex + 1]);
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const fileId = streamFileId(url);
  if (fileId) {
    event.respondWith(streamDriveFile(fileId, event.request));
  }
});

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
    const metadata = await getFileMetadata(fileId);
    const { start, end } = requestedRange(request.headers.get('Range'), metadata.size);
    const upstream = await fetchDriveRange(fileId, start, end);

    if (!upstream.ok && upstream.status !== 206) {
      const message = await upstream.text();
      if (upstream.status === 401) await notifyDriveAuthFailure(message || 'Google Drive access expired.');
      return streamError(message || `Drive stream failed: ${upstream.status}`, upstream.status, upstream.statusText);
    }

    if (!upstream.body) throw new Error(`Drive returned an empty range for bytes ${start}-${end}.`);
    const contentRange = upstream.headers.get('Content-Range');
    const contentLength = upstream.headers.get('Content-Length')
      || String(upstream.status === 206 ? end - start + 1 : metadata.size);
    const responseHeaders = new Headers({
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Length': contentLength,
      'Content-Type': metadata.mimeType || 'audio/mpeg',
    });
    if (contentRange) responseHeaders.set('Content-Range', contentRange);

    return new Response(upstream.body, {
      status: upstream.status === 206 ? 206 : 200,
      statusText: upstream.status === 206 ? 'Partial Content' : 'OK',
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

async function getFileMetadata(fileId) {
  const cached = fileMetadataCache.get(fileId);
  if (cached) return rememberFileMetadata(fileId, cached);

  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=size,mimeType`,
    {
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${driveAccessToken}`,
      },
    }
  );

  if (!response.ok) {
    const message = await response.text();
    if (response.status === 401) {
      await notifyDriveAuthFailure(message || 'Google Drive access expired.');
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
  return rememberFileMetadata(fileId, normalized);
}

function requestedRange(rangeHeader, fileSize) {
  if (!rangeHeader) {
    return {
      start: 0,
      end: Math.min(fileSize - 1, DEFAULT_CHUNK_BYTES - 1),
    };
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) {
    return {
      start: 0,
      end: Math.min(fileSize - 1, DEFAULT_CHUNK_BYTES - 1),
    };
  }

  let start;
  let end;

  if (match[1] === '') {
    const suffixLength = Math.min(Number(match[2] || DEFAULT_CHUNK_BYTES), fileSize);
    start = fileSize - suffixLength;
    end = fileSize - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? start + DEFAULT_CHUNK_BYTES - 1 : Number(match[2]);
  }

  if (!Number.isFinite(start) || start < 0) start = 0;
  if (!Number.isFinite(end) || end < start) end = start + DEFAULT_CHUNK_BYTES - 1;
  if (!Number.isSafeInteger(start)) start = 0;
  if (!Number.isSafeInteger(end)) end = start + DEFAULT_CHUNK_BYTES - 1;
  const boundedStart = Math.min(start, fileSize - 1);
  return {
    start: boundedStart,
    end: Math.min(end, boundedStart + MAX_RANGE_BYTES - 1, fileSize - 1),
  };
}

async function fetchDriveRange(fileId, start, end, attempt = 0) {
  try {
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
      {
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${driveAccessToken}`,
          Range: `bytes=${start}-${end}`,
        },
      }
    );
    if (response.status >= 500 && attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
      return fetchDriveRange(fileId, start, end, attempt + 1);
    }
    return response;
  } catch (error) {
    if (attempt >= 2) throw error;
    await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
    return fetchDriveRange(fileId, start, end, attempt + 1);
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
