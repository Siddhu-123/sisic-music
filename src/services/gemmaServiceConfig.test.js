import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearGemmaServiceToken,
  GEMMA_SERVICE_CONFIG_KEY,
  gemmaServiceStatusText,
  getGemmaServiceConfig,
  runSavedGemmaServiceSync,
  saveGemmaServiceConfig,
} from './gemmaServiceConfig.js';

function withStorage(run, initial = {}) {
  const values = new Map(Object.entries(initial));
  const original = globalThis.window;
  globalThis.window = { localStorage: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  } };
  try { return run(values); } finally {
    if (original === undefined) delete globalThis.window;
    else globalThis.window = original;
  }
}

test('Gemma service config round-trips only the base URL and token', () => withStorage(() => {
  assert.deepEqual(saveGemmaServiceConfig({ baseUrl: 'https://my-service.example/api', token: 'secret' }), {
    baseUrl: 'https://my-service.example/api', token: 'secret',
  });
  assert.deepEqual(getGemmaServiceConfig(), { baseUrl: 'https://my-service.example/api', token: 'secret' });
  assert.equal(clearGemmaServiceToken(), true);
  assert.deepEqual(getGemmaServiceConfig(), { baseUrl: 'https://my-service.example/api', token: '' });
}));

test('Gemma service config tolerates corrupt or inaccessible storage', () => {
  withStorage(values => {
    values.set(GEMMA_SERVICE_CONFIG_KEY, '{bad json');
    assert.equal(getGemmaServiceConfig(), null);
  });
  const original = globalThis.window;
  globalThis.window = { get localStorage() { throw new Error('blocked'); } };
  try {
    assert.equal(getGemmaServiceConfig(), null);
    assert.equal(saveGemmaServiceConfig({ token: 'secret' }), null);
    assert.equal(clearGemmaServiceToken(), false);
  } finally {
    if (original === undefined) delete globalThis.window;
    else globalThis.window = original;
  }
});

test('saved-config sync passes the stored URL and token to the sync function and reports counts', async () => {
  const values = new Map();
  const original = globalThis.window;
  globalThis.window = { localStorage: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  } };
  try {
    await assert.rejects(runSavedGemmaServiceSync({ sync: async () => ({}) }), /Save a service URL and token first/);
    saveGemmaServiceConfig({ baseUrl: 'https://my-service.example', token: 'secret' });
    const calls = [];
    let synced = 0;
    const songs = [{ songKey: 'a' }];
    const status = await runSavedGemmaServiceSync({
      librarySongs: songs,
      onSynced: async () => { synced += 1; },
      sync: async args => { calls.push(args); return { cursor: '9', imported: 3, unmatched: 1, skipped: 0 }; },
    });
    assert.deepEqual(calls, [{ baseUrl: 'https://my-service.example', token: 'secret', librarySongs: songs }]);
    assert.equal(synced, 1);
    assert.equal(status.imported, 3);
    assert.match(gemmaServiceStatusText(status), /3 imported · 1 unmatched · 0 skipped/);
    assert.equal(gemmaServiceStatusText(null), 'Not synced yet.');
  } finally {
    if (original === undefined) delete globalThis.window;
    else globalThis.window = original;
  }
});
