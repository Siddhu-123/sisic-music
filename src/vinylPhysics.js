export const VINYL_RPM = 45;
export const VINYL_SECONDS_PER_TURN = 60 / VINYL_RPM;
// The record starts at the outer groove (0%) and travels inward toward the center label (100%).
// These angles keep the stylus strictly on the vinyl grooves instead of swinging off the deck.
export const TONEARM_START_ANGLE = 22;
export const TONEARM_END_ANGLE = 42;
export const TONEARM_LIFTED_ANGLE = 10;

export function vinylSecondsPerTurn(rpm = VINYL_RPM, pitchModifier = 1) {
  const safeRpm = Math.max(1, Number(rpm) || VINYL_RPM);
  const safePitch = Math.max(0.01, Number(pitchModifier) || 1);
  return 60 / (safeRpm * safePitch);
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
