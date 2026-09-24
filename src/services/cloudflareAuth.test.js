import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getStoredRefreshToken,
  setStoredRefreshToken,
  clearStoredRefreshToken,
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
