import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EQ_CURVE_FREQUENCIES,
  EQ_FREQUENCIES,
  EQ_MAX_GAIN,
  EQ_MIN_GAIN,
  EQ_PRESETS,
  LEGACY_EQ_FREQUENCIES,
  LEGACY_PRESET_GAINS,
  biquadCoefficients,
  biquadMagnitudeDb,
  clampGain,
  createSoftLimiterCurve,
  eqResponseDb,
  headroomDb,
  migrateGains,
  resampleGains,
} from './eqMath.js';

const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message || ''} expected ${expected}, got ${actual}`);
const flat = () => EQ_FREQUENCIES.map(() => 0);

test('a peaking band gives exactly its gain at its centre and nothing far away', () => {
  for (const sampleRate of [44100, 48000]) {
    for (const gain of [-12, -4.5, 3, 12]) {
      const filter = biquadCoefficients('peaking', 1000, gain, 1.41, sampleRate);
      near(biquadMagnitudeDb(filter, 1000, sampleRate), gain, 0.01, `centre ${gain} dB @${sampleRate}`);
      near(biquadMagnitudeDb(filter, 30, sampleRate), 0, 0.5, 'far below');
      near(biquadMagnitudeDb(filter, 15000, sampleRate), 0, 0.5, 'far above');
    }
  }
});

test('shelves reach their full gain on the shelf side and none on the other', () => {
  const low = biquadCoefficients('lowshelf', 200, 8);
  near(biquadMagnitudeDb(low, 20), 8, 0.2, 'low shelf, deep bass');
  near(biquadMagnitudeDb(low, 8000), 0, 0.2, 'low shelf, treble');
  const high = biquadCoefficients('highshelf', 4000, -6);
  near(biquadMagnitudeDb(high, 20000), -6, 0.5, 'high shelf, top');
  near(biquadMagnitudeDb(high, 200), 0, 0.2, 'high shelf, bass');
  assert.throws(() => biquadCoefficients('notch', 1000, 0), /Unsupported/);
});

test('flat sliders are exactly flat and need no headroom', () => {
  assert.ok(eqResponseDb(flat()).every(value => Math.abs(value) < 1e-9));
  assert.equal(headroomDb(flat()), 0);
});

test('headroom cancels the strongest boost so a full-scale track cannot clip', () => {
  for (const gains of [EQ_FREQUENCIES.map(() => 6), [9, 0, 0, 0, 0, 0, 0, 0, 0, 0], EQ_PRESETS.bass_boost.gains, EQ_PRESETS.electronic.gains]) {
    const cut = headroomDb(gains);
    assert.ok(cut < 0);
    const peak = Math.max(...eqResponseDb(gains)) + cut;
    assert.ok(peak <= 0.1 && peak > -0.2, `peak after headroom ${peak}`);
  }
  // Cuts alone never need headroom.
  assert.equal(headroomDb(EQ_FREQUENCIES.map(() => -5)), 0);
  // Adjacent boosts overlap and add up, so it is more than the biggest single slider.
  assert.ok(headroomDb(EQ_FREQUENCIES.map(() => 6)) < -6);
});

test('the shipped presets are valid, and converting the old five-band ones keeps their sound', () => {
  assert.equal(EQ_FREQUENCIES.length, 10);
  assert.deepEqual(Object.keys(EQ_PRESETS), ['flat', 'bass_boost', 'electronic', 'acoustic', 'vocal', 'treble_boost', 'rock']);
  for (const [key, preset] of Object.entries(EQ_PRESETS)) {
    assert.equal(preset.gains.length, EQ_FREQUENCIES.length, key);
    assert.ok(preset.gains.every(gain => gain >= EQ_MIN_GAIN && gain <= EQ_MAX_GAIN && Number.isInteger(gain * 2)), `${key} gains are legal, half-dB steps`);
    const old = eqResponseDb(LEGACY_PRESET_GAINS[key], EQ_CURVE_FREQUENCIES, { bandFrequencies: LEGACY_EQ_FREQUENCIES, q: 1 });
    const now = eqResponseDb(preset.gains);
    const rms = Math.sqrt(old.reduce((sum, value, i) => sum + ((value - now[i]) ** 2), 0) / old.length);
    const worst = Math.max(...old.map((value, i) => Math.abs(value - now[i])));
    // A ten-band layout cannot copy shelves centred at 60 Hz and 14 kHz exactly; it stays close.
    assert.ok(rms < 0.6, `${key} rms error ${rms.toFixed(2)} dB`);
    assert.ok(worst < 2, `${key} worst error ${worst.toFixed(2)} dB`);
  }
});

test('saved settings from any layout are migrated instead of being wiped', () => {
  assert.deepEqual(migrateGains([0, 0, 0, 0, 0]), flat());
  assert.deepEqual(migrateGains(null), flat());
  assert.deepEqual(migrateGains([1, 2, 3]), flat(), 'an unknown length is not guessed');
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 20];
  assert.deepEqual(migrateGains(ten), [1, 2, 3, 4, 5, 6, 7, 8, 9, 12], 'ten bands pass through, clamped');

  // A customised old curve keeps its shape: bass up, treble down.
  const migrated = migrateGains([6, 3, 0, -3, -6]);
  assert.equal(migrated.length, 10);
  assert.ok(migrated[0] > 3 && migrated[9] < -3 && migrated[0] > migrated[5] && migrated[5] > migrated[9]);
  assert.equal(migrateGains(LEGACY_PRESET_GAINS.rock).join(), EQ_PRESETS.rock.gains.join());
});

test('gain input is clamped and never NaN', () => {
  assert.equal(clampGain(99), 12);
  assert.equal(clampGain(-99), -12);
  assert.equal(clampGain('abc'), 0);
  assert.equal(clampGain(undefined), 0);
});

test('resampling follows log frequency and holds the ends flat', () => {
  const out = resampleGains([0, 10], [100, 10000], [10, 100, 1000, 10000, 20000]);
  assert.deepEqual(out.map(value => Math.round(value * 100) / 100), [0, 0, 5, 10, 10]);
});

test('the soft limiter is transparent below its knee and never reaches full scale', () => {
  const curve = createSoftLimiterCurve(4097, 0.891);
  const at = x => curve[Math.round(((x + 1) / 2) * (curve.length - 1))];
  for (const x of [-0.8, -0.5, -0.1, 0, 0.3, 0.7, 0.89]) near(at(x), x, 1e-3, `identity at ${x}`);
  assert.ok(Math.max(...curve) < 0.98 && Math.min(...curve) > -0.98);
  for (let i = 1; i < curve.length; i++) assert.ok(curve[i] >= curve[i - 1], 'monotonic');
  near(curve[0], -curve[curve.length - 1], 1e-9, 'odd symmetry');
  // Smooth knee: no jump in slope where it starts to bend.
  const slope = (a, b) => (at(b) - at(a)) / (b - a);
  assert.ok(Math.abs(slope(0.85, 0.88) - slope(0.90, 0.93)) < 0.15);
});
