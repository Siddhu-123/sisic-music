// Beat-grid arithmetic for DJ mixing. Pure functions over the compact `djRhythm` record the Mac
// worker stores per song (Beat This! beat/downbeat tracking, ISMIR 2024):
//   { bpm, firstDownbeat, barBeats, gridCoverage, downbeatAgreement, introEnd, introBars, outroStart,
//     outroBars, introBpm, outroBpm, ... }
// Times are seconds of the song's own timeline. "Rate" is the playback rate applied to that song.

export const MAX_TEMPO_STRETCH = 0.08; // A pitch fader on a turntable is +-8%; beyond that a beat-match sounds wrong.
export const MIN_GRID_COVERAGE = 0.6; // Below this the track is rubato and a constant beat grid would lie.
export const MIN_DOWNBEAT_AGREEMENT = 0.6; // Below this we align beat to beat, not bar to bar.

const finite = value => Number.isFinite(value);
const positive = value => finite(value) && value > 0;
const mod = (value, size) => ((value % size) + size) % size;

/** A record is usable for beat-syncing only when it has a tempo and a grid that describes the track. */
export function hasBeatGrid(rhythm) {
  return Boolean(rhythm) && rhythm.rhythmStatus !== 'no-beats'
    && positive(rhythm.bpm) && finite(rhythm.firstDownbeat)
    && (rhythm.gridCoverage == null || rhythm.gridCoverage >= MIN_GRID_COVERAGE);
}

export function barBeatsOf(rhythm) {
  const beats = Number(rhythm?.barBeats);
  return Number.isInteger(beats) && beats >= 2 && beats <= 12 ? beats : 4;
}

/** Seconds per beat of the song's own timeline at a given moment, using the local tempo near cues. */
export function beatSeconds(rhythm, bpmOverride) {
  const bpm = positive(bpmOverride) ? bpmOverride : rhythm?.bpm;
  return positive(bpm) ? 60 / bpm : null;
}

/**
 * The playback-rate multiplier that makes `incomingBpm` sound at `targetBpm`, folded by octaves so a
 * 70 bpm ballad can lock to a 140 bpm track (two beats per beat). `matchable` is false when the
 * remaining stretch is beyond a believable pitch-fader move.
 */
export function tempoMatch(targetBpm, incomingBpm, maxStretch = MAX_TEMPO_STRETCH) {
  if (!positive(targetBpm) || !positive(incomingBpm)) return { ratio: 1, octave: 0, stretch: null, matchable: false };
  let best = { octave: 0, error: Infinity };
  for (const octave of [-1, 0, 1]) {
    const error = Math.abs(Math.log((incomingBpm * 2 ** octave) / targetBpm));
    if (error < best.error) best = { octave, error };
  }
  const ratio = targetBpm / (incomingBpm * 2 ** best.octave);
  const stretch = ratio - 1;
  return { ratio, octave: best.octave, stretch, matchable: Math.abs(stretch) <= maxStretch };
}

/** Semitones a rate change moves the pitch, as a turntable's pitch fader does. */
export const semitonesForRate = rate => (positive(rate) ? 12 * Math.log2(rate) : 0);

/** Position inside the bar, in beats [0, barBeats), of a song time. */
export function barPhaseBeats(rhythm, time) {
  const beat = beatSeconds(rhythm);
  if (!beat || !finite(time)) return null;
  return mod((time - rhythm.firstDownbeat) / beat, barBeatsOf(rhythm));
}

/** Align bar to bar only when both tracks' downbeats are trustworthy, otherwise beat to beat. */
export function alignmentUnit(a, b) {
  const trusted = rhythm => (rhythm.downbeatAgreement ?? 0) >= MIN_DOWNBEAT_AGREEMENT;
  return trusted(a) && trusted(b) && barBeatsOf(a) === barBeatsOf(b) ? 'bar' : 'beat';
}

/**
 * Where to start the incoming song so its beat (or bar) phase equals the outgoing song's at the
 * same instant. Returns a song time inside the incoming track's first bar, so the incoming intro
 * plays underneath the outgoing outro. `octave` is the fold `tempoMatch` chose.
 */
export function incomingStartPosition(out, outTime, incoming, octave = 0) {
  const outBeat = beatSeconds(out);
  const inBeat = beatSeconds(incoming);
  if (!outBeat || !inBeat || !finite(outTime)) return null;
  const unit = alignmentUnit(out, incoming);
  const unitBeats = unit === 'bar' ? barBeatsOf(incoming) : 1;
  // Phase within the alignment unit, in musical beats. `tempoMatch` folds the incoming tempo by
  // `octave` (incoming bpm * 2^octave ~ outgoing bpm), so one incoming beat spans 2^octave outgoing beats.
  const outBeats = (outTime - out.firstDownbeat) / outBeat;
  const phase = mod(outBeats * 2 ** -octave, unitBeats);
  const start = incoming.firstDownbeat + phase * inBeat;
  return { position: Math.max(0, start), unit, phaseBeats: phase };
}

/**
 * Seconds the incoming song is ahead (+) or behind (-) of perfect alignment, in its own timeline,
 * wrapped to half an alignment unit. Used once after the incoming starts to nudge it into lock.
 */
export function phaseErrorSeconds(out, outTime, incoming, inTime, octave = 0) {
  const outBeat = beatSeconds(out);
  const inBeat = beatSeconds(incoming);
  if (!outBeat || !inBeat || !finite(outTime) || !finite(inTime)) return null;
  const unit = alignmentUnit(out, incoming);
  const unitBeats = unit === 'bar' ? barBeatsOf(incoming) : 1;
  const outPhase = mod(((outTime - out.firstDownbeat) / outBeat) * 2 ** -octave, unitBeats);
  const inPhase = mod((inTime - incoming.firstDownbeat) / inBeat, unitBeats);
  let difference = inPhase - outPhase;
  if (difference > unitBeats / 2) difference -= unitBeats;
  if (difference < -unitBeats / 2) difference += unitBeats;
  return difference * inBeat;
}

/** Downbeat times of a song from `from` to `to` (inclusive), for snapping a transition to a bar. */
export function downbeatsBetween(rhythm, from, to) {
  const beat = beatSeconds(rhythm);
  if (!beat || !finite(from) || !finite(to) || to < from) return [];
  const bar = beat * barBeatsOf(rhythm);
  const first = Math.ceil((from - rhythm.firstDownbeat) / bar - 1e-9);
  const out = [];
  for (let index = first; rhythm.firstDownbeat + index * bar <= to + 1e-9; index += 1) out.push(rhythm.firstDownbeat + index * bar);
  return out;
}

/** The latest downbeat at or before `time` (used to leave on a bar line). */
export function downbeatAtOrBefore(rhythm, time) {
  const beat = beatSeconds(rhythm);
  if (!beat || !finite(time)) return null;
  const bar = beat * barBeatsOf(rhythm);
  const index = Math.floor((time - rhythm.firstDownbeat) / bar + 1e-9);
  return index < 0 ? null : rhythm.firstDownbeat + index * bar;
}

/**
 * How long a mix should last, in whole bars of the outgoing song: as long as both tracks' quiet
 * ends allow, capped at 16 bars, and never shorter than 2 bars (or the requested fade).
 */
export function mixBars({ outroBars, introBars, wantedBars = 8 } = {}) {
  // Zero is real information (an abrupt end, or an intro that starts at full energy): keep it short.
  const room = [outroBars, introBars].filter(value => Number.isFinite(value) && value >= 0);
  const limit = room.length ? Math.min(...room) : wantedBars;
  const bars = Math.min(16, wantedBars, Math.max(limit, 2));
  return [16, 8, 4, 2].find(candidate => candidate <= bars) || 2;
}

/**
 * Equal-power fade curves. Two uncorrelated signals mixed with linear gains dip 3 dB at the
 * midpoint; cos/sin gains keep total power constant. Returns Float32Arrays for setValueCurveAtTime.
 */
export function equalPowerCurve(direction, steps = 128) {
  const curve = new Float32Array(steps);
  for (let index = 0; index < steps; index += 1) {
    const x = index / (steps - 1);
    curve[index] = direction === 'in' ? Math.sin(x * Math.PI / 2) : Math.cos(x * Math.PI / 2);
  }
  return curve;
}

const inRange = (value, min, max) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
};

/**
 * Whitelists and bounds a rhythm record from the index (untrusted: it comes from a Drive file).
 * Unknown fields are dropped; out-of-range numbers are dropped rather than clamped, so a corrupt
 * record can only make a song ineligible for beat-syncing, never mis-sync it.
 */
export function sanitizeRhythm(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = {};
  const numbers = {
    rhythmVersion: [0, 100], bpm: [30, 300], firstBeat: [0, 3600], firstDownbeat: [0, 3600], barBeats: [2, 12], beatCount: [0, 100000],
    gridDeviationMs: [0, 5000], gridCoverage: [0, 1], downbeatAgreement: [0, 1], introEnd: [0, 7200], introBars: [0, 512],
    outroStart: [0, 7200], outroBars: [0, 512], duration: [0, 7200], introBpm: [30, 300], outroBpm: [30, 300],
  };
  for (const [field, [min, max]] of Object.entries(numbers)) {
    const number = inRange(value[field], min, max);
    if (number != null) record[field] = field === 'barBeats' || field.endsWith('Bars') || field === 'beatCount' || field === 'rhythmVersion' ? Math.round(number) : number;
  }
  if (typeof value.abruptEnd === 'boolean') record.abruptEnd = value.abruptEnd;
  record.rhythmStatus = value.rhythmStatus === 'ready' ? 'ready' : 'no-beats';
  if (typeof value.beatTracker === 'string') record.beatTracker = value.beatTracker.slice(0, 40);
  return record.rhythmStatus === 'ready' && record.bpm != null && record.firstDownbeat != null ? record : null;
}
