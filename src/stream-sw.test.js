import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function workerContext() {
  const context = {
    URL,
    setTimeout,
    clearTimeout,
    self: {
      addEventListener() {},
      location: { origin: 'https://example.test' },
    },
  };
  vm.createContext(context);
  const source = fs.readFileSync(new URL('../public/stream-sw.js', import.meta.url), 'utf8');
  vm.runInContext(source, context);
  return context;
}

test('stream worker creates a valid Content-Range without reading Drive response headers', () => {
  const context = workerContext();
  assert.equal(
    vm.runInContext('partialContentRange(0, 262143, 9403245)', context),
    'bytes 0-262143/9403245',
  );
  assert.throws(
    () => vm.runInContext('partialContentRange(10, 9, 100)', context),
    /Invalid partial-content byte range/,
  );
});

test('stream ranges preserve full streaming, suffix seeks and reject invalid offsets', () => {
  const context = workerContext();
  const range = value => JSON.parse(vm.runInContext(`JSON.stringify(requestedRange(${JSON.stringify(value)}, 1000))`, context));
  assert.deepEqual(range(null), { start: 0, end: 999 });
  assert.deepEqual(range('bytes=100-'), { start: 100, end: 999 });
  assert.deepEqual(range('bytes=-50'), { start: 950, end: 999 });
  assert.deepEqual(range('bytes=500-2000'), { start: 500, end: 999 });
  for (const value of ['bytes=1000-', 'bytes=50-20', 'bytes=-0', 'bytes=-', 'bytes=0-1,4-5']) assert.equal(range(value), null);
});

test('an expired request cannot clear a newer service-worker token', async () => {
  const context = workerContext();
  vm.runInContext("driveAccessToken = 'new-token'; driveTokenVersion = 'new-version';", context);
  await vm.runInContext("notifyDriveAuthFailure('expired', 'old-version')", context);
  assert.equal(vm.runInContext('driveTokenVersion', context), 'new-version');
  assert.equal(vm.runInContext('Boolean(driveAccessToken)', context), true);
});

test('requestDriveToken waits for throttled background client replies past 350ms', async () => {
  const messages = [];
  const context = {
    URL,
    setTimeout,
    clearTimeout,
    self: {
      addEventListener() {},
      location: { origin: 'https://example.test' },
      clients: {
        async matchAll() {
          return [{
            postMessage(payload) {
              messages.push(payload.type);
            },
          }];
        },
      },
    },
  };
  vm.createContext(context);
  const source = fs.readFileSync(new URL('../public/stream-sw.js', import.meta.url), 'utf8');
  vm.runInContext(source, context);

  const timer = setTimeout(() => {
    vm.runInContext("driveAccessToken = 'woken-token'; tokenWaiters.forEach(resolve => resolve(true));", context);
  }, 450);
  const resolved = await vm.runInContext('requestDriveToken()', context);
  clearTimeout(timer);
  assert.equal(resolved, true);
  assert.ok(messages.includes('SISIC_DRIVE_TOKEN_REQUEST'));
});
