let driveAccessToken = '';

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

  const headers = new Headers({
    Authorization: `Bearer ${driveAccessToken}`,
  });
  const range = request.headers.get('Range');
  if (range) headers.set('Range', range);

  const upstream = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    {
      cache: 'no-store',
      headers,
    }
  );

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set('Cache-Control', 'no-store');
  responseHeaders.set('Accept-Ranges', responseHeaders.get('Accept-Ranges') || 'bytes');

  if (!upstream.ok) {
    const message = await upstream.text();
    return new Response(message || `Drive stream failed: ${upstream.status}`, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain',
      },
    });
  }

  if (!responseHeaders.get('Content-Type')) {
    responseHeaders.set('Content-Type', 'audio/mpeg');
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
