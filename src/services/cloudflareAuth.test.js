import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getStoredRefreshToken,
  setStoredRefreshToken,
  clearStoredRefreshToken,
  exchangeCodeWithWorker,
  refreshAccessTokenWithWorker,
  REFRESH_TOKEN_STORAGE_KEY,
} from './cloudflareAuth.js';

test('manages refresh token in storage safely', () => {
  // Mock localStorage for test environment if not present
  const originalLocalStorage = globalThis.localStorage;
  const store = new Map();
  globalThis.localStorage = {
    getItem: key => store.get(key) || null,
    setItem: (key, val) => store.set(key, String(val)),
    removeItem: key => store.delete(key),
  };

  try {
    assert.equal(getStoredRefreshToken(), null);

    setStoredRefreshToken('test-refresh-token-123');
    assert.equal(getStoredRefreshToken(), 'test-refresh-token-123');
    assert.equal(globalThis.localStorage.getItem(REFRESH_TOKEN_STORAGE_KEY), 'test-refresh-token-123');

    clearStoredRefreshToken();
    assert.equal(getStoredRefreshToken(), null);
  } finally {
    globalThis.localStorage = originalLocalStorage;
  }
});

test('standalone auth worker requests omit credentials and disallowed CORS headers', async () => {
  const prevUrl = globalThis.process.env.VITE_AUTH_WORKER_URL;
  globalThis.process.env.VITE_AUTH_WORKER_URL = 'https://auth.example.workers.dev';
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'tok', expires_in: 3600 }),
    };
  };

  try {
    await exchangeCodeWithWorker('code-123', 'postmessage', { fetchImpl });
    await refreshAccessTokenWithWorker('rt-123', { fetchImpl });
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.init.credentials, 'omit');
      assert.equal(call.init.headers['Cache-Control'], undefined);
      assert.equal(call.init.headers['X-Sisic-SW'], undefined);
      assert.equal(call.init.headers['Content-Type'], 'application/json');
    }
  } finally {
    if (prevUrl === undefined) delete globalThis.process.env.VITE_AUTH_WORKER_URL;
    else globalThis.process.env.VITE_AUTH_WORKER_URL = prevUrl;
  }
});
