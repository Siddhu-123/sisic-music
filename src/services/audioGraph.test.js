import test from 'node:test';
import assert from 'node:assert/strict';
import { EQ_FREQUENCIES, EQ_PRESETS } from './audioGraph.js';

test('EQ_FREQUENCIES contains standard 5-band music frequencies', () => {
  assert.strictEqual(EQ_FREQUENCIES.length, 5);
  assert.strictEqual(EQ_FREQUENCIES[0], 60);
  assert.strictEqual(EQ_FREQUENCIES[4], 14000);
});

test('EQ_PRESETS contains valid 5-band gain vectors within +-12dB', () => {
  for (const [key, preset] of Object.entries(EQ_PRESETS)) {
    assert.ok(typeof preset.name === 'string', `${key} has name`);
    assert.strictEqual(preset.gains.length, 5, `${key} has 5 gains`);
    for (const gain of preset.gains) {
      assert.ok(gain >= -12 && gain <= 12, `${key} gain ${gain} within +-12dB`);
    }
  }
});
