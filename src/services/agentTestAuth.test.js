import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_TEST_STORAGE_KEY,
  clearAgentTestSession,
  resolveAgentTestSession,
} from './agentTestAuth.js';

function createMemoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
  };
}

test('resolveAgentTestSession stays disabled when no token is configured', () => {
  const storage = createMemoryStorage();
  const result = resolveAgentTestSession({
    configuredToken: '',
    search: '?test-token=anything',
    storage,
  });
  assert.deepEqual(result, { active: false, matchedFromUrl: false });
  assert.equal(storage.getItem(AGENT_TEST_STORAGE_KEY), null);
});

test('resolveAgentTestSession activates and persists when URL token matches', () => {
  const storage = createMemoryStorage();
  const result = resolveAgentTestSession({
    configuredToken: 'secret-agent-token',
    search: '?foo=1&test-token=secret-agent-token',
    storage,
  });
  assert.deepEqual(result, { active: true, matchedFromUrl: true });
  assert.equal(storage.getItem(AGENT_TEST_STORAGE_KEY), 'secret-agent-token');
});

test('resolveAgentTestSession rejects mismatched URL token', () => {
  const storage = createMemoryStorage();
  const result = resolveAgentTestSession({
    configuredToken: 'secret-agent-token',
    search: '?test-token=wrong-token',
    storage,
  });
  assert.deepEqual(result, { active: false, matchedFromUrl: false });
  assert.equal(storage.getItem(AGENT_TEST_STORAGE_KEY), null);
});

test('resolveAgentTestSession restores active session from storage on reload', () => {
  const storage = createMemoryStorage({ [AGENT_TEST_STORAGE_KEY]: 'secret-agent-token' });
  const result = resolveAgentTestSession({
    configuredToken: 'secret-agent-token',
    search: '',
    storage,
  });
  assert.deepEqual(result, { active: true, matchedFromUrl: false });
});

test('resolveAgentTestSession clears stored session when test-token=clear', () => {
  const storage = createMemoryStorage({ [AGENT_TEST_STORAGE_KEY]: 'secret-agent-token' });
  const result = resolveAgentTestSession({
    configuredToken: 'secret-agent-token',
    search: '?test-token=clear',
    storage,
  });
  assert.deepEqual(result, { active: false, matchedFromUrl: false });
  assert.equal(storage.getItem(AGENT_TEST_STORAGE_KEY), null);
});

test('clearAgentTestSession removes persisted token from storage', () => {
  const storage = createMemoryStorage({ [AGENT_TEST_STORAGE_KEY]: 'secret-agent-token' });
  clearAgentTestSession(storage);
  assert.equal(storage.getItem(AGENT_TEST_STORAGE_KEY), null);
});
