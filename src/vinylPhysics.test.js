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
  calculateMotorTargetVelocity,
  stepMotorVelocity,
  inertiaVelocity,
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

test('motor target velocity synchronizes playing, buffering, paused, and stopped states', () => {
  // Nominal 45 RPM speed is 270 deg/s (360 / (4/3))
  const nominal45 = 270;
  assert.equal(calculateMotorTargetVelocity({ isPlaying: true, hasCurrentSong: true }), nominal45);

  // 33 RPM
  const nominal33 = 360 / (60 / 33);
  assert.equal(calculateMotorTargetVelocity({ isPlaying: true, hasCurrentSong: true, rpm: 33 }), nominal33);

  // Pitch modified
  const pitched45 = 360 / (60 / (45 * 1.08));
  assert.equal(calculateMotorTargetVelocity({ isPlaying: true, hasCurrentSong: true, rpm: 45, pitchModifier: 1.08 }), pitched45);

  // Paused -> target velocity 0
  assert.equal(calculateMotorTargetVelocity({ isPlaying: false, hasCurrentSong: true }), 0);

  // Buffering -> target velocity 0 (motor idles until stream ready)
  assert.equal(calculateMotorTargetVelocity({ isPlaying: true, isBuffering: true, hasCurrentSong: true }), 0);

  // Stopped (no song) -> target velocity 0
  assert.equal(calculateMotorTargetVelocity({ isPlaying: true, hasCurrentSong: false }), 0);

  // Dragging record -> target velocity 0 (hand decoupled)
  assert.equal(calculateMotorTargetVelocity({ isPlaying: true, hasCurrentSong: true, dragMode: 'record' }), 0);
});

test('motor velocity smoothly accelerates from rest and decelerates to rest', () => {
  const target = 270;
  // Acceleration over 100ms from 0 towards 270
  const after100ms = stepMotorVelocity(0, target, 100);
  assert.ok(after100ms > 0 && after100ms < target);
  assert.ok(after100ms > 100); // 180ms time constant reaches > 110 deg/s in 100ms

  // Continuing to accelerate approaches target
  const after500ms = stepMotorVelocity(after100ms, target, 400);
  assert.ok(after500ms > 250);

  // Deceleration from nominal speed towards 0
  const decel100ms = stepMotorVelocity(target, 0, 100);
  assert.ok(decel100ms < target && decel100ms > 0);

  // Natural deceleration settles cleanly to exactly 0 when below threshold
  const nearZero = stepMotorVelocity(0.08, 0, 50);
  assert.equal(nearZero, 0);

  // Inertia velocity helper exponential decay
  assert.equal(inertiaVelocity(100, 0, 0), 100);
  assert.ok(inertiaVelocity(100, 0, 190) < 40);
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
