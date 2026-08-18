import { EQ_FREQUENCIES, EQ_PRESETS } from './audioGraph.js';

export const VINYL_PITCH_LIMITS = {
  narrow: 0.08,
  wide: 0.16,
};

export function clampAudioRate(rate, minimum = -8, maximum = 8) {
  return Math.max(minimum, Math.min(maximum, Number(rate) || 0));
}

export function playbackRateFromAngularVelocity(angularVelocity, nominalAngularVelocity, pitchModifier = 1) {
  if (!Number.isFinite(angularVelocity) || !Number.isFinite(nominalAngularVelocity) || nominalAngularVelocity === 0) return 0;
  return clampAudioRate((angularVelocity / nominalAngularVelocity) * pitchModifier);
}

export function exponentialInertiaVelocity(initialVelocity, targetVelocity, elapsedMs, timeConstantMs = 190) {
  const elapsed = Math.max(0, Number(elapsedMs) || 0);
  const timeConstant = Math.max(1, Number(timeConstantMs) || 190);
  return targetVelocity + ((initialVelocity - targetVelocity) * Math.exp(-elapsed / timeConstant));
}

export function vinylBrakeRateAtTime(initialRate, elapsedMs, timeConstantMs = 150) {
  return Math.max(0, exponentialInertiaVelocity(Math.max(0, Number(initialRate) || 0), 0, elapsedMs, timeConstantMs));
}

function copyReversedChannel(sourceChannel, targetChannel) {
  for (let index = 0; index < sourceChannel.length; index++) {
    targetChannel[index] = sourceChannel[sourceChannel.length - index - 1];
  }
}

export function reverseSamples(samples) {
  const reversed = new Float32Array(samples.length);
  copyReversedChannel(samples, reversed);
  return reversed;
}

function safeCancel(node) {
  try {
    node?.disconnect?.();
  } catch {
    // A node can already be disconnected when a source is replaced.
  }
}

export class VinylAudioEngine {
  constructor() {
    this.audioContext = null;
    this.buffer = null;
    this.reversedBuffer = null;
    this.sourceNode = null;
    this.sourceGeneration = 0;
    this.sourceStartedAt = 0;
    this.sourceStartPosition = 0;
    this.sourceDirection = 1;
    this.duration = 0;
    this.position = 0;
    this.currentRate = 0;
    this.motorRate = 1;
    this.rpm = 45;
    this.pitchModifier = 1;
    this.volume = 1;
    this.isPlaying = false;
    this.isStopping = false;
    this.brakeFrame = null;
    this.isScratching = false;
    this.wasPlayingBeforeScratch = false;
    this.needleLifted = false;
    this.listeners = new Map();
    this.timeUpdateTimer = null;
    this.noiseSource = null;
    this.noiseGain = null;
    this.noiseFilter = null;
    this.masterGainNode = null;
    this.needleGainNode = null;
    this.filterNodes = [];
    this.analyserNode = null;
    this.currentPreset = 'flat';
    this.currentGains = [...EQ_PRESETS.flat.gains];
  }

  addEventListener(type, callback) {
    if (typeof callback !== 'function') return;
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }

  removeEventListener(type, callback) {
    this.listeners.get(type)?.delete(callback);
  }

  _emit(type, detail = {}) {
    for (const callback of this.listeners.get(type) || []) {
      callback({ type, target: this, ...detail });
    }
  }

  get paused() {
    return !this.isPlaying || this.isStopping;
  }

  get currentTime() {
    this._updatePosition();
    return this.position;
  }

  set currentTime(value) {
    this.seek(value);
  }

  get src() {
    return this.buffer ? 'vinyl-buffer' : '';
  }

  getAttribute(attribute) {
    return attribute === 'src' ? this.src : '';
  }

  ensureContext() {
    if (typeof window === 'undefined') return null;
    if (!this.audioContext) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return null;
      this.audioContext = new AudioContextClass();
      this._createOutputGraph();
    }
    if (this.audioContext.state === 'suspended') this.audioContext.resume().catch(() => {});
    return this.audioContext;
  }

  _createOutputGraph() {
    const context = this.audioContext;
    this.masterGainNode = context.createGain();
    this.masterGainNode.gain.value = this.volume;
    this.needleGainNode = context.createGain();
    this.needleGainNode.gain.value = 1;
    this.analyserNode = context.createAnalyser();
    this.analyserNode.fftSize = 128;
    this.analyserNode.smoothingTimeConstant = 0.8;

    this.filterNodes = EQ_FREQUENCIES.map((frequency, index) => {
      const filter = context.createBiquadFilter();
      filter.frequency.value = frequency;
      filter.type = index === 0 ? 'lowshelf' : index === EQ_FREQUENCIES.length - 1 ? 'highshelf' : 'peaking';
      if (filter.type === 'peaking') filter.Q.value = 1;
      filter.gain.value = this.currentGains[index] || 0;
      return filter;
    });

    let currentNode = this.needleGainNode;
    for (const filter of this.filterNodes) {
      currentNode.connect(filter);
      currentNode = filter;
    }
    currentNode.connect(this.masterGainNode);
    this.masterGainNode.connect(this.analyserNode);
    this.analyserNode.connect(context.destination);
    this._createVinylNoise();
  }

  async loadBlob(blob) {
    if (!blob) throw new Error('No audio data was provided.');
    const context = this.ensureContext();
    if (!context) throw new Error('This browser does not support the Web Audio API.');
    const data = await blob.arrayBuffer();
    const decoded = await context.decodeAudioData(data.slice(0));
    this._stopSource();
    this._stopTicker();
    this._cancelBrake();
    this.buffer = decoded;
    this.reversedBuffer = this._createReversedBuffer(decoded);
    this.duration = decoded.duration;
    this.position = 0;
    this.currentRate = 0;
    this.isPlaying = false;
    this.isScratching = false;
    this.needleLifted = false;
    this._setNeedleGain(false);
    this._emit('durationchange');
    this._emit('timeupdate');
    return decoded;
  }

  _createReversedBuffer(buffer) {
    const context = this.audioContext;
    const reversed = context.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      copyReversedChannel(buffer.getChannelData(channel), reversed.getChannelData(channel));
    }
    return reversed;
  }

  _createVinylNoise() {
    const context = this.audioContext;
    const sampleRate = context.sampleRate || 44100;
    const length = Math.round(sampleRate * 8);
    const noiseBuffer = context.createBuffer(1, length, sampleRate);
    const data = noiseBuffer.getChannelData(0);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;
    for (let index = 0; index < length; index++) {
      const white = (Math.random() * 2) - 1;
      b0 = (0.99886 * b0) + (white * 0.0555179);
      b1 = (0.99332 * b1) + (white * 0.0750759);
      b2 = (0.96900 * b2) + (white * 0.1538520);
      b3 = (0.86650 * b3) + (white * 0.3104856);
      b4 = (0.55000 * b4) + (white * 0.5329522);
      b5 = (-0.7616 * b5) - (white * 0.0168980);
      const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + (white * 0.5362)) * 0.08;
      b6 = white * 0.115926;
      const click = Math.random() < 0.0018 ? (Math.random() * 2 - 1) * 0.6 : 0;
      data[index] = pink + click;
    }

    this.noiseFilter = context.createBiquadFilter();
    this.noiseFilter.type = 'highpass';
    this.noiseFilter.frequency.value = 1450;
    this.noiseGain = context.createGain();
    this.noiseGain.gain.value = 0.018;
    this.noiseFilter.connect(this.noiseGain);
    this.noiseGain.connect(this.masterGainNode);
    this.noiseBuffer = noiseBuffer;
  }

  _startNoise() {
    if (this.noiseSource || !this.noiseBuffer) return;
    const source = this.audioContext.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    source.connect(this.noiseFilter);
    source.start();
    this.noiseSource = source;
  }

  _stopNoise() {
    if (!this.noiseSource) return;
    try { this.noiseSource.stop(); } catch {
      // The loop may already have ended during context teardown.
    }
    safeCancel(this.noiseSource);
    this.noiseSource = null;
  }

  triggerNeedleDrop({ lifted = false } = {}) {
    const context = this.ensureContext();
    if (!context || !this.masterGainNode) return;
    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const bodyGain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(lifted ? 82 : 120, now);
    oscillator.frequency.exponentialRampToValueAtTime(lifted ? 46 : 54, now + 0.12);
    bodyGain.gain.setValueAtTime(0.0001, now);
    bodyGain.gain.exponentialRampToValueAtTime(lifted ? 0.04 : 0.12, now + 0.006);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    oscillator.connect(bodyGain);
    bodyGain.connect(this.masterGainNode);
    oscillator.start(now);
    oscillator.stop(now + 0.2);
  }

  _setNeedleGain(lifted) {
    if (!this.needleGainNode || !this.audioContext) return;
    const now = this.audioContext.currentTime;
    this.needleGainNode.gain.cancelScheduledValues(now);
    this.needleGainNode.gain.setTargetAtTime(lifted ? 0.0001 : 1, now, 0.025);
  }

  setNeedleLifted(lifted) {
    const next = Boolean(lifted);
    if (next === this.needleLifted) return;
    this.needleLifted = next;
    this._setNeedleGain(next);
    this.triggerNeedleDrop({ lifted: next });
  }

  _updatePosition() {
    if (!this.isPlaying || !this.sourceNode || !this.audioContext) return this.position;
    const elapsed = Math.max(0, this.audioContext.currentTime - this.sourceStartedAt);
    this.position = Math.max(0, Math.min(this.duration, this.sourceStartPosition + (elapsed * this.currentRate)));
    return this.position;
  }

  _stopSource() {
    this.sourceGeneration += 1;
    if (!this.sourceNode) return;
    this.sourceNode.onended = null;
    try { this.sourceNode.stop(); } catch {
      // Stopping a source twice is harmless and expected during seek/scratch.
    }
    safeCancel(this.sourceNode);
    this.sourceNode = null;
  }

  _cancelBrake() {
    if (this.brakeFrame != null && typeof window !== 'undefined') window.cancelAnimationFrame(this.brakeFrame);
    this.brakeFrame = null;
    this.isStopping = false;
  }

  _finishPause() {
    this._updatePosition();
    this._cancelBrake();
    this.isPlaying = false;
    this._stopSource();
    this._stopTicker();
    this._stopNoise();
    this._emit('pause');
    this._emit('timeupdate');
  }

  _scheduleSource() {
    if (!this.isPlaying || !this.buffer || !this.audioContext || Math.abs(this.currentRate) < 0.002) {
      this._stopSource();
      return;
    }
    this._stopSource();
    const direction = this.currentRate < 0 ? -1 : 1;
    const sourceBuffer = direction < 0 ? this.reversedBuffer : this.buffer;
    const offset = direction < 0 ? this.duration - this.position : this.position;
    if (!sourceBuffer || offset >= this.duration - 0.001 || offset < 0) return;
    const source = this.audioContext.createBufferSource();
    const generation = this.sourceGeneration;
    source.buffer = sourceBuffer;
    source.playbackRate.value = Math.abs(this.currentRate);
    source.connect(this.needleGainNode);
    source.onended = () => {
      if (generation !== this.sourceGeneration || !this.isPlaying) return;
      this._updatePosition();
      this.position = this.currentRate < 0 ? 0 : this.duration;
      this._cancelBrake();
      this.isPlaying = false;
      this._stopTicker();
      this._stopNoise();
      this.sourceNode = null;
      this._emit('ended');
    };
    source.start(0, Math.max(0, offset));
    this.sourceNode = source;
    this.sourceStartedAt = this.audioContext.currentTime;
    this.sourceStartPosition = this.position;
    this.sourceDirection = direction;
  }

  _setPlaybackRate(rate) {
    const nextRate = clampAudioRate(rate);
    this._updatePosition();
    const previousRate = this.currentRate;
    this.currentRate = nextRate;
    if (!this.isPlaying || !this.buffer) return;
    const directionChanged = previousRate !== 0 && nextRate !== 0 && Math.sign(previousRate) !== Math.sign(nextRate);
    if (Math.abs(nextRate) < 0.002 || directionChanged || !this.sourceNode) {
      this._scheduleSource();
      return;
    }
    this.sourceStartedAt = this.audioContext.currentTime;
    this.sourceStartPosition = this.position;
    this.sourceNode.playbackRate.setTargetAtTime(Math.abs(nextRate), this.audioContext.currentTime, 0.012);
  }

  get targetMotorRate() {
    return (this.rpm / 45) * this.pitchModifier;
  }

  get nominalAngularVelocity() {
    return (this.rpm * 2 * Math.PI) / 60;
  }

  setRpm(rpm) {
    this.rpm = Number(rpm) === 33 ? 33 : 45;
    if (!this.isScratching) this._setPlaybackRate(this.targetMotorRate);
  }

  setPitchModifier(modifier) {
    this.pitchModifier = Math.max(0.84, Math.min(1.16, Number(modifier) || 1));
    if (!this.isScratching) this._setPlaybackRate(this.targetMotorRate);
  }

  beginScratch({ resume = this.isPlaying } = {}) {
    if (this.isStopping) this._cancelBrake();
    this._updatePosition();
    this.isScratching = true;
    this.wasPlayingBeforeScratch = Boolean(resume);
    if (this.wasPlayingBeforeScratch && this.isPlaying) this._setPlaybackRate(0);
  }

  setScratchAngularVelocity(angularVelocity) {
    if (!this.isScratching || !this.wasPlayingBeforeScratch) return;
    this._setPlaybackRate(playbackRateFromAngularVelocity(angularVelocity, this.nominalAngularVelocity, this.pitchModifier));
  }

  endScratch() {
    const resume = this.wasPlayingBeforeScratch;
    this.isScratching = false;
    this.wasPlayingBeforeScratch = false;
    if (resume && this.isPlaying) this._setPlaybackRate(this.targetMotorRate);
    else this.currentRate = 0;
  }

  seek(seconds) {
    if (!this.buffer) return;
    this._updatePosition();
    this.position = Math.max(0, Math.min(this.duration, Number(seconds) || 0));
    if (this.isPlaying) this._scheduleSource();
    this._emit('timeupdate');
  }

  async play() {
    if (!this.buffer) throw new Error('Load a track before pressing play.');
    const context = this.ensureContext();
    if (!context) throw new Error('This browser does not support the Web Audio API.');
    if (this.position >= this.duration - 0.01) this.position = 0;
    if (this.audioContext.state === 'suspended') await this.audioContext.resume();
    if (this.isStopping) {
      this._cancelBrake();
      if (!this.isScratching) this._setPlaybackRate(this.targetMotorRate);
      this._startTicker();
      this._startNoise();
      this._emit('spindowncancel');
      this._emit('play');
      return;
    }
    this.isPlaying = true;
    if (!this.isScratching) this.currentRate = this.targetMotorRate;
    this._scheduleSource();
    this._startTicker();
    this._startNoise();
    this._emit('play');
  }

  pause({ immediate = false } = {}) {
    if (!this.isPlaying) return;
    if (this.isStopping) {
      if (immediate) this._finishPause();
      return;
    }
    if (immediate || !this.sourceNode || !this.audioContext || this.isScratching) {
      this._finishPause();
      return;
    }

    const startRate = Math.max(0.05, Math.abs(this.currentRate || this.targetMotorRate));
    const startAt = performance.now();
    const brakeDurationMs = 640;
    this.isStopping = true;
    this._emit('spindownstart', { duration: brakeDurationMs });

    const tick = now => {
      if (!this.isStopping) return;
      const elapsed = now - startAt;
      const rate = vinylBrakeRateAtTime(startRate, elapsed);
      if (elapsed >= brakeDurationMs || rate <= 0.018) {
        this.currentRate = Math.max(0.018, rate);
        this._finishPause();
        return;
      }
      this._setPlaybackRate(Math.max(0.018, rate));
      this.brakeFrame = window.requestAnimationFrame(tick);
    };
    this.brakeFrame = window.requestAnimationFrame(tick);
  }

  clear() {
    this.pause({ immediate: true });
    this._cancelBrake();
    this._stopSource();
    this.buffer = null;
    this.reversedBuffer = null;
    this.duration = 0;
    this.position = 0;
    this.currentRate = 0;
    this.isScratching = false;
    this.wasPlayingBeforeScratch = false;
    this._emit('durationchange');
    this._emit('timeupdate');
  }

  _startTicker() {
    if (this.timeUpdateTimer) return;
    this.timeUpdateTimer = setInterval(() => {
      this._updatePosition();
      if ((this.currentRate > 0 && this.position >= this.duration) || (this.currentRate < 0 && this.position <= 0)) {
        this._stopSource();
        this._cancelBrake();
        this.isPlaying = false;
        this._stopTicker();
        this._stopNoise();
        this._emit('ended');
        return;
      }
      this._emit('timeupdate');
    }, 50);
  }

  _stopTicker() {
    if (!this.timeUpdateTimer) return;
    clearInterval(this.timeUpdateTimer);
    this.timeUpdateTimer = null;
  }

  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, Number(volume) || 0));
    if (this.masterGainNode && this.audioContext) {
      this.masterGainNode.gain.setTargetAtTime(this.volume, this.audioContext.currentTime, 0.02);
    }
  }

  applyPreset(presetKey) {
    const preset = EQ_PRESETS[presetKey];
    if (!preset) return;
    this.currentPreset = presetKey;
    this.currentGains = [...preset.gains];
    this.filterNodes.forEach((filter, index) => {
      if (this.audioContext) filter.gain.setTargetAtTime(this.currentGains[index] || 0, this.audioContext.currentTime, 0.02);
    });
  }

  setBandGain(index, gain) {
    if (index < 0 || index >= this.filterNodes.length) return;
    const next = Math.max(-12, Math.min(12, Number(gain) || 0));
    this.currentPreset = 'custom';
    this.currentGains[index] = next;
    if (this.audioContext) this.filterNodes[index].gain.setTargetAtTime(next, this.audioContext.currentTime, 0.02);
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
    this.clear();
    this._stopNoise();
    safeCancel(this.masterGainNode);
    safeCancel(this.analyserNode);
    this.filterNodes.forEach(safeCancel);
    this.audioContext?.close?.().catch?.(() => {});
    this.audioContext = null;
    this.listeners.clear();
  }
}
