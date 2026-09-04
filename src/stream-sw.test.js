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
