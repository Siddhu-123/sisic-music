export const VINYL_RPM = 45;
export const VINYL_SECONDS_PER_TURN = 60 / VINYL_RPM;
// The record starts at the outer groove (0%) and travels inward toward the center label (100%).
// These angles keep the stylus strictly on the vinyl grooves instead of swinging off the deck.
export const TONEARM_START_ANGLE = 2;
export const TONEARM_END_ANGLE = 21;
// Rest position just outside the record edge, so a lifted arm never hovers over the grooves.
export const TONEARM_LIFTED_ANGLE = -9;

export const MOTOR_ACCEL_TIME_CONSTANT_MS = 180;
export const MOTOR_BRAKE_TIME_CONSTANT_MS = 150;
export const INERTIA_TIME_CONSTANT_MS = 190;

export function inertiaVelocity(initial, target, elapsed, timeConstantMs = INERTIA_TIME_CONSTANT_MS) {
  const elapsedMs = Math.max(0, Number(elapsed) || 0);
  const timeConstant = Math.max(1, Number(timeConstantMs) || INERTIA_TIME_CONSTANT_MS);
  return target + ((initial - target) * Math.exp(-elapsedMs / timeConstant));
}

/** Physical platter speed for an RPM selector value (the "33" setting is 33⅓). */
export function physicalRpm(rpm = VINYL_RPM) {
  const value = Number(rpm) || VINYL_RPM;
  return value === 33 ? 100 / 3 : value;
}

export function vinylSecondsPerTurn(rpm = VINYL_RPM, pitchModifier = 1) {
  const safeRpm = Math.max(1, physicalRpm(rpm));
  const safePitch = Math.max(0.01, Number(pitchModifier) || 1);
  return 60 / (safeRpm * safePitch);
}

export function calculateMotorTargetVelocity({
  isPlaying = false,
  isBuffering = false,
  hasCurrentSong = true,
  dragMode = null,
  rpm = VINYL_RPM,
  pitchModifier = 1,
} = {}) {
  const isRunning = Boolean(
    hasCurrentSong
    && isPlaying
    && !isBuffering
    && dragMode !== 'record'
  );
  if (!isRunning) return 0;
  return 360 / vinylSecondsPerTurn(rpm, pitchModifier);
}

export function stepMotorVelocity(currentVelocity, targetVelocity, elapsedMs, { isBraking = false } = {}) {
  const current = Number(currentVelocity) || 0;
  const target = Number(targetVelocity) || 0;
  const elapsed = Math.max(0, Number(elapsedMs) || 0);

  const timeConstant = target > 0
    ? MOTOR_ACCEL_TIME_CONSTANT_MS
    : (isBraking ? MOTOR_BRAKE_TIME_CONSTANT_MS : MOTOR_BRAKE_TIME_CONSTANT_MS);

  const nextVelocity = inertiaVelocity(current, target, elapsed, timeConstant);

  if (target === 0 && Math.abs(nextVelocity) < 0.1) {
    return 0;
  }
  return nextVelocity;
}

export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function wrappedAngleDelta(previous, next) {
  let delta = next - previous;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

export function vinylSecondsFromDegrees(degrees) {
  return (degrees / 360) * VINYL_SECONDS_PER_TURN;
}

export function tonearmProgressFromAngle(angle) {
  const minAngle = Math.min(TONEARM_START_ANGLE, TONEARM_END_ANGLE);
  const maxAngle = Math.max(TONEARM_START_ANGLE, TONEARM_END_ANGLE);
  const armAngle = clamp(angle, minAngle, maxAngle);
  return ((armAngle - TONEARM_START_ANGLE) / (TONEARM_END_ANGLE - TONEARM_START_ANGLE)) * 100;
}

export function tonearmAngleFromProgress(progress) {
  const boundedProgress = clamp(progress, 0, 100);
  return TONEARM_START_ANGLE + ((TONEARM_END_ANGLE - TONEARM_START_ANGLE) * (boundedProgress / 100));
}

const DEG = Math.PI / 180;

/**
 * Tonearm geometry solved from the rendered deck. Angles use the tonearm's own
 * convention (degrees below horizontal-left of the pivot). Progress maps
 * linearly to groove radius (outer lead-in to inner run-out), and the law of
 * cosines turns a radius into the arm angle that puts the stylus on it. Fixed
 * angles cannot work at every breakpoint because layouts change the arm length
 * and pivot, so the stylus would miss the grooves on some screens.
 */
export function createTonearmGeometry({ pivotToCenter, armLength, centerBearing, outerRadius: wantedOuter, innerRadius: wantedInner } = {}) {
  const numbersOk = [pivotToCenter, armLength, centerBearing, wantedOuter, wantedInner].every(Number.isFinite)
    && pivotToCenter > 0 && armLength > 0 && wantedOuter > wantedInner && wantedInner >= 0;
  if (!numbersOk) return null;
  const D = pivotToCenter;
  const L = armLength;
  // A rigid arm can only reach radii between |D - L| and D + L from the record centre. If the
  // grooves extend past that, spread progress over the reachable span so the arm keeps moving
  // all the way to 100% instead of stalling at its limit while the song plays on.
  const outerRadius = Math.min(wantedOuter, D + L);
  const innerRadius = Math.max(wantedInner, Math.abs(D - L));
  if (!(outerRadius > innerRadius)) return null;
  const angleForRadius = radius => {
    const cosine = clamp(((D * D) + (L * L) - (radius * radius)) / (2 * D * L), -1, 1);
    return centerBearing - (Math.acos(cosine) / DEG);
  };
  const radiusForAngle = angle => Math.sqrt(Math.max(0, (D * D) + (L * L) - (2 * D * L * Math.cos((centerBearing - angle) * DEG))));
  const startAngle = angleForRadius(outerRadius);
  const endAngle = angleForRadius(innerRadius);
  // Rest position: just outside the record edge, never hovering over the grooves.
  const restAngle = angleForRadius(outerRadius * 1.14);
  return {
    startAngle,
    endAngle,
    liftedAngle: Math.min(startAngle - 3, restAngle),
    angleForProgress: progress => angleForRadius(outerRadius - ((outerRadius - innerRadius) * clamp(progress, 0, 100) / 100)),
    progressForAngle: angle => clamp(((outerRadius - radiusForAngle(clamp(angle, startAngle, endAngle))) / (outerRadius - innerRadius)) * 100, 0, 100),
  };
}
