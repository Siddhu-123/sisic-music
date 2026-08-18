import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exponentialInertiaVelocity,
  playbackRateFromAngularVelocity,
  reverseSamples,
} from './VinylAudioEngine.js';

test('varispeed uses signed angular velocity relative to platter speed', () => {
  const nominal = (45 * 2 * Math.PI) / 60;
  assert.equal(playbackRateFromAngularVelocity(nominal, nominal), 1);
  assert.equal(playbackRateFromAngularVelocity(-nominal, nominal), -1);
  assert.equal(playbackRateFromAngularVelocity(nominal * 0.5, nominal, 1.08), 0.54);
  assert.equal(playbackRateFromAngularVelocity(nominal * 20, nominal), 8);
});

test('reverse buffer samples preserve channel order in reverse', () => {
  const actual = [...reverseSamples(new Float32Array([0.1, -0.2, 0.8, 1]))];
  [1, 0.8, -0.2, 0.1].forEach((expected, index) => assert.ok(Math.abs(actual[index] - expected) < 0.000001));
});

test('release inertia exponentially settles at motor speed', () => {
  const initial = -3.4;
  const target = 1;
  assert.ok(Math.abs(exponentialInertiaVelocity(initial, target, 0) - initial) < 1e-9);
  assert.ok(Math.abs(exponentialInertiaVelocity(initial, target, 190) - target) < Math.abs(initial - target));
  assert.ok(Math.abs(exponentialInertiaVelocity(initial, target, 2000) - target) < 0.001);
});
