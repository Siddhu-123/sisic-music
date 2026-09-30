import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getDriveAudioStreamUrl,
  getDriveStreamWorkerUrl,
  isAudioStreamResponse,
  isDriveStreamWorker,
  streamFailureMessage,
} from './driveStream.js';

function response(status, contentType = '') {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: key => key.toLowerCase() === 'content-type' ? contentType : null },
  };
}

test('Drive stream URLs retain the deployed project path', () => {
  const pageUrl = 'https://example.github.io/sisic-music/';
  assert.equal(
    getDriveStreamWorkerUrl('./', pageUrl),
    'https://example.github.io/sisic-music/stream-sw.js',
  );
  assert.equal(
    getDriveAudioStreamUrl('file / id', './', pageUrl),
    'https://example.github.io/sisic-music/stream/file%20%2F%20id',
  );
});

test('only the current stream worker is accepted for playback', () => {
  const expected = 'https://example.github.io/sisic-music/stream-sw.js';
  assert.equal(isDriveStreamWorker({ scriptURL: `${expected}?revision=2` }, expected), true);
  assert.equal(isDriveStreamWorker({ scriptURL: 'https://example.github.io/sisic-music/sw.js' }, expected), false);
});

test('stream validation accepts audio and explains common failures', () => {
  assert.equal(isAudioStreamResponse(response(206, 'audio/mpeg')), true);
  assert.equal(isAudioStreamResponse(response(200, 'text/html')), false);
  assert.match(streamFailureMessage(response(503, 'text/plain')), /getting ready/i);
  assert.match(streamFailureMessage(response(401, 'text/plain')), /Reconnect Drive/i);
  assert.match(streamFailureMessage(response(403, 'text/plain')), /cannot access/i);
  assert.match(streamFailureMessage(response(200, 'text/html')), /non-audio/i);
});
