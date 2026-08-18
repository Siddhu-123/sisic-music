import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TONEARM_END_ANGLE,
  TONEARM_START_ANGLE,
  VINYL_RPM,
  VINYL_SECONDS_PER_TURN,
  tonearmAngleFromProgress,
  tonearmProgressFromAngle,
  vinylSecondsFromDegrees,
  wrappedAngleDelta,
} from './vinylPhysics.js';

test('vinyl rotates at 45 RPM and maps a full turn to the correct playback time', () => {
  assert.equal(VINYL_RPM, 45);
  assert.ok(VINYL_RPM >= 45);
  assert.equal(VINYL_SECONDS_PER_TURN, 4 / 3);
  assert.equal(vinylSecondsFromDegrees(360), 4 / 3);
  assert.equal(vinylSecondsFromDegrees(-180), -2 / 3);
});

test('record dragging keeps clockwise movement forward across the angle boundary', () => {
  assert.equal(wrappedAngleDelta(350, 10), 20);
  assert.equal(wrappedAngleDelta(10, 350), -20);
});

test('tonearm progress tracks from the outer groove toward the label', () => {
  assert.equal(tonearmProgressFromAngle(TONEARM_START_ANGLE), 0);
  assert.equal(tonearmProgressFromAngle(TONEARM_END_ANGLE), 100);
  assert.equal(tonearmAngleFromProgress(0), TONEARM_START_ANGLE);
  assert.equal(tonearmAngleFromProgress(100), TONEARM_END_ANGLE);
  assert.equal(tonearmProgressFromAngle((TONEARM_START_ANGLE + TONEARM_END_ANGLE) / 2), 50);
});
