// Beat-grid arithmetic for DJ mixing. Pure functions over the compact `djRhythm` record the Mac
// worker stores per song (Beat This! beat/downbeat tracking, ISMIR 2024):
//   { bpm, firstDownbeat, barBeats, gridCoverage, downbeatAgreement, introEnd, introBars, outroStart,
//     outroBars, introBpm, outroBpm, ... }
// Times are seconds of the song's own timeline. "Rate" is the playback rate applied to that song.

export const MAX_TEMPO_STRETCH = 0.08; // A pitch fader on a turntable is +-8%; beyond that a beat-match sounds wrong.
export const MIN_GRID_COVERAGE = 0.6; // Below this the track is rubato and a constant beat grid would lie.
export const MIN_DOWNBEAT_AGREEMENT = 0.6; // Below this we align beat to beat, not bar to bar.
export const MAX_FOLLOW_RATE_STEP = 0.04; // Maximum relative PLL rate correction per step.

const finite = value => Number.isFinite(value);
const positive = value => finite(value) && value > 0;
const mod = (value, size) => ((value % size) + size) % size;

/**
 * Decodes a stored beat list of integer ms values [t0_ms, gap1_ms, gap2_ms, ...] into an array
 * of song-timeline beat positions in seconds. Null unless it is an array of 3..66 finite ints
 * with t0 >= 0 and every gap between 200 and 3000 ms.
 */
export function decodeBeatList(list) {
  if (!Array.isArray(list) || list.length < 3 || list.length > 66) return null;
  const t0 = list[0];
  if (!Number.isInteger(t0) || t0 < 0) return null;
  const decoded = new Array(list.length);
  decoded[0] = t0 / 1000;
  let currentMs = t0;
  for (let i = 1; i < list.length; i += 1) {
    const gap = list[i];
    if (!Number.isInteger(gap) || gap < 200 || gap > 3000) return null;
    currentMs += gap;
    decoded[i] = currentMs / 1000;
  }
  return decoded;
}

/**
 * Fractional beat index by linear interpolation between neighbouring beats; outside the list
 * extrapolate with the nearest local period (first/last gap); NaN for an empty or one-beat list.
 * Binary search, plain arithmetic, no allocations.
 */
export function beatIndexAt(beats, time) {
  if (!Array.isArray(beats) || beats.length < 2 || !Number.isFinite(time)) return NaN;
  const last = beats.length - 1;
  if (time <= beats[0]) {
    const gap = beats[1] - beats[0];
    return gap > 0 ? (time - beats[0]) / gap : 0;
  }
  if (time >= beats[last]) {
    const gap = beats[last] - beats[last - 1];
    return gap > 0 ? last + (time - beats[last]) / gap : last;
  }
  let low = 0;
  let high = last - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (time < beats[mid]) {
      high = mid - 1;
    } else if (time > beats[mid + 1]) {
      low = mid + 1;
    } else {
      const gap = beats[mid + 1] - beats[mid];
      return gap > 0 ? mid + (time - beats[mid]) / gap : mid;
    }
  }
  return NaN;
}

/**
 * Inverse of beatIndexAt: maps a fractional beat index to song time in seconds with the same extrapolation.
 */
export function timeAtBeatIndex(beats, index) {
  if (!Array.isArray(beats) || beats.length < 2 || !Number.isFinite(index)) return NaN;
  const last = beats.length - 1;
  if (index <= 0) {
    const gap = beats[1] - beats[0];
    return beats[0] + index * gap;
  }
  if (index >= last) {
    const gap = beats[last] - beats[last - 1];
    return beats[last] + (index - last) * gap;
  }
  const i = Math.floor(index);
  const gap = beats[i + 1] - beats[i];
  return beats[i] + (index - i) * gap;
}

/**
 * The beat period in seconds around the given song time, averaged over up to 2 * halfWindow beats.
 * The tracker reports beats on a 20 ms grid, so one gap alone can be 3 % off; a window averages that out
 * while still following a real tempo change.
 */
export function localPeriodAt(beats, time, halfWindow = 4) {
  if (!Array.isArray(beats) || beats.length < 2 || !Number.isFinite(time)) return NaN;
  const last = beats.length - 1;
  const index = beatIndexAt(beats, time);
  if (!Number.isFinite(index)) return NaN;
  const interval = Math.max(0, Math.min(last - 1, Math.floor(index)));
  const lo = Math.max(0, interval + 1 - halfWindow);
  const hi = Math.min(last, interval + halfWindow);
  return (beats[hi] - beats[lo]) / (hi - lo);
}

/**
 * Establishes the beat correspondence at the moment of lock between outgoing and incoming tracks.
 * k0 = Math.round(beatIndexAt(inBeats, inTime) - beatIndexAt(outBeats, outTime) * 2 ** -octave).
 */
export function beatFollower({ outBeats, inBeats, octave = 0, outTime, inTime } = {}) {
  const inIdx = beatIndexAt(inBeats, inTime);
  const outIdx = beatIndexAt(outBeats, outTime);
  if (!Number.isFinite(inIdx) || !Number.isFinite(outIdx) || !Number.isFinite(octave)) return null;
  const k0 = Math.round(inIdx - outIdx * 2 ** -octave);
  if (!Number.isFinite(k0)) return null;
  return { outBeats, inBeats, octave, k0 };
}

/**
 * Computes the incoming playback rate using feed-forward tempo matching and PLL phase correction.
 */
export function followerStep(follower, { outTime, inTime, outRate = 1, tau = 0.8, maxCorrection = MAX_FOLLOW_RATE_STEP } = {}) {
  if (!follower || !follower.outBeats || !follower.inBeats) return null;
  const { outBeats, inBeats, octave = 0, k0 = 0 } = follower;
  const outIdx = beatIndexAt(outBeats, outTime);
  if (!Number.isFinite(outIdx) || !Number.isFinite(inTime)) {
    return { rate: NaN, errorSeconds: NaN, desiredInTime: NaN };
  }
  const idx = outIdx * 2 ** -octave + k0;
  const desiredInTime = timeAtBeatIndex(inBeats, idx);
  const errorSeconds = inTime - desiredInTime;
  const localPeriodOut = localPeriodAt(outBeats, outTime);
  const localPeriodIn = localPeriodAt(inBeats, inTime);
  const feedForward = (localPeriodIn * outRate * 2 ** -octave) / localPeriodOut;
  const normalizedError = tau > 0 ? errorSeconds / tau : 0;
  const correction = Math.min(Math.max(normalizedError, -maxCorrection), maxCorrection);
  const rate = feedForward * (1 - correction);
  return { rate, errorSeconds, desiredInTime };
}

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
    startBpm: [30, 300], beatListVersion: [0, 64], introVirtual: [0, 64], outroVirtual: [0, 64],
  };
  const intFields = new Set(['barBeats', 'beatCount', 'rhythmVersion', 'beatListVersion', 'introBars', 'outroBars', 'introVirtual', 'outroVirtual']);
  for (const [field, [min, max]] of Object.entries(numbers)) {
    const number = inRange(value[field], min, max);
    if (number != null) {
      if (intFields.has(field)) {
        if (Number.isInteger(number)) record[field] = number;
      } else {
        record[field] = number;
      }
    }
  }
  if (typeof value.abruptEnd === 'boolean') record.abruptEnd = value.abruptEnd;
  record.rhythmStatus = value.rhythmStatus === 'ready' ? 'ready' : 'no-beats';
  if (typeof value.beatTracker === 'string') record.beatTracker = value.beatTracker.slice(0, 40);
  for (const field of ['introBeats', 'outroBeats']) {
    if (Array.isArray(value[field])) {
      const trimmed = value[field].slice(0, 66);
      if (decodeBeatList(trimmed)) record[field] = trimmed;
    }
  }
  return record.rhythmStatus === 'ready' && record.bpm != null && record.firstDownbeat != null ? record : null;
}

