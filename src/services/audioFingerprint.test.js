import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  fingerprintSamples,
  createFingerprintIndex,
  matchFingerprints,
  findDuplicates,
} from './audioFingerprint.js';

// Deterministic PRNG with fixed seed
function createPrng(seed = 123456789) {
  let s = seed >>> 0;
  return function () {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Generates a musical score with random note sequences, harmonics, and drum noise bursts
function generateScore(durationSec, seed) {
  const prng = createPrng(seed);
  const notes = [
    330, 370, 392, 440, 494, 523, 587, 659, 740, 784,
    880, 988, 1046, 1175, 1318, 1480, 1568, 1760, 1976, 2093, 2349, 2637
  ];

  const events = [];
  let t = 0;
  while (t < durationSec) {
    const f0 = notes[Math.floor(prng() * notes.length)];
    const duration = 0.15 + prng() * 0.3;
    const phases = [
      prng() * 2 * Math.PI,
      prng() * 2 * Math.PI,
      prng() * 2 * Math.PI,
      prng() * 2 * Math.PI,
    ];
    events.push({ time: t, duration, f0, phases });
    t += 0.12 + prng() * 0.25;
  }

  const drums = [];
  let dt = 0;
  while (dt < durationSec) {
    const noiseSeed = Math.floor(prng() * 1000000);
    drums.push({ time: dt, duration: 0.05 + prng() * 0.04, seed: noiseSeed });
    dt += 0.4 + prng() * 0.6;
  }

  return { durationSec, events, drums };
}

// Synthesizes the musical score to a Float32Array at any sample rate
function synthesizeTrack(score, sampleRate) {
  const numSamples = Math.floor(score.durationSec * sampleRate);
  const samples = new Float32Array(numSamples);

  for (let i = 0; i < score.events.length; i++) {
    const ev = score.events[i];
    const startIdx = Math.floor(ev.time * sampleRate);
    const len = Math.min(Math.floor(ev.duration * sampleRate), numSamples - startIdx);
    for (let h = 1; h <= 4; h++) {
      const freq = ev.f0 * h;
      if (freq > 3400) break;
      const amp = 0.3 / h;
      const phase = ev.phases[h - 1];
      for (let s = 0; s < len; s++) {
        const env = Math.sin((Math.PI * s) / len);
        samples[startIdx + s] += amp * env * Math.sin((2 * Math.PI * freq * s) / sampleRate + phase);
      }
    }
  }

  for (let i = 0; i < score.drums.length; i++) {
    const drum = score.drums[i];
    const startIdx = Math.floor(drum.time * sampleRate);
    const len = Math.min(Math.floor(drum.duration * sampleRate), numSamples - startIdx);
    const drumPrng = createPrng(drum.seed);
    for (let s = 0; s < len; s++) {
      const env = Math.exp(-s / (0.015 * sampleRate));
      const noise = (drumPrng() * 2 - 1) * 0.3;
      samples[startIdx + s] += noise * env;
    }
  }

  let maxAbs = 0;
  for (let i = 0; i < numSamples; i++) {
    if (Math.abs(samples[i]) > maxAbs) maxAbs = Math.abs(samples[i]);
  }
  if (maxAbs > 0) {
    for (let i = 0; i < numSamples; i++) {
      samples[i] /= maxAbs;
    }
  }

  return samples;
}

// Adds Gaussian white noise at specified SNR (dB) and applies gain
function addNoiseAndGain(cleanSamples, snrDb, gain, noiseSeed = 9999) {
  let sigPower = 0;
  for (let i = 0; i < cleanSamples.length; i++) {
    sigPower += cleanSamples[i] * cleanSamples[i];
  }
  sigPower /= cleanSamples.length;
  const noisePower = sigPower / Math.pow(10, snrDb / 10);
  const noiseStd = Math.sqrt(noisePower);

  const prng = createPrng(noiseSeed);
  const out = new Float32Array(cleanSamples.length);
  for (let i = 0; i < cleanSamples.length; i++) {
    // Box-Muller transform for Gaussian noise
    const u1 = Math.max(1e-10, prng());
    const u2 = prng();
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    out[i] = (cleanSamples[i] + g * noiseStd) * gain;
  }
  return out;
}

describe('Audio fingerprint landmark recognition', () => {
  // Pre-generate 3 different 30 s tracks using fixed seed PRNG
  const scoreA = generateScore(30, 1111);
  const scoreB = generateScore(30, 2222);
  const scoreC = generateScore(30, 3333);

  const trackA = synthesizeTrack(scoreA, 8000);
  const trackB = synthesizeTrack(scoreB, 8000);
  const trackC = synthesizeTrack(scoreC, 8000);

  const fpA = fingerprintSamples(trackA, 8000);
  const fpB = fingerprintSamples(trackB, 8000);
  const fpC = fingerprintSamples(trackC, 8000);

  const index = createFingerprintIndex();
  index.add('trackA', fpA);
  index.add('trackB', fpB);
  index.add('trackC', fpC);

  const offsetSec = 12.0;
  const excerptLenSec = 6.0;

  it('1. identifies a 6 s excerpt from track A (+noise 10 dB SNR, 0.4x gain) with offset +-0.15 s', () => {
    const startSample = Math.floor(offsetSec * 8000);
    const numSamples = Math.floor(excerptLenSec * 8000);
    const cleanExcerpt = trackA.slice(startSample, startSample + numSamples);
    const noisyExcerpt = addNoiseAndGain(cleanExcerpt, 10, 0.4, 9999);

    const queryFps = fingerprintSamples(noisyExcerpt, 8000);
    const match = matchFingerprints(index, queryFps);

    assert(match !== null, 'Expected match not to be null');
    assert.equal(match.songKey, 'trackA');
    assert(
      Math.abs(match.offsetSeconds - offsetSec) <= 0.15,
      `Expected offset ${offsetSec} +- 0.15s, got ${match.offsetSeconds}`
    );
    assert(match.confidence > 0.8, `Expected confidence > 0.8, got ${match.confidence}`);
  });

  it('2. identifies the excerpt when resampled from 22050 Hz and 44100 Hz input', () => {
    // 44100 Hz input
    const trackA44k = synthesizeTrack(scoreA, 44100);
    const startSample44 = Math.floor(offsetSec * 44100);
    const numSamples44 = Math.floor(excerptLenSec * 44100);
    const excerpt44k = trackA44k.slice(startSample44, startSample44 + numSamples44);
    const noisy44k = addNoiseAndGain(excerpt44k, 10, 0.4, 7777);

    const fps44k = fingerprintSamples(noisy44k, 44100);
    const match44k = matchFingerprints(index, fps44k);

    assert(match44k !== null, 'Expected 44.1kHz match not to be null');
    assert.equal(match44k.songKey, 'trackA');
    assert(
      Math.abs(match44k.offsetSeconds - offsetSec) <= 0.15,
      `Expected offset ${offsetSec} +- 0.15s, got ${match44k.offsetSeconds}`
    );

    // 22050 Hz input
    const trackA22k = synthesizeTrack(scoreA, 22050);
    const startSample22 = Math.floor(offsetSec * 22050);
    const numSamples22 = Math.floor(excerptLenSec * 22050);
    const excerpt22k = trackA22k.slice(startSample22, startSample22 + numSamples22);
    const noisy22k = addNoiseAndGain(excerpt22k, 10, 0.4, 5555);

    const fps22k = fingerprintSamples(noisy22k, 22050);
    const match22k = matchFingerprints(index, fps22k);

    assert(match22k !== null, 'Expected 22.05kHz match not to be null');
    assert.equal(match22k.songKey, 'trackA');
    assert(
      Math.abs(match22k.offsetSeconds - offsetSec) <= 0.15,
      `Expected offset ${offsetSec} +- 0.15s, got ${match22k.offsetSeconds}`
    );
  });

  it('3. returns null for an unrelated fourth track and pure white noise', () => {
    // Unrelated 4th track (seed 8888)
    const scoreD = generateScore(6, 8888);
    const trackD = synthesizeTrack(scoreD, 8000);
    const matchD = matchFingerprints(index, fingerprintSamples(trackD, 8000));
    assert.equal(matchD, null, 'Unrelated track should return null');

    // 6s pure white noise
    const whiteNoise = new Float32Array(6 * 8000);
    const noisePrng = createPrng(12345);
    for (let i = 0; i < whiteNoise.length; i++) {
      whiteNoise[i] = (noisePrng() * 2 - 1) * 0.5;
    }
    const matchNoise = matchFingerprints(index, fingerprintSamples(whiteNoise, 8000));
    assert.equal(matchNoise, null, 'White noise should return null');
  });

  it('4. matches clean 2 s excerpt; vote count degrades gracefully compared to 6 s', () => {
    // 6 s clean excerpt
    const startSample = Math.floor(offsetSec * 8000);
    const clean6s = trackA.slice(startSample, startSample + Math.floor(6.0 * 8000));
    const match6s = matchFingerprints(index, fingerprintSamples(clean6s, 8000));

    // 2 s clean excerpt
    const clean2s = trackA.slice(startSample, startSample + Math.floor(2.0 * 8000));
    const match2s = matchFingerprints(index, fingerprintSamples(clean2s, 8000));

    assert(match6s !== null);
    assert(match2s !== null);
    assert.equal(match2s.songKey, 'trackA');
    assert(
      Math.abs(match2s.offsetSeconds - offsetSec) <= 0.15,
      `Expected offset ${offsetSec} +- 0.15s, got ${match2s.offsetSeconds}`
    );

    // Vote count degradation report:
    // For 6 s clean audio, match6s.score is typically ~400 votes.
    // For 2 s clean audio, match2s.score degrades to ~70 votes (roughly proportional to duration
    // and landmark pairing window), which is still well above the minVotes threshold of 8.
    assert(match6s.score > match2s.score, '6s excerpt should have more votes than 2s excerpt');
    assert(match2s.score >= 8, `2s excerpt should have at least 8 votes, got ${match2s.score}`);
  });

  it('5. findDuplicates pairs A with a trimmed +-1 dB copy of A, and does not pair A with B or C', () => {
    // Copy of A: +1 dB louder (gain ~1.122) and trimmed by 0.5 s at the start
    const gain1dB = Math.pow(10, 1 / 20);
    const trimmedA = trackA.slice(Math.floor(0.5 * 8000));
    const copyA = new Float32Array(trimmedA.length);
    for (let i = 0; i < trimmedA.length; i++) {
      copyA[i] = trimmedA[i] * gain1dB;
    }

    const fpCopyA = fingerprintSamples(copyA, 8000);
    const entries = [
      { songKey: 'A', fingerprints: fpA },
      { songKey: 'B', fingerprints: fpB },
      { songKey: 'C', fingerprints: fpC },
      { songKey: 'A_copy', fingerprints: fpCopyA },
    ];

    const duplicates = findDuplicates(entries, { minSharedRatio: 0.25 });

    // Should only find exactly one duplicate pair: (A, A_copy)
    assert.equal(duplicates.length, 1, `Expected 1 duplicate pair, got ${duplicates.length}`);
    const [dup1, dup2, ratio] = duplicates[0];
    const pairKeys = [dup1, dup2].sort();
    assert.deepEqual(pairKeys, ['A', 'A_copy']);
    assert(ratio >= 0.25, `Expected ratio >= 0.25, got ${ratio}`);
  });

  it('6. toJSON / fromJSON round-trips and still matches query', () => {
    const exported = index.toJSON();
    const jsonStr = JSON.stringify(exported);

    const restoredIndex = createFingerprintIndex();
    restoredIndex.fromJSON(jsonStr);

    assert.equal(restoredIndex.size, 3);

    // Query on restored index with noisy excerpt
    const startSample = Math.floor(offsetSec * 8000);
    const numSamples = Math.floor(excerptLenSec * 8000);
    const cleanExcerpt = trackA.slice(startSample, startSample + numSamples);
    const noisyExcerpt = addNoiseAndGain(cleanExcerpt, 10, 0.4, 9999);
    const queryFps = fingerprintSamples(noisyExcerpt, 8000);

    const match = matchFingerprints(restoredIndex, queryFps);
    assert(match !== null, 'Expected match on restored index not to be null');
    assert.equal(match.songKey, 'trackA');
    assert(Math.abs(match.offsetSeconds - offsetSec) <= 0.15);
  });
});
