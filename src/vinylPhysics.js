export const VINYL_RPM = 45;
export const VINYL_SECONDS_PER_TURN = 60 / VINYL_RPM;
export const TONEARM_START_ANGLE = -42;
export const TONEARM_END_ANGLE = -12;
export const TONEARM_LIFTED_ANGLE = 6;

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
  const armAngle = clamp(angle, TONEARM_START_ANGLE, TONEARM_END_ANGLE);
  return ((armAngle - TONEARM_START_ANGLE) / (TONEARM_END_ANGLE - TONEARM_START_ANGLE)) * 100;
}

export function tonearmAngleFromProgress(progress) {
  const boundedProgress = clamp(progress, 0, 100);
  return TONEARM_START_ANGLE + ((TONEARM_END_ANGLE - TONEARM_START_ANGLE) * (boundedProgress / 100));
}
