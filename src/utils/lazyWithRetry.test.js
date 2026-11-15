import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { importWithRetry, isChunkLoadError } from './lazyWithRetry.js';

describe('lazyWithRetry', () => {
  it('detects stale deployment chunk errors across browser messages', () => {
    assert.equal(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /sisic-music/assets/TasteProfileModal-ANGqR5qg.js')), true);
    assert.equal(isChunkLoadError(new Error('Importing a module script failed.')), true);
    assert.equal(isChunkLoadError(new Error('error loading dynamically imported module')), true);
    assert.equal(isChunkLoadError(Object.assign(new Error('bad'), { name: 'ChunkLoadError' })), true);
    assert.equal(isChunkLoadError(new Error('Regular runtime error')), false);
    assert.equal(isChunkLoadError(null), false);
  });

  it('retries once on transient chunk fetch errors and rethrows persistent ones without retrying logic errors', async () => {
    let calls = 0;
    const recovered = await importWithRetry(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('Failed to fetch dynamically imported module');
      return { ok: true };
    }, { retries: 1, retryDelayMs: 0 });
    assert.deepEqual(recovered, { ok: true });
    assert.equal(calls, 2);

    let nonChunkCalls = 0;
    await assert.rejects(
      importWithRetry(async () => {
        nonChunkCalls += 1;
        throw new Error('Syntax or runtime error');
      }, { retries: 2, retryDelayMs: 0 }),
      /Syntax or runtime error/,
    );
    assert.equal(nonChunkCalls, 1);

    let failedCalls = 0;
    await assert.rejects(
      importWithRetry(async () => {
        failedCalls += 1;
        throw new TypeError('Failed to fetch dynamically imported module');
      }, { retries: 1, retryDelayMs: 0 }),
      /Failed to fetch dynamically imported module/,
    );
    assert.equal(failedCalls, 2);
  });
});
