const DEFAULT_CHUNK_BYTES = 1024 * 1024;

let driveAccessToken = '';
const fileMetadataCache = new Map();

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SISIC_DRIVE_TOKEN') {
    driveAccessToken = event.data.accessToken || '';
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
  if (!driveAccessToken) {
    return new Response('Drive token is not ready.', {
      status: 401,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain',
      },
    });
  }

  try {
    const metadata = await getFileMetadata(fileId);
    const { start, end } = requestedRange(request.headers.get('Range'), metadata.size);
    const upstream = await fetchDriveRange(fileId, start, end);

    if (!upstream.ok && upstream.status !== 206) {
      const message = await upstream.text();
      return streamError(message || `Drive stream failed: ${upstream.status}`, upstream.status, upstream.statusText);
    }

    const body = await upstream.arrayBuffer();
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
    return streamError(error instanceof Error ? error.message : 'Drive stream failed.', 502, 'Bad Gateway');
  }
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
    throw new Error(message || `Drive metadata failed: ${response.status}`);
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

function fetchDriveRange(fileId, start, end) {
  return fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    {
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${driveAccessToken}`,
        Range: `bytes=${start}-${end}`,
      },
    }
  );
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
