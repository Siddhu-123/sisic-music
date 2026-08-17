const DEFAULT_CHUNK_BYTES = 256 * 1024;

let driveAccessToken = '';
let driveTokenVersion = '';
const fileMetadataCache = new Map();
const tokenWaiters = new Set();

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
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach(client => client.postMessage({
    type: 'SISIC_DRIVE_AUTH_ERROR',
    message,
    tokenVersion: driveTokenVersion,
  }));
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SISIC_DRIVE_TOKEN') {
    driveAccessToken = event.data.accessToken || '';
    driveTokenVersion = event.data.tokenVersion || '';
    tokenWaiters.forEach(resolve => resolve(Boolean(driveAccessToken)));
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
  if (!fileId) return;
  event.respondWith(streamDriveFile(fileId, event.request));
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

    const upstreamBody = await upstream.arrayBuffer();
    const body = sliceRangeBody(upstreamBody, upstream, start, end);
    if (body.byteLength === 0) {
      throw new Error(`Drive returned an empty range for bytes ${start}-${end}.`);
    }
    const actualEnd = start + body.byteLength - 1;
    const responseHeaders = new Headers({
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Length': String(body.byteLength),
      'Content-Range': `bytes ${start}-${actualEnd}/${metadata.size}`,
      'Content-Type': metadata.mimeType || 'audio/mpeg',
    });

    return new Response(body, {
      status: 206,
      statusText: 'Partial Content',
      headers: responseHeaders,
    });
  } catch (error) {
    const status = Number(error?.status) === 401 ? 401 : 502;
    return streamError(error instanceof Error ? error.message : 'Drive stream failed.', status, status === 401 ? 'Unauthorized' : 'Bad Gateway');
  }
}

function sliceRangeBody(buffer, response, requestedStart, requestedEnd) {
  const bytes = new Uint8Array(buffer);
  const requestedLength = requestedEnd - requestedStart + 1;
  const contentRange = response.headers.get('Content-Range') || '';
  const rangeMatch = /^bytes\s+(\d+)-(\d+)\//i.exec(contentRange);
  const upstreamStart = rangeMatch ? Number(rangeMatch[1]) : (response.status === 200 ? 0 : requestedStart);
  const offset = Math.max(0, requestedStart - upstreamStart);
  return bytes.slice(offset, offset + requestedLength);
}

async function getFileMetadata(fileId) {
  const cached = fileMetadataCache.get(fileId);
  if (cached) return cached;

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

  const metadata = await response.json();
  const size = Number(metadata.size || 0);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error('Drive file size is unavailable.');
  }

  let mimeType = metadata.mimeType || 'audio/mpeg';
  if (mimeType === 'application/octet-stream') {
    mimeType = 'audio/mpeg';
  }

  const normalized = {
    mimeType,
    size,
  };
  fileMetadataCache.set(fileId, normalized);
  return normalized;
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
  return {
    start: Math.min(start, fileSize - 1),
    end: Math.min(end, fileSize - 1),
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
