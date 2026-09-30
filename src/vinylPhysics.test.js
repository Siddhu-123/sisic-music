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
  // The "33" setting is 33⅓ RPM.
  assert.ok(Math.abs(vinylSecondsPerTurn(33, 1) - (60 / (100 / 3))) < 1e-9);
  assert.equal(vinylSecondsPerTurn(45, 1.08), 60 / (45 * 1.08));
});

test('motor target velocity synchronizes playing, buffering, paused, and stopped states', () => {
  // Nominal 45 RPM speed is 270 deg/s (360 / (4/3))
  const nominal45 = 270;
  assert.equal(calculateMotorTargetVelocity({ isPlaying: true, hasCurrentSong: true }), nominal45);

  // 33 RPM
  const nominal33 = 360 / (60 / (100 / 3));
  assert.ok(Math.abs(calculateMotorTargetVelocity({ isPlaying: true, hasCurrentSong: true, rpm: 33 }) - nominal33) < 1e-9);

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

test('33 RPM runs at 33⅓ and the lifted arm rests off the record', async () => {
  const { physicalRpm, vinylSecondsPerTurn, TONEARM_LIFTED_ANGLE, TONEARM_START_ANGLE } = await import('./vinylPhysics.js');
  assert.ok(Math.abs(physicalRpm(33) - 100 / 3) < 1e-9);
  assert.ok(Math.abs(vinylSecondsPerTurn(33) - 1.8) < 1e-9);
  assert.equal(vinylSecondsPerTurn(45), 60 / 45);
  assert.ok(TONEARM_LIFTED_ANGLE < TONEARM_START_ANGLE);
});

// Coordinates measured from the pivot: x to the left, y downward, matching the tonearm's angle convention.
function stylusDistanceFromCentre({ pivotToCenter, armLength, centerBearing }, angle) {
  const rad = degrees => (degrees * Math.PI) / 180;
  const centre = [pivotToCenter * Math.cos(rad(centerBearing)), pivotToCenter * Math.sin(rad(centerBearing))];
  const stylus = [armLength * Math.cos(rad(angle)), armLength * Math.sin(rad(angle))];
  return Math.hypot(centre[0] - stylus[0], centre[1] - stylus[1]);
}

test('tonearm geometry puts the stylus on the outer groove at 0% and the run-out at 100%, on any layout', async () => {
  const { createTonearmGeometry } = await import('./vinylPhysics.js');
  // A wide desktop deck and a narrow phone deck: different arm length, pivot distance and record size.
  const layouts = [
    { pivotToCenter: 433, armLength: 411, centerBearing: 34.6, outerRadius: 220, innerRadius: 95 },
    { pivotToCenter: 180, armLength: 172, centerBearing: 28, outerRadius: 89, innerRadius: 38 },
  ];
  for (const layout of layouts) {
    const arm = createTonearmGeometry(layout);
    assert.ok(Math.abs(stylusDistanceFromCentre(layout, arm.angleForProgress(0)) - layout.outerRadius) < 1e-6, 'outer groove at 0%');
    assert.ok(Math.abs(stylusDistanceFromCentre(layout, arm.angleForProgress(100)) - layout.innerRadius) < 1e-6, 'run-out at 100%');
    const halfway = (layout.outerRadius + layout.innerRadius) / 2;
    assert.ok(Math.abs(stylusDistanceFromCentre(layout, arm.angleForProgress(50)) - halfway) < 1e-6, 'halfway across the grooves at 50%');
    assert.ok(arm.startAngle < arm.endAngle, 'the arm sweeps inward as the song plays');
    // A lifted arm rests off the record, never over the grooves.
    assert.ok(stylusDistanceFromCentre(layout, arm.liftedAngle) >= layout.outerRadius, 'lifted arm is outside the record');
    for (const progress of [0, 12.5, 40, 77, 100]) {
      assert.ok(Math.abs(arm.progressForAngle(arm.angleForProgress(progress)) - progress) < 1e-6, `round trip at ${progress}%`);
    }
    // Angles beyond the sweep clamp to 0% / 100% instead of extrapolating.
    assert.equal(arm.progressForAngle(arm.startAngle - 40), 0);
    assert.equal(arm.progressForAngle(arm.endAngle + 40), 100);
  }
});

test('the two layouts really do need different angles, which is why they cannot be constants', async () => {
  const { createTonearmGeometry } = await import('./vinylPhysics.js');
  const desktop = createTonearmGeometry({ pivotToCenter: 433, armLength: 411, centerBearing: 34.6, outerRadius: 220, innerRadius: 95 });
  const phone = createTonearmGeometry({ pivotToCenter: 180, armLength: 172, centerBearing: 28, outerRadius: 89, innerRadius: 38 });
  assert.ok(Math.abs(desktop.startAngle - phone.startAngle) > 1 || Math.abs(desktop.endAngle - phone.endAngle) > 1);
});

test('impossible measurements fall back instead of producing NaN angles', async () => {
  const { createTonearmGeometry } = await import('./vinylPhysics.js');
  assert.equal(createTonearmGeometry(), null);
  assert.equal(createTonearmGeometry({ pivotToCenter: 0, armLength: 100, centerBearing: 30, outerRadius: 50, innerRadius: 10 }), null);
  assert.equal(createTonearmGeometry({ pivotToCenter: 100, armLength: 100, centerBearing: 30, outerRadius: 10, innerRadius: 50 }), null, 'inner radius larger than outer');
  assert.equal(createTonearmGeometry({ pivotToCenter: NaN, armLength: 100, centerBearing: 30, outerRadius: 50, innerRadius: 10 }), null);
  // Grooves the arm cannot reach at all (nothing between its minimum and maximum reach) fall back too.
  assert.equal(createTonearmGeometry({ pivotToCenter: 100, armLength: 20, centerBearing: 30, outerRadius: 500, innerRadius: 400 }), null);
});

test('an arm too short to reach the run-out keeps moving to 100% instead of stalling', async () => {
  const { createTonearmGeometry } = await import('./vinylPhysics.js');
  // Measured on the desktop deck: pivot 177.7 px from the record centre, arm only 137.3 px long,
  // so the stylus can never get closer than 40.4 px even though the run-out is at 36.6 px.
  const layout = { pivotToCenter: 177.7, armLength: 137.3, centerBearing: 26.6, outerRadius: 82.3, innerRadius: 36.6 };
  const arm = createTonearmGeometry(layout);
  const reach = Math.abs(layout.pivotToCenter - layout.armLength);
  assert.ok(Math.abs(stylusDistanceFromCentre(layout, arm.angleForProgress(100)) - reach) < 1e-6, '100% lands at the closest reachable point');
  // No dead zone: every step of progress moves the arm, right up to the end.
  let previous = arm.angleForProgress(0);
  for (let progress = 5; progress <= 100; progress += 5) {
    const angle = arm.angleForProgress(progress);
    assert.ok(angle - previous > 0.3, `arm still moving at ${progress}% (moved ${(angle - previous).toFixed(2)} deg)`);
    previous = angle;
  }
  assert.ok(arm.angleForProgress(100) - arm.angleForProgress(95) > 0.5);
  // A record that fits within reach is unaffected by the clamp.
  const roomy = createTonearmGeometry({ pivotToCenter: 433, armLength: 411, centerBearing: 34.6, outerRadius: 220, innerRadius: 95 });
  assert.ok(Math.abs(stylusDistanceFromCentre({ pivotToCenter: 433, armLength: 411, centerBearing: 34.6 }, roomy.angleForProgress(100)) - 95) < 1e-6);
});
