import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EQ_USER_PRESETS_KEY,
  MAX_PRESET_NAME,
  MAX_USER_PRESETS,
  cleanPresetName,
  loadUserPresets,
  persistUserPresets,
  removeUserPreset,
  sameGains,
  sanitizeUserPresets,
  upsertUserPreset,
} from './eqUserPresets.js';

const gains = value => Array.from({ length: 10 }, () => value);
const memoryStorage = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return { getItem: key => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, value), data };
};

test('stored presets are validated, clamped, de-duplicated and capped', () => {
  const dirty = [
    { name: '  Warm   night ', gains: gains(3) },
    { name: 'warm night', gains: gains(5) },
    { name: 'Loud', gains: gains(50) },
    { name: '', gains: gains(1) },
    { name: 'Short', gains: [1, 2, 3] },
    { name: 'Text gains', gains: gains('4') },
    { name: 'NaN gains', gains: [...gains(1).slice(1), NaN] },
    null,
    'nope',
    { name: 'x'.repeat(200), gains: gains(0) },
  ];
  const clean = sanitizeUserPresets(dirty);
  assert.deepEqual(clean.map(preset => preset.name), ['Warm night', 'Loud', 'x'.repeat(MAX_PRESET_NAME)]);
  assert.deepEqual(clean[1].gains, gains(12));
  assert.deepEqual(sanitizeUserPresets('not an array'), []);
  assert.equal(sanitizeUserPresets(Array.from({ length: 40 }, (_, i) => ({ name: `p${i}`, gains: gains(0) }))).length, MAX_USER_PRESETS);
});

test('loading survives missing, corrupt or throwing storage', () => {
  assert.deepEqual(loadUserPresets(undefined), []);
  assert.deepEqual(loadUserPresets(memoryStorage()), []);
  assert.deepEqual(loadUserPresets(memoryStorage({ [EQ_USER_PRESETS_KEY]: '{oops' })), []);
  assert.deepEqual(loadUserPresets({ getItem() { throw new Error('blocked'); } }), []);
  assert.equal(persistUserPresets({ setItem() { throw new Error('full'); } }, []), false);
  const storage = memoryStorage();
  assert.equal(persistUserPresets(storage, [{ name: 'A', gains: gains(1) }]), true);
  assert.deepEqual(loadUserPresets(storage), [{ name: 'A', gains: gains(1) }]);
});

test('saving adds, replaces by name, and reports problems instead of throwing', () => {
  let presets = [];
  ({ presets } = upsertUserPreset(presets, 'Bass night', gains(2)));
  ({ presets } = upsertUserPreset(presets, 'bass NIGHT', gains(4)));
  assert.equal(presets.length, 1);
  assert.deepEqual(presets[0].gains, gains(4));
  assert.equal(upsertUserPreset(presets, '   ', gains(1)).error, 'Give the preset a name.');
  assert.match(upsertUserPreset(presets, 'Bad', [1, 2]).error, /could not be saved/);
  const full = Array.from({ length: MAX_USER_PRESETS }, (_, i) => ({ name: `p${i}`, gains: gains(0) }));
  assert.match(upsertUserPreset(full, 'one more', gains(1)).error, /up to 12/);
  assert.equal(upsertUserPreset(full, 'P3', gains(1)).presets.length, MAX_USER_PRESETS, 'replacing is allowed when full');
  assert.deepEqual(removeUserPreset(presets, 'BASS night'), []);
  assert.equal(cleanPresetName('a\u0000b\n c'), 'a b c');
});

test('gain comparison ignores float noise but not real differences', () => {
  assert.equal(sameGains(gains(1), gains(1.0004)), true);
  assert.equal(sameGains(gains(1), gains(1.5)), false);
  assert.equal(sameGains(gains(1), [1]), false);
});
