import { audioGraph } from './audioGraph.js';

export const VINYL_PITCH_LIMITS = {
  narrow: 0.08,
  wide: 0.16,
};

const NATIVE_MIN_PLAYBACK_RATE = 0.0625;
const MOTOR_RATE_RAMP_MS = 240;

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
    this.rateRampFrame = null;
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
    this.scratchPosition = 0;
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
    return this.isScratching && this.currentRate < 0 ? this.position : this._nativeTime();
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
    if (!(this.isScratching && this.currentRate < 0)) {
      this.position = this._nativeTime();
    }
    this._emit('timeupdate');
  }

  handleNativeEnded() {
    this._syncDuration();
    this.position = this.duration || this._nativeTime();
    this.isPlaying = false;
    this.isStopping = false;
    this.isScratching = false;
    this.wasPlayingBeforeScratch = false;
    this.currentRate = 0;
    this._stopScratchTicker();
    this._stopTicker();
    this._emit('timeupdate');
    this._emit('ended');
  }

  handleNativeError() {
    this.isPlaying = false;
    this.isScratching = false;
    this.wasPlayingBeforeScratch = false;
    this.currentRate = 0;
    this._stopScratchTicker();
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
    this._cancelRateRamp();
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

  _cancelRateRamp() {
    if (this.rateRampFrame == null) return;
    if (typeof window !== 'undefined' && typeof this.rateRampFrame === 'number') {
      window.cancelAnimationFrame(this.rateRampFrame);
    } else {
      clearTimeout(this.rateRampFrame);
    }
    this.rateRampFrame = null;
  }

  _rampPlaybackRate(targetRate) {
    const target = clampAudioRate(targetRate);
    if (!this.isPlaying || this.isScratching || !this.element) {
      this._setPlaybackRate(target);
      return;
    }

    this._cancelRateRamp();
    const start = Math.abs(Number(this.element.playbackRate) || Math.abs(this.currentRate) || 0);
    if (Math.abs(start - Math.abs(target)) < 0.001) {
      this.currentRate = target;
      this._nativePlaybackRate(target);
      return;
    }

    const startedAt = nowMs();
    const tick = now => {
      if (!this.isPlaying || this.isScratching || this.isStopping || !this.element) {
        this.rateRampFrame = null;
        return;
      }
      const progress = Math.min(1, Math.max(0, (now - startedAt) / MOTOR_RATE_RAMP_MS));
      const eased = progress * progress * (3 - (2 * progress));
      const nextRate = start + ((Math.abs(target) - start) * eased);
      this.currentRate = target < 0 ? -nextRate : nextRate;
      this._nativePlaybackRate(nextRate);
      if (progress >= 1) {
        this.currentRate = target;
        this._nativePlaybackRate(target);
        this.rateRampFrame = null;
        return;
      }
      this.rateRampFrame = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame(tick)
        : setTimeout(() => tick(nowMs()), 16);
    };

    this.rateRampFrame = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame(tick)
      : setTimeout(() => tick(nowMs()), 16);
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
    if (!this.isScratching) {
      if (this.isPlaying) this._rampPlaybackRate(this.targetMotorRate);
      else this._setPlaybackRate(this.targetMotorRate);
    }
  }

  setPitchModifier(modifier) {
    this.pitchModifier = Math.max(0.84, Math.min(1.16, Number(modifier) || 1));
    if (!this.isScratching) {
      if (this.isPlaying) this._rampPlaybackRate(this.targetMotorRate);
      else this._setPlaybackRate(this.targetMotorRate);
    }
  }

  beginScratch({ resume = this.isPlaying } = {}) {
    if (this.isStopping) this._cancelBrake();
    this._cancelRateRamp();
    this.position = this._nativeTime();
    this.scratchPosition = this.position;
    this.isScratching = true;
    this.wasPlayingBeforeScratch = Boolean(resume && this.isPlaying);
    this.currentRate = 0;
    if (this.wasPlayingBeforeScratch) {
      // Stop exactly at the hand position. setScratchAngularVelocity starts
      // the native decoder again as soon as the hand moves.
      this.nativePauseSuppressed = true;
      this.element?.pause();
      this.nativePauseSuppressed = false;
      this._startScratchTicker();
    }
  }

  setScratchAngularVelocity(angularVelocity) {
    if (!this.isScratching) return;
    // The hand controls the platter directly. The pitch modifier is already
    // reflected in the motor's physical target, so applying it here too
    // would make scratch audio run at pitch squared during release inertia.
    this.currentRate = playbackRateFromAngularVelocity(angularVelocity, this.nominalAngularVelocity);
    if (!this.wasPlayingBeforeScratch) return;
    const magnitude = Math.abs(this.currentRate);
    if (magnitude < 0.002) {
      this.nativePauseSuppressed = true;
      this.element?.pause();
      this.nativePauseSuppressed = false;
    } else {
      // Native media has no portable reverse-playback support. Forward
      // motion is audible at the hand speed; reverse motion is represented
      // by a low forward decoder rate plus a controlled backwards seek.
      this._nativePlaybackRate(this.currentRate < 0 ? NATIVE_MIN_PLAYBACK_RATE : magnitude);
      if (this.element?.paused) this.element.play().catch(() => {});
    }
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
      if (this.element?.paused) this.element.play().catch(() => {});
    } else {
      this.currentRate = 0;
    }
  }

  seek(seconds) {
    if (!this.element || !this.src) return;
    this._syncDuration();
    this.position = Math.max(0, Math.min(this.duration || Number.MAX_SAFE_INTEGER, Number(seconds) || 0));
    this.scratchPosition = this.position;
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
    this._cancelRateRamp();
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
    if (!(this.isScratching && this.currentRate < 0)) this.position = this._nativeTime();
    this._cancelBrake();
    this._cancelRateRamp();
    this._stopScratchTicker();
    this.nativePauseSuppressed = true;
    this.element?.pause();
    this.nativePauseSuppressed = false;
    this.isPlaying = false;
    this.isScratching = false;
    this.wasPlayingBeforeScratch = false;
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
      if (this.currentRate < -0.002) {
        // HTMLAudioElement has no reliable reverse playback. Keep it at a
        // safe audible rate while the hand-driven seek moves the playhead
        // backwards; forward hand motion uses the native decoder directly.
        const nextPosition = this.scratchPosition + (this.currentRate * elapsedSeconds);
        const bounded = Math.max(0, Math.min(this.duration || Number.MAX_SAFE_INTEGER, nextPosition));
        this.scratchPosition = bounded;
        this.position = bounded;
        try {
          this.element.currentTime = bounded;
        } catch {
          // Ignore a seek that races metadata loading.
        }
      } else {
        this.position = this._nativeTime();
        this.scratchPosition = this.position;
      }
      this._emit('timeupdate');
      if ((this.currentRate < 0 && this.position <= 0) || (this.currentRate > 0 && this.duration && this.position >= this.duration)) {
        this.isPlaying = false;
        this.isScratching = false;
        this.wasPlayingBeforeScratch = false;
        this.currentRate = 0;
        this.nativePauseSuppressed = true;
        this.element.pause();
        this.nativePauseSuppressed = false;
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
