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
  vinylSecondsPerTurn,
  wrappedAngleDelta,
} from './vinylPhysics.js';

test('vinyl rotates at 45 RPM and maps a full turn to the correct playback time', () => {
  assert.equal(VINYL_RPM, 45);
  assert.ok(VINYL_RPM >= 45);
  assert.equal(VINYL_SECONDS_PER_TURN, 4 / 3);
  assert.equal(vinylSecondsFromDegrees(360), 4 / 3);
  assert.equal(vinylSecondsFromDegrees(-180), -2 / 3);
  assert.equal(vinylSecondsPerTurn(33, 1), 60 / 33);
  assert.equal(vinylSecondsPerTurn(45, 1.08), 60 / (45 * 1.08));
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

test('platter velocity eases continuously and 33 means 33⅓', async () => {
  const { stepPlatterVelocity, physicalRpm } = await import('./vinylPhysics.js');
  assert.ok(Math.abs(physicalRpm(33) - 100 / 3) < 1e-9);
  assert.equal(physicalRpm(45), 45);
  const half = stepPlatterVelocity(0, 270, 0.2 * Math.LN2, 0.2);
  assert.ok(Math.abs(half - 135) < 1e-6);
  assert.equal(stepPlatterVelocity(100, 0, 10, 0.2) < 1e-6, true);
});

test('tonearm geometry keeps the stylus between the outer groove and the label', async () => {
  const { createTonearmGeometry } = await import('./vinylPhysics.js');
  const geometry = createTonearmGeometry({ pivotToCenter: 433, armLength: 411, centerBearing: 34.6, outerRadius: 220, innerRadius: 95 });
  assert.ok(geometry.startAngle < geometry.endAngle);
  assert.ok(geometry.liftedAngle < geometry.startAngle);
  for (const progress of [0, 30, 75, 100]) {
    const angle = geometry.angleForProgress(progress);
    assert.ok(Math.abs(geometry.progressForAngle(angle) - progress) < 1e-6);
  }
  assert.equal(createTonearmGeometry({}), null);
});
