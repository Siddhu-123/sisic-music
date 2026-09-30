import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alignmentUnit, downbeatAtOrBefore, downbeatsBetween, equalPowerCurve, hasBeatGrid, incomingStartPosition,
  mixBars, phaseErrorSeconds, semitonesForRate, tempoMatch,
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
