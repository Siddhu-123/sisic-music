import { audioGraph } from './audioGraph.js';

export const VINYL_PITCH_LIMITS = {
  narrow: 0.08,
  wide: 0.16,
};

const NATIVE_MIN_PLAYBACK_RATE = 0.0625;

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

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function abortError() {
  return typeof DOMException === 'function'
    ? new DOMException('Audio source was replaced.', 'AbortError')
    : Object.assign(new Error('Audio source was replaced.'), { name: 'AbortError' });
}

export class VinylAudioEngine {
  constructor() {
    this.element = typeof Audio === 'function' ? new Audio() : null;
    this.sourceRequest = 0;
    this.duration = 0;
    this.position = 0;
    this.currentRate = 0;
    this.rpm = 45;
    this.pitchModifier = 1;
    this.volume = 1;
    this.isPlaying = false;
    this.isStopping = false;
    this.isScratching = false;
    this.wasPlayingBeforeScratch = false;
    this.needleLifted = false;
    this.listeners = new Map();
    this.brakeFrame = null;
    this.timeUpdateTimer = null;
    this.scratchTimer = null;
    this.scratchLastAt = 0;
    this.nativePauseSuppressed = false;

    this.handleLoadedMetadata = this.handleLoadedMetadata.bind(this);
    this.handleDurationChange = this.handleDurationChange.bind(this);
    this.handleNativePlay = this.handleNativePlay.bind(this);
    this.handleNativePause = this.handleNativePause.bind(this);
    this.handleNativeTimeUpdate = this.handleNativeTimeUpdate.bind(this);
    this.handleNativeEnded = this.handleNativeEnded.bind(this);
    this.handleNativeError = this.handleNativeError.bind(this);

    if (this.element) {
      this.element.preload = 'metadata';
      this.element.crossOrigin = 'anonymous';
      this.element.preservesPitch = false;
      this.element.mozPreservesPitch = false;
      this.element.webkitPreservesPitch = false;
      this.element.addEventListener('loadedmetadata', this.handleLoadedMetadata);
      this.element.addEventListener('durationchange', this.handleDurationChange);
      this.element.addEventListener('play', this.handleNativePlay);
      this.element.addEventListener('pause', this.handleNativePause);
      this.element.addEventListener('timeupdate', this.handleNativeTimeUpdate);
      this.element.addEventListener('ended', this.handleNativeEnded);
      this.element.addEventListener('error', this.handleNativeError);
    }
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
    return this._nativeTime();
  }

  set currentTime(value) {
    this.seek(value);
  }

  get src() {
    return this.element?.currentSrc || this.element?.src || '';
  }

  get error() {
    return this.element?.error || null;
  }

  get currentGains() {
    return [...audioGraph.currentGains];
  }

  getAttribute(attribute) {
    return this.element?.getAttribute?.(attribute) || '';
  }

  ensureContext() {
    if (!this.element) return null;
    const context = audioGraph.attachAudioElement(this.element);
    this._applyOutputVolume();
    if (context?.state === 'suspended') context.resume().catch(() => {});
    return context;
  }

  _applyOutputVolume() {
    if (!this.element) return;
    const volume = this.needleLifted ? 0 : this.volume;
    if (audioGraph.isAttachedTo(this.element)) {
      this.element.volume = 1;
      audioGraph.setVolume(volume);
    } else {
      this.element.volume = volume;
    }
  }

  _nativeTime() {
    const value = Number(this.element?.currentTime);
    return Number.isFinite(value) ? value : this.position;
  }

  _syncDuration() {
    const nextDuration = Number(this.element?.duration);
    this.duration = Number.isFinite(nextDuration) && nextDuration > 0 ? nextDuration : 0;
    this.position = this._nativeTime();
  }

  handleLoadedMetadata() {
    this._syncDuration();
    this._emit('durationchange');
    this._emit('timeupdate');
  }

  handleDurationChange() {
    this._syncDuration();
    this._emit('durationchange');
  }

  handleNativePlay() {
    if (this.isStopping) this._cancelBrake();
    if (this.isPlaying) return;
    this.isPlaying = true;
    this._startTicker();
    this._emit('play');
  }

  handleNativePause() {
    if (this.nativePauseSuppressed || this.isStopping || this.isScratching || !this.isPlaying) return;
    this.isPlaying = false;
    this.currentRate = 0;
    this._stopTicker();
    this._emit('pause');
  }

  handleNativeTimeUpdate() {
    this.position = this._nativeTime();
    this._emit('timeupdate');
  }

  handleNativeEnded() {
    this._syncDuration();
    this.position = this.duration || this._nativeTime();
    this.isPlaying = false;
    this.isStopping = false;
    this.currentRate = 0;
    this._stopTicker();
    this._emit('timeupdate');
    this._emit('ended');
  }

  handleNativeError() {
    this.isPlaying = false;
    this.currentRate = 0;
    this._stopTicker();
    const nativeError = this.element?.error;
    this._emit('error', {
      code: nativeError?.code || 0,
      message: nativeError?.message || '',
      sourceUrl: this.src,
    });
  }

  _releaseCurrentSource() {
    this._stopScratchTicker();
    this._stopTicker();
    this._cancelBrake();
    this.isPlaying = false;
    this.isStopping = false;
    this.isScratching = false;
    this.wasPlayingBeforeScratch = false;
    this.currentRate = 0;

    if (this.element) {
      this.nativePauseSuppressed = true;
      this.element.pause();
      this.element.removeAttribute('src');
      this.element.load();
      this.nativePauseSuppressed = false;
    }
    this.duration = 0;
    this.position = 0;
  }

  async _loadSource(url) {
    if (!this.element) throw new Error('Audio playback is unavailable in this environment.');
    const nextUrl = String(url || '').trim();
    if (!nextUrl) throw new Error('No audio source was provided.');

    const requestId = ++this.sourceRequest;
    this._releaseCurrentSource();
    this.element.src = nextUrl;
    this.element.load();

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.element.removeEventListener('loadedmetadata', ready);
        this.element.removeEventListener('canplay', ready);
        this.element.removeEventListener('error', failed);
        callback(value);
      };
      const ready = () => {
        if (requestId !== this.sourceRequest) {
          finish(reject, abortError());
          return;
        }
        this._syncDuration();
        finish(resolve, this);
      };
      const failed = () => finish(reject, new Error('The audio stream could not be loaded.'));
      const timeout = setTimeout(() => finish(reject, new Error('The audio stream timed out.')), 15000);
      this.element.addEventListener('loadedmetadata', ready);
      this.element.addEventListener('canplay', ready);
      this.element.addEventListener('error', failed);
      if (this.element.readyState >= 1) ready();
    }).catch(error => {
      if (requestId === this.sourceRequest) this._releaseCurrentSource();
      throw error;
    });

    return this;
  }

  loadUrl(url) {
    return this._loadSource(url);
  }

  _nativePlaybackRate(rate) {
    if (!this.element) return;
    const magnitude = Math.abs(Number(rate) || 0);
    if (magnitude < 0.002) return;
    try {
      this.element.playbackRate = Math.max(NATIVE_MIN_PLAYBACK_RATE, magnitude);
    } catch {
      // Browsers may reject a rate while a source is changing.
    }
  }

  _setPlaybackRate(rate) {
    this.position = this._nativeTime();
    const nextRate = clampAudioRate(rate);
    this.currentRate = nextRate;
    if (this.isScratching || !this.isPlaying) return;
    if (Math.abs(nextRate) < 0.002) {
      this.nativePauseSuppressed = true;
      this.element?.pause();
      this.nativePauseSuppressed = false;
      return;
    }
    this._nativePlaybackRate(nextRate);
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
    this.position = this._nativeTime();
    this.isScratching = true;
    this.wasPlayingBeforeScratch = Boolean(resume && this.isPlaying);
    if (this.wasPlayingBeforeScratch) {
      this.nativePauseSuppressed = true;
      this.element?.pause();
      this.nativePauseSuppressed = false;
      this._startScratchTicker();
    }
  }

  setScratchAngularVelocity(angularVelocity) {
    if (!this.isScratching || !this.wasPlayingBeforeScratch) return;
    this.currentRate = playbackRateFromAngularVelocity(angularVelocity, this.nominalAngularVelocity, this.pitchModifier);
    this._startScratchTicker();
  }

  endScratch() {
    const resume = this.wasPlayingBeforeScratch;
    this.isScratching = false;
    this.wasPlayingBeforeScratch = false;
    this._stopScratchTicker();
    if (resume && this.isPlaying) {
      this.currentRate = this.targetMotorRate;
      this._nativePlaybackRate(this.currentRate);
      this.element?.play().catch(() => {});
    } else {
      this.currentRate = 0;
    }
  }

  seek(seconds) {
    if (!this.element || !this.src) return;
    this._syncDuration();
    this.position = Math.max(0, Math.min(this.duration || Number.MAX_SAFE_INTEGER, Number(seconds) || 0));
    try {
      this.element.currentTime = this.position;
    } catch {
      // Metadata may not be available yet.
    }
    this._emit('timeupdate');
  }

  async play() {
    if (!this.element || !this.src) throw new Error('Load a track before pressing play.');
    const context = this.ensureContext();
    if (context?.state === 'suspended') await context.resume();
    this._syncDuration();
    if (this.duration && this.position >= this.duration - 0.01) this.seek(0);
    const wasStopping = this.isStopping;
    if (this.isStopping) this._cancelBrake();
    if (wasStopping) this.isPlaying = false;
    if (!this.isScratching) {
      this.currentRate = this.targetMotorRate;
      this._nativePlaybackRate(this.currentRate);
    }

    try {
      await this.element.play();
    } catch (error) {
      this.isPlaying = false;
      this._stopTicker();
      throw error;
    }

    if (!this.isPlaying) {
      this.isPlaying = true;
      this._startTicker();
      this._emit('play');
    }
  }

  pause({ immediate = false } = {}) {
    if (!this.isPlaying) return;
    if (this.isStopping) {
      if (immediate) this._finishPause();
      return;
    }
    if (immediate || this.isScratching || !this.element) {
      this._finishPause();
      return;
    }

    const startRate = Math.max(0.05, Math.abs(this.currentRate || this.targetMotorRate));
    const startAt = nowMs();
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
      this._nativePlaybackRate(Math.max(0.018, rate));
      this.brakeFrame = typeof window !== 'undefined'
        ? window.requestAnimationFrame(tick)
        : setTimeout(() => tick(nowMs()), 16);
    };
    this.brakeFrame = typeof window !== 'undefined'
      ? window.requestAnimationFrame(tick)
      : setTimeout(() => tick(nowMs()), 16);
  }

  _finishPause() {
    this.position = this._nativeTime();
    this._cancelBrake();
    this.nativePauseSuppressed = true;
    this.element?.pause();
    this.nativePauseSuppressed = false;
    this.isPlaying = false;
    this.currentRate = 0;
    this._stopTicker();
    this._emit('pause');
    this._emit('timeupdate');
  }

  clear() {
    this.sourceRequest += 1;
    this._releaseCurrentSource();
    this._emit('durationchange');
    this._emit('timeupdate');
  }

  _startTicker() {
    if (this.timeUpdateTimer) return;
    this.timeUpdateTimer = setInterval(() => {
      this.position = this._nativeTime();
      this._emit('timeupdate');
    }, 250);
  }

  _stopTicker() {
    if (!this.timeUpdateTimer) return;
    clearInterval(this.timeUpdateTimer);
    this.timeUpdateTimer = null;
  }

  _startScratchTicker() {
    if (this.scratchTimer) return;
    this.scratchLastAt = nowMs();
    this.scratchTimer = setInterval(() => {
      if (!this.isScratching || !this.wasPlayingBeforeScratch || !this.element) return;
      const now = nowMs();
      const elapsedSeconds = Math.min(0.1, Math.max(0, now - this.scratchLastAt) / 1000);
      this.scratchLastAt = now;
      const nextPosition = this.position + (this.currentRate * elapsedSeconds);
      const bounded = Math.max(0, Math.min(this.duration || Number.MAX_SAFE_INTEGER, nextPosition));
      this.position = bounded;
      try {
        this.element.currentTime = bounded;
      } catch {
        // Ignore a seek that races metadata loading.
      }
      this._emit('timeupdate');
      if ((this.currentRate < 0 && bounded <= 0) || (this.currentRate > 0 && this.duration && bounded >= this.duration)) {
        this.isPlaying = false;
        this.isScratching = false;
        this.wasPlayingBeforeScratch = false;
        this.currentRate = 0;
        this._stopScratchTicker();
        this._emit('ended');
      }
    }, 50);
  }

  _stopScratchTicker() {
    if (!this.scratchTimer) return;
    clearInterval(this.scratchTimer);
    this.scratchTimer = null;
  }

  _cancelBrake() {
    if (this.brakeFrame == null) {
      this.isStopping = false;
      return;
    }
    if (typeof window !== 'undefined' && typeof this.brakeFrame === 'number') window.cancelAnimationFrame(this.brakeFrame);
    else clearTimeout(this.brakeFrame);
    this.brakeFrame = null;
    this.isStopping = false;
    this._emit('spindowncancel');
  }

  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, Number(volume) || 0));
    this._applyOutputVolume();
  }

  applyPreset(presetKey) {
    audioGraph.applyPreset(presetKey);
  }

  setBandGain(index, gain) {
    audioGraph.setBandGain(index, gain);
  }

  getFrequencyData() {
    return audioGraph.isAttachedTo(this.element) ? audioGraph.getFrequencyData() : new Uint8Array(32);
  }

  getWaveformData() {
    return audioGraph.isAttachedTo(this.element) ? audioGraph.getWaveformData() : new Uint8Array(32);
  }

  setNeedleLifted(lifted) {
    this.needleLifted = Boolean(lifted);
    this._applyOutputVolume();
  }

  dispose() {
    this.sourceRequest += 1;
    this._releaseCurrentSource();
    audioGraph.dispose();
    this.listeners.clear();
    // Keep the lightweight native element reusable because React StrictMode
    // may run an effect cleanup followed by setup without remounting state.
  }
}
