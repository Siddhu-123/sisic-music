// Equalizer maths with no Web Audio dependency, so the modal can draw the exact
// response curve, the graph can size its headroom, and everything is unit-testable.
//
// Filter coefficients follow the Web Audio API specification's biquad definitions
// (the same formulas as Robert Bristow-Johnson's Audio EQ Cookbook), so a curve
// computed here matches what BiquadFilterNode.getFrequencyResponse() reports.

// ISO octave centres. Ten bands an octave apart, with shelves at each end.
export const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
// The earlier five-band layout, kept so saved settings can be migrated.
export const LEGACY_EQ_FREQUENCIES = [60, 230, 910, 3600, 14000];

export const EQ_MIN_GAIN = -12;
export const EQ_MAX_GAIN = 12;
export const EQ_GAIN_STEP = 0.5;
// Q of about 1.41 gives each peaking band roughly an octave of bandwidth, so
// neighbouring bands overlap smoothly and a flat slider row is exactly flat.
export const EQ_Q = 1.41;
export const EQ_REFERENCE_SAMPLE_RATE = 48000;

// Log-spaced points used to draw the curve and to find the peak boost.
export const EQ_RESPONSE_POINTS = 96;
const RESPONSE_MIN_HZ = 20;
const RESPONSE_MAX_HZ = 20000;
export const EQ_CURVE_FREQUENCIES = Array.from({ length: EQ_RESPONSE_POINTS }, (_, i) => (
  RESPONSE_MIN_HZ * ((RESPONSE_MAX_HZ / RESPONSE_MIN_HZ) ** (i / (EQ_RESPONSE_POINTS - 1)))
));

export function bandFilterType(index, count = EQ_FREQUENCIES.length) {
  if (index === 0) return 'lowshelf';
  if (index === count - 1) return 'highshelf';
  return 'peaking';
}

export function clampGain(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(EQ_MIN_GAIN, Math.min(EQ_MAX_GAIN, number)) : 0;
}

/** Normalised biquad coefficients (a0 = 1) for a peaking or shelving band. */
export function biquadCoefficients(type, frequency, gainDb, q = EQ_Q, sampleRate = EQ_REFERENCE_SAMPLE_RATE) {
  const A = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * Math.min(frequency, sampleRate / 2 - 1)) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  let b0; let b1; let b2; let a0; let a1; let a2;
  if (type === 'peaking') {
    const alpha = sin / (2 * q);
    b0 = 1 + (alpha * A); b1 = -2 * cos; b2 = 1 - (alpha * A);
    a0 = 1 + (alpha / A); a1 = -2 * cos; a2 = 1 - (alpha / A);
  } else {
    // Shelf slope S = 1, as in the Web Audio specification.
    const alphaS = (sin / 2) * Math.SQRT2;
    const root = 2 * Math.sqrt(A) * alphaS;
    if (type === 'lowshelf') {
      b0 = A * ((A + 1) - ((A - 1) * cos) + root);
      b1 = 2 * A * ((A - 1) - ((A + 1) * cos));
      b2 = A * ((A + 1) - ((A - 1) * cos) - root);
      a0 = (A + 1) + ((A - 1) * cos) + root;
      a1 = -2 * ((A - 1) + ((A + 1) * cos));
      a2 = (A + 1) + ((A - 1) * cos) - root;
    } else if (type === 'highshelf') {
      b0 = A * ((A + 1) + ((A - 1) * cos) + root);
      b1 = -2 * A * ((A - 1) + ((A + 1) * cos));
      b2 = A * ((A + 1) + ((A - 1) * cos) - root);
      a0 = (A + 1) - ((A - 1) * cos) + root;
      a1 = 2 * ((A - 1) - ((A + 1) * cos));
      a2 = (A + 1) - ((A - 1) * cos) - root;
    } else {
      throw new Error(`Unsupported filter type: ${type}`);
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Magnitude of one biquad at `frequency`, in dB. */
export function biquadMagnitudeDb({ b0, b1, b2, a1, a2 }, frequency, sampleRate = EQ_REFERENCE_SAMPLE_RATE) {
  const w = (2 * Math.PI * frequency) / sampleRate;
  const c1 = Math.cos(w); const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w); const s2 = Math.sin(2 * w);
  const numRe = b0 + (b1 * c1) + (b2 * c2);
  const numIm = -((b1 * s1) + (b2 * s2));
  const denRe = 1 + (a1 * c1) + (a2 * c2);
  const denIm = -((a1 * s1) + (a2 * s2));
  const magSq = ((numRe * numRe) + (numIm * numIm)) / ((denRe * denRe) + (denIm * denIm));
  return 10 * Math.log10(Math.max(magSq, 1e-20));
}

/** Combined response of all bands (a cascade, so decibels add), sampled at `frequencies`. */
export function eqResponseDb(gains, frequencies = EQ_CURVE_FREQUENCIES, { bandFrequencies = EQ_FREQUENCIES, q = EQ_Q, sampleRate = EQ_REFERENCE_SAMPLE_RATE } = {}) {
  const filters = bandFrequencies.map((frequency, index) => (
    biquadCoefficients(bandFilterType(index, bandFrequencies.length), frequency, clampGain(gains[index] ?? 0), q, sampleRate)
  ));
  return frequencies.map(frequency => filters.reduce((sum, filter) => sum + biquadMagnitudeDb(filter, frequency, sampleRate), 0));
}

/**
 * How far to turn the whole signal down so the strongest boost of these gains
 * cannot push a full-scale track past 0 dBFS. Returns 0 or a negative number of
 * dB, rounded to 0.1. (Equalizer software calls this the "preamp".)
 */
export function headroomDb(gains, options) {
  const peak = Math.max(...eqResponseDb(gains, EQ_CURVE_FREQUENCIES, options));
  return peak > 0.05 ? -Math.round(peak * 10) / 10 : 0;
}

/** Linear interpolation of a gain curve across log-frequency, holding the end values flat. */
export function resampleGains(gains, fromFrequencies, toFrequencies) {
  const logFrom = fromFrequencies.map(Math.log);
  return toFrequencies.map(frequency => {
    const x = Math.log(frequency);
    if (x <= logFrom[0]) return Number(gains[0]) || 0;
    if (x >= logFrom[logFrom.length - 1]) return Number(gains[gains.length - 1]) || 0;
    let i = 0;
    while (logFrom[i + 1] < x) i += 1;
    const t = (x - logFrom[i]) / (logFrom[i + 1] - logFrom[i]);
    return ((Number(gains[i]) || 0) * (1 - t)) + ((Number(gains[i + 1]) || 0) * t);
  });
}

// `+ 0` turns -0 into 0 so identical settings compare equal.
const roundHalf = value => (Math.round(value * 2) / 2) + 0;

// Solves the small dense system A x = b (Gaussian elimination, partial pivoting).
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    if (Math.abs(M[col][col]) < 1e-12) continue;
    for (let row = col + 1; row < n; row++) {
      const factor = M[row][col] / M[col][col];
      for (let k = col; k <= n; k++) M[row][k] -= factor * M[col][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = M[row][n];
    for (let k = row + 1; k < n; k++) sum -= M[row][k] * x[k];
    x[row] = Math.abs(M[row][row]) < 1e-12 ? 0 : sum / M[row][row];
  }
  return x;
}

// The fit is judged over the whole plotted range, so nothing can overshoot unseen at the extremes.
const FIT_MIN_HZ = 20;
const FIT_MAX_HZ = 20000;

/**
 * Least-squares band gains whose combined response follows `targetDb` (one value
 * per EQ_CURVE_FREQUENCIES point). Overlapping bands add up, so reading the target
 * at each band centre over-boosts; fitting the whole curve (Gauss-Newton with a
 * numerical Jacobian and a small ridge term) does not.
 */
export function fitBandGains(targetDb, { passes = 6, ridge = 1e-3 } = {}) {
  const n = EQ_FREQUENCIES.length;
  const grid = EQ_CURVE_FREQUENCIES.map((frequency, index) => index).filter(index => (
    EQ_CURVE_FREQUENCIES[index] >= FIT_MIN_HZ && EQ_CURVE_FREQUENCIES[index] <= FIT_MAX_HZ
  ));
  const frequencies = grid.map(index => EQ_CURVE_FREQUENCIES[index]);
  const target = grid.map(index => targetDb[index]);
  const step = 0.25;
  let gains = new Array(n).fill(0);
  for (let pass = 0; pass < passes; pass++) {
    const base = eqResponseDb(gains, frequencies);
    const jacobian = gains.map((gain, i) => {
      const nudged = gains.slice();
      nudged[i] = gain + step;
      return eqResponseDb(nudged, frequencies).map((value, k) => (value - base[k]) / step);
    });
    const residual = target.map((value, k) => value - base[k]);
    const normal = jacobian.map((rowI, i) => jacobian.map((rowJ, j) => (
      rowI.reduce((sum, value, k) => sum + (value * rowJ[k]), 0) + (i === j ? ridge : 0)
    )));
    const rhs = jacobian.map(row => row.reduce((sum, value, k) => sum + (value * residual[k]), 0));
    const delta = solveLinear(normal, rhs);
    gains = gains.map((gain, i) => clampGain(gain + delta[i]));
  }
  return gains;
}

// The five-band filters ran at Q = 1, which differs from the new bands.
const LEGACY_Q = 1;

/** Converts five-band gains to ten bands that sound the same (matched response). */
export function migrateLegacyGains(legacyGains) {
  const target = eqResponseDb(legacyGains.map(clampGain), EQ_CURVE_FREQUENCIES, { bandFrequencies: LEGACY_EQ_FREQUENCIES, q: LEGACY_Q });
  return fitBandGains(target).map(roundHalf).map(clampGain);
}

// The original five-band presets, carried over by matching their response.
const LEGACY_PRESETS = {
  flat: ['Flat', [0, 0, 0, 0, 0]],
  bass_boost: ['Bass Boost', [6, 4, 0, 0, -1]],
  electronic: ['Electronic', [5, 3, -1, 3, 4]],
  acoustic: ['Acoustic', [3, 2, 0, 2, 3]],
  vocal: ['Vocal Boost', [-2, 1, 4, 3, 1]],
  treble_boost: ['Treble Boost', [-1, 0, 1, 4, 6]],
  rock: ['Rock', [5, 2, -1, 2, 5]],
};
export const LEGACY_PRESET_GAINS = Object.fromEntries(Object.entries(LEGACY_PRESETS).map(([key, [, gains]]) => [key, gains]));

export const EQ_PRESETS = Object.fromEntries(Object.entries(LEGACY_PRESETS).map(([key, [name, gains]]) => [
  key,
  { name, gains: migrateLegacyGains(gains) },
]));

/**
 * Turns saved gains of any known layout into the current bands. Old five-band
 * settings are converted by matching their response; unknown lengths fall back
 * to flat rather than guessing.
 */
export function migrateGains(saved) {
  const flat = EQ_FREQUENCIES.map(() => 0);
  if (!Array.isArray(saved)) return flat;
  if (saved.length === EQ_FREQUENCIES.length) return saved.map(clampGain);
  if (saved.length === LEGACY_EQ_FREQUENCIES.length) return migrateLegacyGains(saved);
  return flat;
}

/**
 * Transfer curve for a transparent safety limiter: identical to the input up to
 * `threshold` (default -1 dBFS), then a smooth tanh knee that never reaches full
 * scale. It has no latency and no make-up gain, unlike a compressor node.
 */
export function createSoftLimiterCurve(size = 4096, threshold = 0.891) {
  const curve = new Float32Array(size);
  const room = 1 - threshold;
  for (let i = 0; i < size; i++) {
    const x = ((i * 2) / (size - 1)) - 1;
    const magnitude = Math.abs(x);
    const shaped = magnitude <= threshold ? magnitude : threshold + (room * Math.tanh((magnitude - threshold) / room));
    curve[i] = Math.sign(x) * shaped;
  }
  return curve;
}
