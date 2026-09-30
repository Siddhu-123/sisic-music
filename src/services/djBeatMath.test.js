import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alignmentUnit, downbeatAtOrBefore, downbeatsBetween, equalPowerCurve, hasBeatGrid, incomingStartPosition,
  mixBars, phaseErrorSeconds, semitonesForRate, tempoMatch,
  decodeBeatList, beatIndexAt, timeAtBeatIndex, beatFollower, followerStep, MAX_FOLLOW_RATE_STEP, sanitizeRhythm,
  barBeatsOf, barPhaseBeats, localPeriodAt,
} from './djBeatMath.js';


const grid = (bpm, firstDownbeat, extra = {}) => ({ rhythmStatus: 'ready', bpm, firstDownbeat, barBeats: 4, gridCoverage: 0.95, downbeatAgreement: 0.9, ...extra });

test('a beat grid is only trusted when the tracker found beats that describe the whole track', () => {
  assert.equal(hasBeatGrid(grid(120, 0.5)), true);
  assert.equal(hasBeatGrid(grid(120, 0.5, { gridCoverage: 0.41 })), false, 'rubato tracks have no constant grid');
  assert.equal(hasBeatGrid({ rhythmStatus: 'no-beats' }), false);
  assert.equal(hasBeatGrid(null), false);
  assert.equal(hasBeatGrid(grid(120, 0.5, { gridCoverage: undefined })), true, 'older records without coverage still work');
});

test('tempo matching folds octaves and refuses stretches a pitch fader could not reach', () => {
  const near = tempoMatch(130, 128);
  assert.ok(Math.abs(near.ratio - 130 / 128) < 1e-12 && near.octave === 0 && near.matchable);
  const ballad = tempoMatch(140, 70);
  assert.equal(ballad.octave, 1, 'a 70 bpm track locks to a 140 bpm one at two beats per beat');
  assert.ok(Math.abs(ballad.ratio - 1) < 1e-12 && ballad.matchable);
  const half = tempoMatch(70, 141);
  assert.equal(half.octave, -1);
  assert.ok(Math.abs(half.ratio - 70 / 70.5) < 1e-12 && half.matchable);
  assert.equal(tempoMatch(128, 90).matchable, false, '42% is not a pitch-fader move');
  assert.equal(tempoMatch(128, 100, 0.3).matchable, true, 'the limit is a parameter');
  assert.equal(tempoMatch(NaN, 100).matchable, false);
  assert.ok(Math.abs(semitonesForRate(1.0595) - 1) < 1e-3);
});

test('the incoming track starts on the same beat phase the outgoing track is at, and the error measure agrees', () => {
  const out = grid(120, 0.5); // beat every 0.5 s, bar every 2 s
  const incoming = grid(120, 0.2);
  const started = incomingStartPosition(out, 10.75, incoming);
  assert.equal(started.unit, 'bar');
  assert.ok(Math.abs(started.phaseBeats - 0.5) < 1e-9, 'half a beat into the bar');
  assert.ok(Math.abs(started.position - 0.45) < 1e-9);
  assert.ok(Math.abs(phaseErrorSeconds(out, 10.75, incoming, started.position)) < 1e-9);
  assert.ok(Math.abs(phaseErrorSeconds(out, 10.75, incoming, started.position + 0.03) - 0.03) < 1e-9, 'ahead is positive');
  assert.ok(Math.abs(phaseErrorSeconds(out, 10.75, incoming, started.position - 0.03) + 0.03) < 1e-9, 'behind is negative');
});

test('phase error wraps to the nearest alignment, never a full bar away', () => {
  const out = grid(120, 0);
  const incoming = grid(120, 0);
  // Incoming is 1.9 s into a 2 s bar while the outgoing is at the bar line: 0.1 s behind the next one.
  assert.ok(Math.abs(phaseErrorSeconds(out, 4, incoming, 5.9) + 0.1) < 1e-9);
  assert.ok(Math.abs(phaseErrorSeconds(out, 4, incoming, 4.1) - 0.1) < 1e-9);
});

test('untrusted downbeats fall back to beat-to-beat alignment', () => {
  const out = grid(120, 0.5);
  const shaky = grid(120, 0.2, { downbeatAgreement: 0.3 });
  assert.equal(alignmentUnit(out, shaky), 'beat');
  assert.equal(alignmentUnit(out, grid(120, 0.2, { barBeats: 3 })), 'beat', 'different meters cannot share bars');
  const started = incomingStartPosition(out, 11.75, shaky);
  assert.equal(started.unit, 'beat');
  assert.ok(started.phaseBeats >= 0 && started.phaseBeats < 1);
});

test('a half-time incoming track aligns its beats to every other outgoing beat', () => {
  const out = grid(140, 0);
  const incoming = grid(70, 0.1, { downbeatAgreement: 0.1 });
  const match = tempoMatch(140, 70);
  assert.equal(match.octave, 1);
  for (const outTime of [8 * 60 / 140, 8.25 * 60 / 140, 11.5 * 60 / 140]) {
    const started = incomingStartPosition(out, outTime, incoming, match.octave);
    assert.ok(Math.abs(phaseErrorSeconds(out, outTime, incoming, started.position, match.octave)) < 1e-9);
  }
  // At an outgoing downbeat-aligned beat pair the incoming lands on its own grid line.
  const onBeat = incomingStartPosition(out, 6 * 60 / 140, incoming, 1);
  assert.ok(Math.abs(onBeat.position - 0.1) < 1e-9);
});

test('bar lines for leaving and entering are exact and ordered', () => {
  const rhythm = grid(120, 0.5);
  assert.deepEqual(downbeatsBetween(rhythm, 3, 9).map(value => +value.toFixed(6)), [4.5, 6.5, 8.5]);
  assert.equal(downbeatAtOrBefore(rhythm, 8.4), 6.5);
  assert.equal(downbeatAtOrBefore(rhythm, 6.5), 6.5);
  assert.equal(downbeatAtOrBefore(rhythm, 0.2), null, 'before the first bar there is nothing to leave on');
  assert.deepEqual(downbeatsBetween(rhythm, 9, 3), []);
});

test('mix length follows what both tracks allow, in whole bars', () => {
  assert.equal(mixBars({ outroBars: 8, introBars: 16 }), 8);
  assert.equal(mixBars({ outroBars: 5, introBars: 16 }), 4);
  assert.equal(mixBars({ outroBars: 0, introBars: 0 }), 2, 'no quiet ends: a short blend');
  assert.equal(mixBars({}), 8);
  assert.equal(mixBars({ outroBars: 32, introBars: 32, wantedBars: 32 }), 16, 'capped at 16 bars');
});

test('equal-power fades keep total power constant where linear fades dip by 3 dB', () => {
  const fadeIn = equalPowerCurve('in');
  const fadeOut = equalPowerCurve('out');
  assert.equal(fadeIn[0], 0);
  assert.ok(Math.abs(fadeIn.at(-1) - 1) < 1e-6 && Math.abs(fadeOut[0] - 1) < 1e-6 && Math.abs(fadeOut.at(-1)) < 1e-6);
  for (let index = 0; index < fadeIn.length; index += 1) {
    assert.ok(Math.abs(fadeIn[index] ** 2 + fadeOut[index] ** 2 - 1) < 1e-5);
  }
  const middle = fadeIn.length >> 1;
  const linearPower = 0.5 ** 2 + 0.5 ** 2;
  assert.ok(linearPower < 0.51, 'linear midpoint power is 0.5, a 3 dB dip');
  assert.ok(Math.abs(fadeIn[middle] ** 2 + fadeOut[middle] ** 2 - 1) < 1e-5);
});

test('decodeBeatList rejects malformed lists (non-array, short, negative t0, gap 100 or 5000, NaN, strings)', () => {
  // Valid list
  const valid = decodeBeatList([1000, 500, 600]);
  assert.deepEqual(valid, [1.0, 1.5, 2.1]);

  // Non-array
  assert.equal(decodeBeatList(null), null);
  assert.equal(decodeBeatList(undefined), null);
  assert.equal(decodeBeatList('not an array'), null);
  assert.equal(decodeBeatList(12345), null);
  assert.equal(decodeBeatList({}), null);

  // Short (< 3)
  assert.equal(decodeBeatList([]), null);
  assert.equal(decodeBeatList([0]), null);
  assert.equal(decodeBeatList([0, 500]), null);

  // Exceeds 66 entries
  assert.equal(decodeBeatList([0, ...Array(66).fill(500)]), null); // 67 entries
  assert.ok(decodeBeatList([0, ...Array(65).fill(500)]) !== null); // 66 entries is valid

  // Negative t0
  assert.equal(decodeBeatList([-1, 500, 500]), null);

  // Gap 100 or 5000 (outside 200..3000 ms range)
  assert.equal(decodeBeatList([0, 100, 500]), null);
  assert.equal(decodeBeatList([0, 5000, 500]), null);
  assert.equal(decodeBeatList([0, 199, 500]), null);
  assert.equal(decodeBeatList([0, 3001, 500]), null);

  // NaN
  assert.equal(decodeBeatList([NaN, 500, 500]), null);
  assert.equal(decodeBeatList([0, NaN, 500]), null);
  assert.equal(decodeBeatList([0, 500, NaN]), null);

  // Strings
  assert.equal(decodeBeatList(['0', 500, 500]), null);
  assert.equal(decodeBeatList([0, '500', 500]), null);

  // Floats
  assert.equal(decodeBeatList([0.5, 500, 500]), null);
  assert.equal(decodeBeatList([0, 500.5, 500]), null);
});

test('beatIndexAt and timeAtBeatIndex round-trip at 1000 random times including outside the ends', () => {
  assert.ok(Number.isNaN(beatIndexAt([], 1)));
  assert.ok(Number.isNaN(beatIndexAt([1], 1)));
  assert.ok(Number.isNaN(timeAtBeatIndex([], 1)));
  assert.ok(Number.isNaN(timeAtBeatIndex([1], 1)));

  const raw = [2500];
  for (let i = 0; i < 40; i += 1) {
    raw.push(450 + ((i * 17) % 150));
  }
  const beats = decodeBeatList(raw);
  assert.ok(beats);

  const tMin = beats[0] - 20;
  const tMax = beats.at(-1) + 20;

  for (let i = 0; i < 1000; i += 1) {
    const t = tMin + Math.random() * (tMax - tMin);
    const idx = beatIndexAt(beats, t);
    const roundTripTime = timeAtBeatIndex(beats, idx);
    assert.ok(Math.abs(roundTripTime - t) < 1e-9, `time round-trip failed at ${t}`);
  }

  for (let i = 0; i < 1000; i += 1) {
    const idx = -20 + Math.random() * (beats.length + 40);
    const t = timeAtBeatIndex(beats, idx);
    const roundTripIdx = beatIndexAt(beats, t);
    assert.ok(Math.abs(roundTripIdx - idx) < 1e-9, `index round-trip failed at ${idx}`);
  }
});

test('a follower on two constant-tempo lists at equal tempo returns rate 1 and error 0 at lock, and after simulating 5 seconds of wall time with a starting error of +40 ms and the returned rates the error decays below 5 ms', () => {
  const raw = [0, ...Array(60).fill(500)];
  const outBeats = decodeBeatList(raw);
  const inBeats = decodeBeatList(raw);

  const follower = beatFollower({ outBeats, inBeats, outTime: 10, inTime: 10 });
  assert.ok(follower);
  assert.equal(follower.k0, 0);

  const lockStep = followerStep(follower, { outTime: 10, inTime: 10 });
  assert.equal(lockStep.rate, 1);
  assert.equal(lockStep.errorSeconds, 0);

  let outTime = 10;
  let inTime = 10 + 0.040;
  const dt = 0.02;
  const steps = Math.round(5 / dt);
  for (let s = 0; s < steps; s += 1) {
    const step = followerStep(follower, { outTime, inTime, outRate: 1 });
    outTime += dt * 1;
    inTime += dt * step.rate;
  }

  const finalStep = followerStep(follower, { outTime, inTime, outRate: 1 });
  assert.ok(Math.abs(finalStep.errorSeconds) < 0.005, `error ${finalStep.errorSeconds} should decay below 5 ms`);
});

test('with outgoing 80 bpm and incoming 84 bpm lists the feed-forward rate is 80/84 (within 1e-9) with error 0', () => {
  const outBeats = Array.from({ length: 40 }, (_, i) => i * (60 / 80));
  const inBeats = Array.from({ length: 40 }, (_, i) => i * (60 / 84));
  const follower = beatFollower({ outBeats, inBeats, outTime: 0, inTime: 0 });
  assert.ok(follower);
  const step = followerStep(follower, { outTime: 0, inTime: 0, outRate: 1 });
  assert.ok(Math.abs(step.errorSeconds) < 1e-9, 'error should be 0');
  assert.ok(Math.abs(step.rate - 80 / 84) < 1e-9, `rate should be 80/84, got ${step.rate}`);
});

test('octave = 1 (incoming half-time) works with rate 1 for equal-tempo-at-double lists', () => {
  const outBeats = Array.from({ length: 40 }, (_, i) => i * (60 / 140));
  const inBeats = Array.from({ length: 40 }, (_, i) => i * (60 / 70));
  const follower = beatFollower({ outBeats, inBeats, octave: 1, outTime: 0, inTime: 0 });
  assert.ok(follower);
  const step = followerStep(follower, { outTime: 0, inTime: 0 });
  assert.ok(Math.abs(step.rate - 1) < 1e-9, `rate should be 1, got ${step.rate}`);
  assert.ok(Math.abs(step.errorSeconds) < 1e-9, 'error should be 0');
});

test('octave = 1 keeps the incoming on its beats while the outgoing plays on from a mid-song lock', () => {
  const outBeats = Array.from({ length: 60 }, (_, i) => 10 + i * (60 / 140));
  const inBeats = Array.from({ length: 60 }, (_, i) => 3 + i * (60 / 70));
  const outLock = timeAtBeatIndex(outBeats, 10); // On an even outgoing beat, so the half-time incoming index is whole.
  const inLock = timeAtBeatIndex(inBeats, 7);
  const follower = beatFollower({ outBeats, inBeats, octave: 1, outTime: outLock, inTime: inLock });
  for (const elapsed of [0, 1.5, 3, 6]) {
    const step = followerStep(follower, { outTime: outLock + elapsed, inTime: inLock + elapsed });
    assert.ok(Math.abs(step.errorSeconds) < 1e-9, `after ${elapsed}s the incoming should still be on its beats, error ${step.errorSeconds}`);
  }
});

test('when the outgoing list has a tempo ramp the feed-forward rate follows it (averaged over a few beats) and the simulated incoming stays within 10 ms of desired', () => {
  const gaps = Array.from({ length: 30 }, (_, i) => 500 - i * 3);
  const outBeats = [0];
  for (const g of gaps) outBeats.push(outBeats.at(-1) + g / 1000);
  const inBeats = Array.from({ length: 45 }, (_, i) => i * 0.5);

  const follower = beatFollower({ outBeats, inBeats, outTime: 0, inTime: 0 });
  assert.ok(follower);

  let outTime = 0;
  let inTime = 0;
  const dt = 0.01;
  const totalDuration = outBeats.at(-2);

  let maxAbsError = 0;
  while (outTime < totalDuration) {
    const step = followerStep(follower, { outTime, inTime, outRate: 1 });
    const absError = Math.abs(inTime - step.desiredInTime);
    if (absError > maxAbsError) maxAbsError = absError;
    assert.ok(absError < 0.010, `incoming error ${absError} exceeded 10 ms at outTime=${outTime}`);

    const b = Math.max(0, Math.min(gaps.length - 1, Math.floor(beatIndexAt(outBeats, outTime))));
    const lo = Math.max(0, b + 1 - 4);
    const hi = Math.min(outBeats.length - 1, b + 4);
    const expectedFeedForward = 0.5 / ((outBeats[hi] - outBeats[lo]) / (hi - lo));
    const actualFeedForward = step.rate / (1 - Math.min(Math.max(step.errorSeconds / 0.8, -MAX_FOLLOW_RATE_STEP), MAX_FOLLOW_RATE_STEP));
    assert.ok(Math.abs(actualFeedForward - expectedFeedForward) < 1e-9, `feed-forward rate should track beat by beat`);

    outTime += dt * 1;
    inTime += dt * step.rate;
  }
  assert.ok(maxAbsError < 0.010, 'simulated incoming stays within 10 ms of desired throughout ramp');
});

test('beats quantised to the tracker\'s 20 ms grid do not make the feed-forward rate jump between beats', () => {
  const grid = 0.02;
  const outBeats = Array.from({ length: 64 }, (_, i) => Math.round(i * (60 / 83.9) / grid) * grid);
  const inBeats = Array.from({ length: 64 }, (_, i) => Math.round(i * (60 / 80.96) / grid) * grid);
  const follower = beatFollower({ outBeats, inBeats, outTime: 4, inTime: 4 });
  const truth = 83.9 / 80.96;
  for (let outTime = 5; outTime < 40; outTime += 0.37) {
    const step = followerStep(follower, { outTime, inTime: timeAtBeatIndex(inBeats, beatIndexAt(outBeats, outTime) + follower.k0), outRate: 1 });
    assert.ok(Math.abs(step.rate / (1 - Math.min(Math.max(step.errorSeconds / 0.8, -0.04), 0.04)) / truth - 1) < 0.01,
      `feed-forward ${step.rate} strays more than 1 % from ${truth} at ${outTime}`);
  }
});

test('sanitizer keeps valid lists, drops invalid ones, keeps records valid without them, and drops unknown fields', () => {
  const validList = [0, 500, 500, 500];
  const invalidList = [0, 100, 500];

  const full = {
    rhythmStatus: 'ready',
    bpm: 120,
    firstDownbeat: 0.5,
    startBpm: 118.5,
    introBpm: 120,
    outroBpm: 122,
    beatListVersion: 1,
    introVirtual: 4,
    outroVirtual: 2,
    introBeats: validList,
    outroBeats: validList,
    unknownField: 'bad',
    anotherJunk: 999,
  };

  const sanitized = sanitizeRhythm(full);
  assert.ok(sanitized);
  assert.equal(sanitized.startBpm, 118.5);
  assert.equal(sanitized.introBpm, 120);
  assert.equal(sanitized.outroBpm, 122);
  assert.equal(sanitized.beatListVersion, 1);
  assert.equal(sanitized.introVirtual, 4);
  assert.equal(sanitized.outroVirtual, 2);
  assert.deepEqual(sanitized.introBeats, validList);
  assert.deepEqual(sanitized.outroBeats, validList);
  assert.equal(sanitized.unknownField, undefined);
  assert.equal(sanitized.anotherJunk, undefined);

  // Drops invalid lists but keeps record valid without them
  const withInvalidLists = {
    rhythmStatus: 'ready',
    bpm: 120,
    firstDownbeat: 0.5,
    introBeats: invalidList,
    outroBeats: 'not an array',
  };
  const sanitizedInvalid = sanitizeRhythm(withInvalidLists);
  assert.ok(sanitizedInvalid);
  assert.equal(sanitizedInvalid.introBeats, undefined);
  assert.equal(sanitizedInvalid.outroBeats, undefined);
  assert.equal(sanitizedInvalid.bpm, 120);

  // Missing lists completely: record is still valid
  const withoutLists = {
    rhythmStatus: 'ready',
    bpm: 120,
    firstDownbeat: 0.5,
  };
  const sanitizedNoLists = sanitizeRhythm(withoutLists);
  assert.ok(sanitizedNoLists);
  assert.equal(sanitizedNoLists.bpm, 120);
  assert.equal(sanitizedNoLists.introBeats, undefined);
  assert.equal(sanitizedNoLists.outroBeats, undefined);
});


// ---- boundary and guard pins (each asserts one behaviour a mutation run showed was unpinned) ----
test('decodeBeatList accepts gaps of exactly 200 and 3000 ms and rejects 199 and 3001', () => {
  assert.deepEqual(decodeBeatList([0, 200, 200]), [0, 0.2, 0.4]);
  assert.deepEqual(decodeBeatList([0, 3000, 3000]), [0, 3, 6]);
  assert.equal(decodeBeatList([0, 199, 200]), null);
  assert.equal(decodeBeatList([0, 200, 3001]), null);
});

test('beatIndexAt and timeAtBeatIndex at the ends, with zero gaps and on long lists', () => {
  const beats = [0, 1, 2];
  assert.equal(beatIndexAt(beats, 2), 2);
  assert.equal(beatIndexAt(beats, 3), 3);
  assert.equal(beatIndexAt(beats, -1), -1);
  assert.equal(beatIndexAt([1, 1, 2], 0.5), 0);
  assert.equal(beatIndexAt([0, 1, 1], 5), 2);
  const long = Array.from({ length: 10 }, (_, i) => i);
  assert.equal(beatIndexAt(long, 6.5), 6.5);
  assert.equal(beatIndexAt(long, 3.25), 3.25);
  assert.equal(timeAtBeatIndex(beats, 2), 2);
  assert.equal(timeAtBeatIndex(beats, 0), 0);
  assert.equal(timeAtBeatIndex(long, 8.5), 8.5);
});

test('localPeriodAt clamps the interval at the last beat and averages the window', () => {
  const beats = [0, 1, 2, 3, 4, 5, 6, 7, 9, 12];
  assert.equal(localPeriodAt(beats, 12), 1.75);
  assert.equal(localPeriodAt(beats, 12, 2), 2.5);
  assert.equal(localPeriodAt(beats, 0), 1);
});

test('followerStep returns null unless both beat lists exist', () => {
  const beats = [0, 0.5, 1, 1.5, 2];
  const args = { outTime: 1, inTime: 1 };
  assert.equal(followerStep({ outBeats: beats, octave: 0, k0: 0 }, args), null);
  assert.equal(followerStep({ inBeats: beats, octave: 0, k0: 0 }, args), null);
  assert.equal(followerStep(null, args), null);
  assert.ok(followerStep({ outBeats: beats, inBeats: beats, octave: 0, k0: 0 }, args));
});

test('barBeatsOf accepts 2 to 12 whole beats and falls back to 4', () => {
  assert.equal(barBeatsOf({ barBeats: 2 }), 2);
  assert.equal(barBeatsOf({ barBeats: 12 }), 12);
  assert.equal(barBeatsOf({ barBeats: 3 }), 3);
  assert.equal(barBeatsOf({ barBeats: 13 }), 4);
  assert.equal(barBeatsOf({ barBeats: 1 }), 4);
  assert.equal(barBeatsOf({ barBeats: 4.5 }), 4);
  assert.equal(barBeatsOf(null), 4);
});

test('barPhaseBeats gives the position in the bar and null without a tempo or time', () => {
  const r = grid(120, 1);
  assert.equal(barPhaseBeats(r, 1), 0);
  assert.equal(barPhaseBeats(r, 2.25), 2.5);
  assert.equal(barPhaseBeats(r, 0.5), 3);
  assert.equal(barPhaseBeats(r, NaN), null);
  assert.equal(barPhaseBeats({ firstDownbeat: 1 }, 2), null);
});

test('alignmentUnit trusts downbeats at exactly 0.6 agreement and not below', () => {
  assert.equal(alignmentUnit(grid(120, 0, { downbeatAgreement: 0.6 }), grid(120, 0, { downbeatAgreement: 0.6 })), 'bar');
  assert.equal(alignmentUnit(grid(120, 0, { downbeatAgreement: 0.59 }), grid(120, 0, { downbeatAgreement: 0.9 })), 'beat');
  assert.equal(alignmentUnit(grid(120, 0), grid(120, 0, { downbeatAgreement: 0.59 })), 'beat');
});

test('incomingStartPosition and phaseErrorSeconds return null for each unusable argument', () => {
  const ok = grid(120, 0);
  const noTempo = { rhythmStatus: 'ready', firstDownbeat: 0 };
  assert.equal(incomingStartPosition(noTempo, 4, ok), null);
  assert.equal(incomingStartPosition(ok, 4, noTempo), null);
  assert.equal(incomingStartPosition(ok, NaN, ok), null);
  assert.ok(incomingStartPosition(ok, 4, ok));
  assert.equal(phaseErrorSeconds(noTempo, 4, ok, 4), null);
  assert.equal(phaseErrorSeconds(ok, 4, noTempo, 4), null);
  assert.equal(phaseErrorSeconds(ok, NaN, ok, 4), null);
  assert.equal(phaseErrorSeconds(ok, 4, ok, NaN), null);
  assert.equal(phaseErrorSeconds(ok, 4, ok, 4), 0);
});

test('phaseErrorSeconds only wraps past half an alignment unit', () => {
  const beatOnly = grid(120, 0, { downbeatAgreement: 0.1 });
  assert.ok(Math.abs(phaseErrorSeconds(beatOnly, 0, beatOnly, 0.2) - 0.2) < 1e-9); // 0.4 beat: stays ahead
  assert.ok(Math.abs(phaseErrorSeconds(beatOnly, 0, beatOnly, 0.3) - -0.2) < 1e-9); // 0.6 beat: wraps to -0.4 beat
  assert.ok(Math.abs(phaseErrorSeconds(beatOnly, 0.3, beatOnly, 0) - 0.2) < 1e-9);
  assert.equal(phaseErrorSeconds(beatOnly, 0, beatOnly, 0.25), 0.25); // exactly half a beat ahead stays ahead
  assert.equal(phaseErrorSeconds(beatOnly, 0.25, beatOnly, 0), -0.25); // exactly half behind stays behind
});

test('downbeatsBetween and downbeatAtOrBefore include exact bar lines and reject bad input', () => {
  const r = grid(120, 1); // bar = 2 s
  assert.deepEqual(downbeatsBetween(r, 0, 10), [1, 3, 5, 7, 9]);
  assert.deepEqual(downbeatsBetween(r, 1, 5), [1, 3, 5]);
  assert.deepEqual(downbeatsBetween(r, 5, 1), []);
  assert.deepEqual(downbeatsBetween(r, NaN, 5), []);
  assert.deepEqual(downbeatsBetween(r, 0, NaN), []);
  assert.deepEqual(downbeatsBetween({ firstDownbeat: 1 }, 0, 10), []);
  assert.equal(downbeatAtOrBefore(r, 1), 1);
  assert.equal(downbeatAtOrBefore(r, 4.9), 3);
  assert.equal(downbeatAtOrBefore(r, 0.9), null);
  assert.equal(downbeatAtOrBefore(r, NaN), null);
  assert.equal(downbeatAtOrBefore({ firstDownbeat: 1 }, 5), null);
});

test('mixBars never returns less than 2 and the default curve has 128 points', () => {
  assert.equal(mixBars({ outroBars: 8, introBars: 8, wantedBars: 1 }), 2);
  assert.equal(equalPowerCurve('in').length, 128);
  assert.equal(equalPowerCurve('out', 5).length, 5);
});

test('sanitizeRhythm bounds: every numeric field accepts its min and max and rejects just outside', () => {
  const bounds = {
    rhythmVersion: [0, 100], bpm: [30, 300], firstBeat: [0, 3600], firstDownbeat: [0, 3600], barBeats: [2, 12], beatCount: [0, 100000],
    gridDeviationMs: [0, 5000], gridCoverage: [0, 1], downbeatAgreement: [0, 1], introEnd: [0, 7200], introBars: [0, 512],
    outroStart: [0, 7200], outroBars: [0, 512], duration: [0, 7200], introBpm: [30, 300], outroBpm: [30, 300],
    startBpm: [30, 300], beatListVersion: [0, 64], introVirtual: [0, 64], outroVirtual: [0, 64],
  };
  const base = { rhythmStatus: 'ready', bpm: 120, firstDownbeat: 1 };
  for (const [field, [min, max]] of Object.entries(bounds)) {
    for (const value of [min, max]) {
      assert.equal(sanitizeRhythm({ ...base, [field]: value })?.[field], value, `${field}=${value} accepted`);
    }
    for (const value of [min - 0.5, max + 0.5, min - 1, max + 1]) {
      const record = sanitizeRhythm({ ...base, [field]: value });
      assert.ok(record == null || record[field] === undefined, `${field}=${value} rejected`);
    }
  }
});

test('sanitizeRhythm keeps only real booleans for abruptEnd and needs ready, a tempo and a downbeat', () => {
  const base = { rhythmStatus: 'ready', bpm: 120, firstDownbeat: 1 };
  assert.equal(sanitizeRhythm({ ...base, abruptEnd: true }).abruptEnd, true);
  assert.equal(sanitizeRhythm({ ...base, abruptEnd: false }).abruptEnd, false);
  assert.equal('abruptEnd' in sanitizeRhythm({ ...base, abruptEnd: 'yes' }), false);
  assert.equal(sanitizeRhythm({ rhythmStatus: 'ready', bpm: 120 }), null);
  assert.equal(sanitizeRhythm({ rhythmStatus: 'ready', firstDownbeat: 1 }), null);
  assert.equal(sanitizeRhythm({ rhythmStatus: 'no-beats', bpm: 120, firstDownbeat: 1 }), null);
  assert.equal(sanitizeRhythm([]), null);
  assert.equal(sanitizeRhythm('x'), null);
});
