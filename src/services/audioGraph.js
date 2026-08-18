export const EQ_FREQUENCIES = [60, 230, 910, 3600, 14000];

export const EQ_PRESETS = {
  flat: { name: 'Flat', gains: [0, 0, 0, 0, 0] },
  bass_boost: { name: 'Bass Boost', gains: [6, 4, 0, 0, -1] },
  electronic: { name: 'Electronic', gains: [5, 3, -1, 3, 4] },
  acoustic: { name: 'Acoustic', gains: [3, 2, 0, 2, 3] },
  vocal: { name: 'Vocal Boost', gains: [-2, 1, 4, 3, 1] },
  treble_boost: { name: 'Treble Boost', gains: [-1, 0, 1, 4, 6] },
  rock: { name: 'Rock', gains: [5, 2, -1, 2, 5] },
};

class AudioGraphManager {
  constructor() {
    this.audioContext = null;
    this.sourceNode = null;
    this.masterGainNode = null;
    this.filterNodes = [];
    this.analyserNode = null;
    this.attachedElement = null;
    this.currentPreset = 'flat';
    this.currentGains = [0, 0, 0, 0, 0];
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

  attachAudioElement(audioElement) {
    if (!audioElement || typeof window === 'undefined') return null;
    if (this.attachedElement === audioElement && this.sourceNode) return this.audioContext;

    const ctx = this.ensureContext();
    if (!ctx) return null;

    try {
      this.sourceNode = ctx.createMediaElementSource(audioElement);

      // Master Gain
      this.masterGainNode = ctx.createGain();
      this.masterGainNode.gain.setValueAtTime(1, ctx.currentTime);

      // Analyser for real-time visualizer
      this.analyserNode = ctx.createAnalyser();
      this.analyserNode.fftSize = 128;
      this.analyserNode.smoothingTimeConstant = 0.8;

      // 5-Band Parametric EQ Filters
      this.filterNodes = EQ_FREQUENCIES.map((freq, index) => {
        const filter = ctx.createBiquadFilter();
        filter.frequency.setValueAtTime(freq, ctx.currentTime);
        if (index === 0) {
          filter.type = 'lowshelf';
        } else if (index === EQ_FREQUENCIES.length - 1) {
          filter.type = 'highshelf';
        } else {
          filter.type = 'peaking';
          filter.Q.setValueAtTime(1.0, ctx.currentTime);
        }
        filter.gain.setValueAtTime(this.currentGains[index] || 0, ctx.currentTime);
        return filter;
      });

      // Chain: Source -> EQ Filter 0 -> 1 -> 2 -> 3 -> 4 -> Master Gain -> Analyser -> Destination
      let currentNode = this.sourceNode;
      for (const filter of this.filterNodes) {
        currentNode.connect(filter);
        currentNode = filter;
      }
      currentNode.connect(this.masterGainNode);
      this.masterGainNode.connect(this.analyserNode);
      this.analyserNode.connect(ctx.destination);
      this.attachedElement = audioElement;

      return ctx;
    } catch (err) {
      console.warn('Web Audio Graph initialization warning:', err);
      this.sourceNode?.disconnect?.();
      this.filterNodes.forEach(node => node?.disconnect?.());
      this.masterGainNode?.disconnect?.();
      this.analyserNode?.disconnect?.();
      this.sourceNode = null;
      this.filterNodes = [];
      this.masterGainNode = null;
      this.analyserNode = null;
      this.attachedElement = null;
      return null;
    }
  }

  isAttachedTo(audioElement) {
    return this.attachedElement === audioElement && Boolean(this.sourceNode);
  }

  setVolume(volume) {
    const clamped = Math.max(0, Math.min(1, Number(volume) || 0));
    if (this.masterGainNode && this.audioContext) {
      this.masterGainNode.gain.setValueAtTime(clamped, this.audioContext.currentTime);
    }
  }

  setBandGain(bandIndex, gainDb) {
    if (bandIndex < 0 || bandIndex >= this.filterNodes.length) return;
    const clampedGain = Math.max(-12, Math.min(12, Number(gainDb) || 0));
    this.currentGains[bandIndex] = clampedGain;
    this.currentPreset = 'custom';

    const filter = this.filterNodes[bandIndex];
    if (filter && this.audioContext) {
      filter.gain.setValueAtTime(clampedGain, this.audioContext.currentTime);
    }
  }

  applyPreset(presetKey) {
    const preset = EQ_PRESETS[presetKey];
    if (!preset) return;
    this.currentPreset = presetKey;
    this.currentGains = [...preset.gains];

    this.filterNodes.forEach((filter, index) => {
      const gain = preset.gains[index] || 0;
      if (filter && this.audioContext) {
        filter.gain.setValueAtTime(gain, this.audioContext.currentTime);
      }
    });
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
}

export const audioGraph = new AudioGraphManager();
