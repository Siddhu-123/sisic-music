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

/** Physical platter speed for an RPM selector value (the "33" button is 33⅓). */
export function physicalRpm(rpm) {
  return Number(rpm) < 40 ? 100 / 3 : 45;
}

/**
 * Eases platter velocity toward a target with a first-order lag, so motor
 * spin-up, braking and post-scratch settling are continuous and frame-rate independent.
 */
export function stepPlatterVelocity(velocity, target, dtSeconds, timeConstantSeconds) {
  if (!(timeConstantSeconds > 0)) return target;
  return target + ((velocity - target) * Math.exp(-Math.max(0, dtSeconds) / timeConstantSeconds));
}

const DEG = Math.PI / 180;

/**
 * Tonearm geometry solved from the rendered deck. Angles use the tonearm's own
 * convention (degrees below horizontal-left of the pivot). Progress maps
 * linearly to groove radius (outer lead-in → inner run-out), and the law of
 * cosines turns a radius into the arm angle that puts the stylus on it.
 */
export function createTonearmGeometry({ pivotToCenter, armLength, centerBearing, outerRadius, innerRadius } = {}) {
  const valid = [pivotToCenter, armLength, centerBearing, outerRadius, innerRadius].every(Number.isFinite)
    && pivotToCenter > 0 && armLength > 0 && outerRadius > innerRadius && innerRadius >= 0;
  if (!valid) return null;
  const D = pivotToCenter;
  const L = armLength;
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
