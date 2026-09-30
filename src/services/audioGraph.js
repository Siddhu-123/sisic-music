import {
  EQ_FREQUENCIES,
  EQ_PRESETS,
  EQ_Q,
  bandFilterType,
  clampGain,
  createSoftLimiterCurve,
  headroomDb,
} from './eqMath.js';
import { equalPowerCurve } from './djBeatMath.js';

export { EQ_FREQUENCIES, EQ_PRESETS };

// Parameter changes glide over a few time constants instead of jumping, which
// removes the clicks ("zipper noise") a step change makes while a slider is dragged.
const SMOOTHING_SECONDS = 0.02;

const BASS_SWAP_FREQUENCY = 200;

const flatGains = () => EQ_FREQUENCIES.map(() => 0);

export class AudioGraphManager {
  constructor() {
    this.audioContext = null;
    this.sourceNode = null;
    this.preampNode = null;
    this.masterGainNode = null;
    this.fadeGainNode = null;
    this.bassNode = null;
    this.bassCutDb = 0;
    this.fadeLevel = 1;
    this.fadeRampEndsAt = 0;
    this.duckGainNode = null;
    this.duckLevel = 1;
    this.duckRampEndsAt = 0;
    this.sweepNode = null;
    this.sweepType = 'off';
    this.sweepHz = 20000;
    this.sweepRampEndsAt = 0;
    this.delayNode = null;
    this.feedbackNode = null;
    this.echoGainNode = null;
    this.echoAmount = 0;
    this.echoDelaySeconds = 0;
    this.echoFeedback = 0;
    this.echoConnected = false;
    this.limiterNode = null;
    this.filterNodes = [];
    this.analyserNode = null;
    this.attachedElement = null;
    this.currentPreset = 'flat';
    this.currentGains = flatGains();
    this.enabled = true;
  }

  ensureContext() {
    if (typeof window === 'undefined') return null;
    if (!this.audioContext) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      this.audioContext = new AudioCtx();
    }
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(() => {});
    }
    return this.audioContext;
  }

  // Moves an AudioParam toward `value` smoothly. Falls back to a direct set where unsupported.
  glide(param, value) {
    if (!param || !this.audioContext) return;
    const now = this.audioContext.currentTime;
    if (typeof param.cancelScheduledValues === 'function') param.cancelScheduledValues(now);
    if (typeof param.setTargetAtTime === 'function') param.setTargetAtTime(value, now, SMOOTHING_SECONDS);
    else param.setValueAtTime(value, now);
  }

  /** Total cut, in dB (0 or negative), that keeps the current curve's strongest boost from clipping. */
  get headroomDb() {
    return headroomDb(this.currentGains, this.audioContext ? { sampleRate: this.audioContext.sampleRate } : undefined);
  }

  // Pushes the current gains, headroom and bypass state to the live nodes.
  applyEq() {
    this.filterNodes.forEach((filter, index) => this.glide(filter.gain, this.enabled ? this.currentGains[index] || 0 : 0));
    this.glide(this.preampNode?.gain, this.enabled ? 10 ** (this.headroomDb / 20) : 1);
  }

  attachAudioElement(audioElement) {
    if (!audioElement || typeof window === 'undefined') return null;
    if (this.attachedElement === audioElement && this.sourceNode) return this.audioContext;

    if (this.attachedElement && this.attachedElement !== audioElement) {
      this.detachAudioElement();
    }

    const ctx = this.ensureContext();
    if (!ctx) return null;

    try {
      this.sourceNode = ctx.createMediaElementSource(audioElement);

      // Preamp: turns the signal down by exactly the EQ's strongest boost, so boosting a band
      // can never push a loud track past full scale.
      this.preampNode = ctx.createGain();
      this.preampNode.gain.setValueAtTime(this.enabled ? 10 ** (this.headroomDb / 20) : 1, ctx.currentTime);

      // Master Gain
      this.masterGainNode = ctx.createGain();
      this.masterGainNode.gain.setValueAtTime(1, ctx.currentTime);

      // Analyser for real-time visualizer
      this.analyserNode = ctx.createAnalyser();
      this.analyserNode.fftSize = 128;
      this.analyserNode.smoothingTimeConstant = 0.8;

      // Ten-band graphic EQ, an octave apart, with shelves at both ends.
      this.filterNodes = EQ_FREQUENCIES.map((freq, index) => {
        const filter = ctx.createBiquadFilter();
        filter.type = bandFilterType(index, EQ_FREQUENCIES.length);
        filter.frequency.setValueAtTime(freq, ctx.currentTime);
        if (filter.type === 'peaking') filter.Q.setValueAtTime(EQ_Q, ctx.currentTime);
        filter.gain.setValueAtTime(this.enabled ? this.currentGains[index] || 0 : 0, ctx.currentTime);
        return filter;
      });

      // Safety limiter: identical to the input below -1 dBFS, a smooth knee above it. No latency,
      // no make-up gain, so it is inaudible on normal material and only rounds off stray peaks.
      this.limiterNode = ctx.createWaveShaper();
      this.limiterNode.curve = createSoftLimiterCurve();
      this.limiterNode.oversample = 'none';

      // Source -> preamp -> EQ -> volume -> crossfade -> DJ bass shelf -> duck -> limiter -> analyser -> output.
      let currentNode = this.sourceNode;
      currentNode.connect(this.preampNode);
      currentNode = this.preampNode;
      for (const filter of this.filterNodes) {
        currentNode.connect(filter);
        currentNode = filter;
      }
      currentNode.connect(this.masterGainNode);
      this.fadeGainNode = ctx.createGain();
      this.masterGainNode.connect(this.fadeGainNode);
      // DJ bass swap: a low shelf after the crossfade, flat (0 dB) except while a mix is running.
      this.bassNode = ctx.createBiquadFilter();
      this.bassNode.type = 'lowshelf';
      this.bassNode.frequency.setValueAtTime(BASS_SWAP_FREQUENCY, ctx.currentTime);
      this.bassNode.gain.setValueAtTime(this.bassCutDb, ctx.currentTime);
      this.fadeGainNode.connect(this.bassNode);

      // Swept filter stage: lowpass/highpass/off (off = bypass at 20 kHz lowpass / 10 Hz highpass)
      this.sweepNode = ctx.createBiquadFilter();
      this.sweepNode.type = this.sweepType === 'highpass' ? 'highpass' : 'lowpass';
      this.sweepNode.frequency.setValueAtTime(this.sweepHz, ctx.currentTime);
      this.bassNode.connect(this.sweepNode);

      // Feedback delay send for echo tail
      this.delayNode = ctx.createDelay(5.0);
      this.delayNode.delayTime.setValueAtTime(this.echoDelaySeconds || 0.5, ctx.currentTime);
      this.feedbackNode = ctx.createGain();
      this.feedbackNode.gain.setValueAtTime(Math.min(0.55, Math.max(0, this.echoFeedback || 0)), ctx.currentTime);
      this.echoGainNode = ctx.createGain();
      this.echoGainNode.gain.setValueAtTime(this.echoAmount || 0, ctx.currentTime);

      this.delayNode.connect(this.feedbackNode);
      this.feedbackNode.connect(this.delayNode);
      this.delayNode.connect(this.echoGainNode);

      this.duckGainNode = ctx.createGain();
      this.duckGainNode.gain.setValueAtTime(this.duckLevel, ctx.currentTime);
      this.sweepNode.connect(this.duckGainNode);
      this.sweepNode.connect(this.delayNode);

      this.duckGainNode.connect(this.limiterNode);

      if (this.echoAmount > 0) {
        this.echoGainNode.connect(this.limiterNode);
        this.echoConnected = true;
      }

      this.limiterNode.connect(this.analyserNode);
      this.analyserNode.connect(ctx.destination);
      this.attachedElement = audioElement;

      return ctx;
    } catch (err) {
      console.warn('Web Audio Graph initialization warning:', err);
      this.disconnectNodes();
      return null;
    }
  }

  isAttachedTo(audioElement) {
    return this.attachedElement === audioElement && Boolean(this.sourceNode);
  }

  disconnectNodes() {
    this.sourceNode?.disconnect?.();
    this.preampNode?.disconnect?.();
    this.filterNodes.forEach(node => node?.disconnect?.());
    this.masterGainNode?.disconnect?.();
    this.fadeGainNode?.disconnect?.();
    this.bassNode?.disconnect?.();
    this.sweepNode?.disconnect?.();
    this.duckGainNode?.disconnect?.();
    this.delayNode?.disconnect?.();
    this.feedbackNode?.disconnect?.();
    this.echoGainNode?.disconnect?.();
    this.limiterNode?.disconnect?.();
    this.analyserNode?.disconnect?.();
    this.sourceNode = null;
    this.preampNode = null;
    this.filterNodes = [];
    this.masterGainNode = null;
    this.fadeGainNode = null;
    this.fadeLevel = 1;
    this.fadeRampEndsAt = 0;
    this.duckGainNode = null;
    this.duckLevel = 1;
    this.duckRampEndsAt = 0;
    this.bassNode = null;
    this.sweepNode = null;
    this.sweepType = 'off';
    this.sweepHz = 20000;
    this.sweepRampEndsAt = 0;
    this.delayNode = null;
    this.feedbackNode = null;
    this.echoGainNode = null;
    this.echoAmount = 0;
    this.echoDelaySeconds = 0;
    this.echoFeedback = 0;
    this.echoConnected = false;
    this.limiterNode = null;
    this.analyserNode = null;
    this.attachedElement = null;
  }

  detachAudioElement() {
    this.disconnectNodes();
  }

  setVolume(volume) {
    const clamped = Math.max(0, Math.min(1, Number(volume) || 0));
    if (this.masterGainNode && this.audioContext) {
      const gain = this.masterGainNode.gain;
      gain.cancelScheduledValues(this.audioContext.currentTime);
      gain.setTargetAtTime(clamped, this.audioContext.currentTime, 0.015);
    }
  }

  /**
   * Ramps the crossfade gain. `curve: 'equal-power'` uses cos/sin gains, which keep the summed power of
   * two unrelated signals constant; linear ramps dip 3 dB at the midpoint of a mix.
   */
  setFade(value, seconds = 0, { curve = 'linear' } = {}) {
    if (!this.fadeGainNode || !this.audioContext) return false;
    const gain = this.fadeGainNode.gain;
    const now = this.audioContext.currentTime;
    // `gain.value` only reflects a change after the next render quantum (and not at all while the
    // context is starting), so a fade requested right after another would start from a stale value.
    // Start from the level last asked for, unless a ramp is still running and the live value is exact.
    const start = now < this.fadeRampEndsAt ? gain.value : this.fadeLevel;
    this.fadeLevel = value;
    this.fadeRampEndsAt = seconds > 0 ? now + seconds : 0;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(start, now);
    if (seconds <= 0) gain.setValueAtTime(value, now);
    else if (curve === 'equal-power' && Math.abs(start - (value === 0 ? 1 : 0)) < 0.02 && (value === 0 || value === 1)) {
      gain.setValueCurveAtTime(equalPowerCurve(value === 1 ? 'in' : 'out'), now, seconds);
    } else gain.linearRampToValueAtTime(value, now + seconds);
    return true;
  }

  /** Cuts (negative dB) or restores (0) the low end below ~200 Hz. Used to swap basslines during a mix. */
  setBassCut(db, seconds = 0) {
    this.bassCutDb = Math.max(-36, Math.min(0, Number(db) || 0));
    if (!this.bassNode || !this.audioContext) return false;
    const gain = this.bassNode.gain;
    const now = this.audioContext.currentTime;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    if (seconds > 0) gain.linearRampToValueAtTime(this.bassCutDb, now + seconds);
    else gain.setValueAtTime(this.bassCutDb, now);
    return true;
  }

  /**
   * Ducks audio gain by specified decibels (db <= 0).
   * Ramps it, tracks its own JS level to avoid stale reads, and resets on disconnect.
   */
  setDuck(db, seconds = 0) {
    if (!this.duckGainNode || !this.audioContext) return false;
    const gain = this.duckGainNode.gain;
    const now = this.audioContext.currentTime;
    const target = 10 ** ((Number(db) || 0) / 20);
    const start = now < this.duckRampEndsAt ? gain.value : this.duckLevel;
    this.duckLevel = target;
    this.duckRampEndsAt = seconds > 0 ? now + seconds : 0;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(start, now);
    if (seconds <= 0) gain.setValueAtTime(target, now);
    else gain.linearRampToValueAtTime(target, now + seconds);
    return true;
  }

  /**
   * Swept filter stage for DJ mixes: 'lowpass' | 'highpass' | 'off'.
   * Off bypasses at 20 kHz lowpass / 10 Hz highpass so there is no audible colouring.
   */
  setSweep(type = 'off', hz, seconds = 0) {
    if (type === 'lowpass' || type === 'highpass') {
      this.sweepType = type;
    } else {
      this.sweepType = 'off';
    }

    let targetHz;
    if (Number.isFinite(hz)) {
      targetHz = hz;
    } else if (this.sweepType === 'highpass' || (this.sweepNode && this.sweepNode.type === 'highpass')) {
      targetHz = 10;
    } else {
      targetHz = 20000;
    }

    const previousHz = this.sweepHz;
    this.sweepHz = targetHz;

    if (!this.sweepNode || !this.audioContext) return false;

    const param = this.sweepNode.frequency;
    const now = this.audioContext.currentTime;
    const start = now < this.sweepRampEndsAt ? param.value : previousHz;
    this.sweepRampEndsAt = seconds > 0 ? now + seconds : 0;

    param.cancelScheduledValues(now);
    param.setValueAtTime(start, now);

    if (this.sweepType === 'lowpass' || this.sweepType === 'highpass') {
      this.sweepNode.type = this.sweepType;
    }

    if (seconds <= 0) {
      param.setValueAtTime(targetHz, now);
      if (this.sweepType === 'off') {
        this.sweepNode.type = targetHz <= 20 ? 'highpass' : 'lowpass';
      }
    } else {
      param.linearRampToValueAtTime(targetHz, now + seconds);
    }
    return true;
  }

  /**
   * Feedback delay send for the DJ echo tail.
   * Feedback is capped at 0.55. Amount 0 is fully dry and disconnected from the output sum.
   */
  setEcho(amount = 0, delaySeconds = 0, feedback = 0.55) {
    const targetAmount = Math.max(0, Number(amount) || 0);
    this.echoAmount = targetAmount;
    if (delaySeconds != null && Number(delaySeconds) > 0) {
      this.echoDelaySeconds = Number(delaySeconds);
    }
    const fb = Math.min(0.55, Math.max(0, Number(feedback ?? 0.55) || 0));
    this.echoFeedback = fb;

    if (!this.echoGainNode || !this.delayNode || !this.feedbackNode || !this.audioContext) return false;

    const now = this.audioContext.currentTime;
    if (targetAmount > 0) {
      if (!this.echoConnected && this.limiterNode) {
        this.echoGainNode.connect(this.limiterNode);
        this.echoConnected = true;
      }
      this.echoGainNode.gain.cancelScheduledValues(now);
      this.echoGainNode.gain.setValueAtTime(targetAmount, now);

      if (this.echoDelaySeconds > 0) {
        this.delayNode.delayTime.cancelScheduledValues(now);
        this.delayNode.delayTime.setValueAtTime(this.echoDelaySeconds, now);
      }

      this.feedbackNode.gain.cancelScheduledValues(now);
      this.feedbackNode.gain.setValueAtTime(fb, now);
    } else {
      this.echoGainNode.gain.cancelScheduledValues(now);
      this.echoGainNode.gain.setValueAtTime(0, now);
      if (this.echoConnected) {
        this.echoGainNode.disconnect();
        this.echoConnected = false;
      }
    }
    return true;
  }

  /** Turns the whole EQ (bands and headroom) on or off without losing the settings. */
  setEnabled(enabled) {
    this.enabled = enabled !== false;
    this.applyEq();
  }

  setBandGain(bandIndex, gainDb) {
    if (!Number.isInteger(bandIndex) || bandIndex < 0 || bandIndex >= EQ_FREQUENCIES.length) return;
    this.currentGains[bandIndex] = clampGain(gainDb);
    this.currentPreset = 'custom';
    this.applyEq();
  }

  /** Sets every band at once (used for saved custom presets). */
  setGains(gains) {
    this.currentGains = EQ_FREQUENCIES.map((_, index) => clampGain(gains?.[index]));
    this.currentPreset = 'custom';
    this.applyEq();
  }

  applyPreset(presetKey) {
    const preset = EQ_PRESETS[presetKey];
    if (!preset) return;
    this.currentPreset = presetKey;
    this.currentGains = [...preset.gains];
    this.applyEq();
  }

  getFrequencyData() {
    if (!this.analyserNode) return new Uint8Array(32);
    const data = new Uint8Array(this.analyserNode.frequencyBinCount);
    this.analyserNode.getByteFrequencyData(data);
    return data;
  }

  getWaveformData() {
    if (!this.analyserNode) return new Uint8Array(32);
    const data = new Uint8Array(this.analyserNode.fftSize);
    this.analyserNode.getByteTimeDomainData(data);
    return data;
  }

  dispose() {
    this.detachAudioElement();
    this.audioContext?.close?.().catch?.(() => {});
    this.audioContext = null;
  }
}

export const audioGraph = new AudioGraphManager();
