import { VinylAudioEngine } from './VinylAudioEngine.js';
import { EQ_PRESETS } from './audioGraph.js';
import { rememberDjTransition } from './djModeService.js';
import { dedupeQueue, insertAfter, insertAtEnd, queueItemKey, reorderQueue, restoreQueueState, serializeQueueState } from '../queueManager.js';

export const QUEUE_STORAGE_KEY = 'sisic:queue-state:v1';
const keyOf = queueItemKey;
const sameSource = (a, b) => Boolean(a && b && keyOf(a) === keyOf(b) && a.driveFileId === b.driveFileId);
const bounded = (value, max, fallback = 0) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(max, Number(value))) : fallback;
const playable = song => Boolean(song?.driveFileId);
const cleanSong = song => {
  const result = { ...song };
  for (const key of ['localFile', 'blob', 'isDownloaded', 'isCached', 'hasBlob', 'cacheSizeBytes', 'cachedAt']) delete result[key];
  return result;
};
const shuffle = songs => {
  const result = [...songs];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};

// One synchronous owner for transport intent, async requests and queue identity.
// React observes snapshots; no queue mutation waits for an effect to update a ref.
export class PlaybackController {
  constructor({ resolveUrl, createAudio = () => new VinylAudioEngine(), storage, now = Date.now } = {}) {
    this.resolveUrl = resolveUrl;
    this.createAudio = createAudio;
    this.storage = storage;
    this.now = now;
    let saved;
    try { saved = restoreQueueState(storage?.getItem(QUEUE_STORAGE_KEY)); } catch { /* storage may be disabled */ }
    this.state = {
      currentSong: null, currentSongKey: null, queue: saved?.queue || [], queueIndex: saved?.queueIndex || 0,
      queueRevision: 0, isPlaying: false, isSpinningDown: false, isBuffering: false,
      progress: 0, duration: 0, buffered: 0, error: '', playbackEvent: null,
      shuffleMode: saved?.shuffleMode || 'off', repeatMode: saved?.repeatMode || 'off',
      resumeOnRestore: Boolean(saved?.isPlaying), resumePosition: saved?.positionSeconds || 0,
      volume: saved?.volume ?? 1, muted: saved?.muted || false, crossfadeSeconds: saved?.crossfadeSeconds || 0,
      sleepTimer: saved?.sleepTimer || null, sleepRemaining: 0,
      djModeEnabled: Boolean(saved?.djModeEnabled), djPrediction: null, djPlan: null,
      djHistory: saved?.djHistory || { candidateKeys: [], timingBuckets: [] },
      eqPreset: saved?.eqPreset || 'flat', eqGains: saved?.eqGains || [...EQ_PRESETS.flat.gains],
      rpm: 45, pitchModifier: 1, pitchRange: 0.08,
    };
    this.originalQueue = saved?.originalQueue || [];
    this.listeners = new Set();
    this.failed = new Set();
    this.played = new Set();
    this.sequence = 0;
    this.preloadSequence = 0;
    this.desiredPlaying = this.state.resumeOnRestore;
    this.audioRef = { current: null };
    this.audio = null;
    this.standby = null;
    this.retiring = null;
    this.loadAbort = null;
    this.preloadAbort = null;
    this.preloaded = null;
    this.preloadPending = null;
    this.smartNextKey = null;
    this.djPlan = null;
    this.loading = false;
    this.transitioning = false;
    this.lastPersisted = 0;
    this.active = false;
    this.enabled = false;
    this.resolveSong = async song => song;
  }

  getSnapshot = () => this.state;
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  update(patch) {
    this.state = { ...this.state, ...patch, isPlayRequested: this.desiredPlaying };
    this.listeners.forEach(listener => listener());
  }
  activate = () => {
    this.active = true;
    if (!this.audio) this.audio = this.makeAudio();
    this.audioRef.current = this.audio;
    this.checkSleep();
  };
  configurePlayback = ({ enabled, resolveSong }) => {
    this.resolveSong = resolveSong || this.resolveSong;
    const shouldRestore = enabled && !this.enabled;
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.clearDjPlan({ persist: false });
      const resumePosition = this.loading ? this.state.resumePosition : this.audio?.currentTime || 0;
      const wasLoading = this.loading;
      this.desiredPlaying = false;
      this.cancelLoad(); this.cancelPreload(); this.finishFade();
      if (wasLoading) this.audio?.clear();
      else this.audio?.pause({ immediate: true });
      this.update({ isPlaying: false, isBuffering: false, resumePosition, resumeOnRestore: false });
      this.persist();
    } else if (shouldRestore && this.state.queue.length) {
      this.prepareSelection();
    }
  };
  async prepareSelection() {
    if (!this.enabled || !this.active) return;
    const song = this.state.queue[this.state.queueIndex];
    if (!song) return;
    const request = this.sequence;
    this.loading = true;
    this.update({ isBuffering: true });
    try {
      const resolved = await this.resolveSong(song, { queueIfMissing: true, showToast: false });
      if (!this.active || request !== this.sequence) return;
      if (!resolved || resolved.downloadBlocked) throw new Error(resolved?.downloadPolicyMessage || `"${song.track}" is queued for Mac preparation.`);
      await this.loadAndPlay(resolved, { autoplay: this.desiredPlaying, startAt: this.state.resumePosition });
    } catch (error) {
      if (this.active && request === this.sequence) { this.loading = false; this.handleFailure(error, song); }
    }
  }
  makeAudio() {
    const audio = this.createAudio();
    for (const type of ['play', 'pause', 'ended', 'error', 'timeupdate', 'durationchange', 'waiting', 'playing', 'seeking', 'seeked', 'progress']) {
      audio.addEventListener(type, event => {
        if (this.active && this.audio === audio) this.handleAudioEvent(type, event);
      });
    }
    return audio;
  }
  applySettings(audio) {
    audio.setVolume(this.state.muted ? 0 : this.state.volume);
    audio.setRpm(this.state.rpm);
    audio.setPitchModifier(this.state.pitchModifier);
    if (this.state.eqPreset === 'custom') this.state.eqGains.forEach((gain, i) => audio.setBandGain(i, gain));
    else audio.applyPreset(this.state.eqPreset);
  }
  persist = () => {
    try {
      this.storage?.setItem(QUEUE_STORAGE_KEY, serializeQueueState({
        ...this.state, originalQueue: this.originalQueue,
        positionSeconds: this.loading ? this.state.resumePosition : this.audio?.currentTime || this.state.resumePosition,
        isPlaying: this.desiredPlaying,
      }));
    } catch { /* full or disabled storage must never interrupt playback */ }
  };
  event(eventType, song = this.state.currentSong, detail = {}) {
    if (!song) return;
    this.update({ playbackEvent: {
      id: `${this.now()}-${Math.random().toString(36).slice(2)}`, createdAt: new Date(this.now()).toISOString(),
      eventType, songKey: keyOf(song), artist: song.artist || '', track: song.track || '', driveFileId: song.driveFileId || '',
      positionSeconds: this.audio?.currentTime || 0, durationSeconds: this.audio?.duration || 0,
      userInitiated: false, expectedFullPlay: false, ...detail,
    } });
  }
  cancelLoad() {
    this.sequence += 1;
    this.loadAbort?.abort();
    this.loadAbort = null;
    if (this.pendingAudio && this.pendingAudio !== this.audio) {
      this.pendingAudio.clear();
      this.standby = this.pendingAudio;
    }
    this.pendingAudio = null;
    this.loading = false;
    this.transitioning = false;
  }
  cancelPreload() {
    this.preloadSequence += 1;
    this.preloadAbort?.abort();
    this.preloadAbort = null;
    this.preloadPending = null;
    this.preloaded = null;
    this.standby?.clear();
  }
  finishFade = () => {
    clearTimeout(this.fadeTimer);
    this.fadeTimer = null;
    if (this.retiring) {
      this.retiring.clear();
      this.standby = this.retiring;
      this.retiring = null;
    }
    this.audio?.setFade(1);
  };
  invalidateSelection({ keepAudio = false } = {}) {
    this.cancelLoad();
    this.finishFade();
    if (!keepAudio) this.audio?.clear();
  }
  select(index, { autoplay = true, keepAudio = false, resetPosition = true, autoLoad = true } = {}) {
    if (!Number.isInteger(index) || !this.state.queue[index]) return false;
    this.invalidateSelection({ keepAudio });
    this.desiredPlaying = autoplay;
    this.smartNextKey = null;
    if (!this.djPlan || keyOf(this.djPlan.candidate) !== keyOf(this.state.queue[index])) this.djPlan = null;
    this.update({ queueIndex: index, queueRevision: this.state.queueRevision + 1,
      resumePosition: resetPosition ? 0 : this.state.resumePosition, resumeOnRestore: autoplay,
      currentSong: this.state.queue[index], currentSongKey: keyOf(this.state.queue[index]), djPlan: this.djPlan ? this.state.djPlan : null, djPrediction: null,
      progress: 0, duration: 0, buffered: 0, isPlaying: false, isBuffering: true, error: '',
    });
    this.persist();
    if (autoLoad) this.prepareSelection();
    return true;
  }
  loadAndPlay = async (song, { autoplay = true, startAt = 0, signal, crossfade = 0 } = {}) => {
    if (!this.active || !song || signal?.aborted) return false;
    if (sameSource(this.loadedSong, song) && this.audio?.getAttribute('src') && !this.audio.error && !this.loading) return true;
    this.cancelLoad();
    const request = this.sequence;
    const abort = new AbortController();
    this.loadAbort = abort;
    const cancel = () => { abort.abort(); if (this.loadAbort === abort) this.audio?.clear(); };
    signal?.addEventListener('abort', cancel, { once: true });
    const latest = () => this.active && request === this.sequence && !abort.signal.aborted;
    const outgoing = this.audio;
    let incoming = outgoing;
    this.loading = true;
    this.desiredPlaying = autoplay;
    this.loadedSong = null;
    this.update({ currentSong: cleanSong(song), currentSongKey: keyOf(song), error: '', isBuffering: true, progress: 0, duration: 0 });
    try {
      // Await the existing preload rather than start a second stream for the same song.
      if (sameSource(this.preloadSong, song) && this.preloadPending) await this.preloadPending;
      if (!latest()) return false;
      if (sameSource(this.preloaded, song) && this.standby) {
        incoming = this.standby;
        this.pendingAudio = incoming;
        this.standby = null;
        this.preloaded = null;
        this.preloadSong = null;
      } else {
        crossfade = 0;
        outgoing.clear();
        const url = await this.resolveUrl(song, abort.signal);
        if (!latest()) return false;
        await incoming.loadUrl(url);
      }
      if (!latest()) return false;
      this.applySettings(incoming);
      if (startAt > 0) incoming.seek(bounded(startAt, Math.max(0, incoming.duration - 0.25)));
      let canFade = false;
      if (crossfade > 0 && this.desiredPlaying && incoming !== outgoing && !outgoing.paused) {
        const incomingContext = incoming.ensureContext();
        const outgoingContext = outgoing.ensureContext();
        canFade = Boolean(incomingContext && outgoingContext);
        if (canFade) incoming.setFade(0);
      }
      if (this.desiredPlaying) await incoming.play();
      if (!latest()) return false;
      if (!this.desiredPlaying) incoming.pause({ immediate: true });
      if (incoming !== outgoing) {
        this.audio = incoming;
        this.audioRef.current = incoming;
        if (canFade && this.desiredPlaying) {
          incoming.setFade(1, crossfade);
          outgoing.setFade(0, crossfade);
          this.retiring = outgoing;
          this.fadeDeadline = this.now() + crossfade * 1000;
          this.fadeTimer = setTimeout(() => { this.finishFade(); this.preloadNext(); }, crossfade * 1000 + 50);
        } else {
          outgoing.clear();
          this.standby = outgoing;
        }
      }
      this.loadedSong = cleanSong(song);
      this.loading = false;
      this.transitioning = false;
      this.failed.delete(keyOf(song));
      this.played.add(keyOf(song));
      const completedDjPlan = this.djPlan && keyOf(this.djPlan.candidate) === keyOf(song);
      const djHistory = completedDjPlan ? rememberDjTransition(this.state.djHistory, keyOf(song), this.djPlan.transitionAtSeconds) : this.state.djHistory;
      if (completedDjPlan) this.djPlan = null;
      this.update({ currentSong: this.loadedSong, currentSongKey: keyOf(song), duration: incoming.duration,
        progress: incoming.duration ? incoming.currentTime / incoming.duration * 100 : 0,
        resumePosition: 0, isPlaying: !incoming.paused, isBuffering: Boolean(!incoming.paused && incoming.element?.readyState < 3), djPlan: completedDjPlan ? null : this.state.djPlan, djHistory,
      });
      if (this.desiredPlaying) this.event('playback-start', song, { message: startAt ? 'Playback resumed from the saved position.' : 'Playback started.' });
      this.persist();
      this.preloadNext();
      return true;
    } catch (error) {
      if (!latest()) return false;
      if (error.name === 'AbortError') {
        this.loading = false;
        if (incoming.getAttribute('src') && !incoming.error && !this.desiredPlaying) {
          if (incoming !== this.audio) { outgoing.clear(); this.standby = outgoing; this.audio = incoming; this.audioRef.current = incoming; }
          this.loadedSong = cleanSong(song);
          incoming.setFade(1);
          this.update({ isPlaying: false, isBuffering: false, duration: incoming.duration, resumePosition: 0 });
          this.preloadNext();
        }
        return false;
      }
      this.loading = false;
      this.transitioning = false;
      // Autoplay denial is recoverable by one explicit play gesture; keep the loaded source.
      if (error.name === 'NotAllowedError') {
        if (incoming !== this.audio) { outgoing.clear(); this.standby = outgoing; this.audio = incoming; this.audioRef.current = incoming; }
        this.loadedSong = song;
        incoming.setFade(1);
        this.desiredPlaying = false;
        this.update({ isPlaying: false, isBuffering: false, error: 'Press play to start this track.', duration: incoming.duration });
      } else {
        if (incoming !== this.audio) { incoming.clear(); this.standby = incoming; }
        this.handleFailure(error, song);
      }
      return false;
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (this.loadAbort === abort) { this.loadAbort = null; this.pendingAudio = null; }
    }
  };
  handleFailure(error, song = this.state.currentSong) {
    this.event('playback-stream-error', song, { message: error.message || 'Audio could not load.' });
    this.failed.add(keyOf(song));
    const message = `Could not play "${song?.track || 'this track'}". ${error.message || 'Try again.'}`;
    this.update({ isPlaying: false, isBuffering: false, error: message });
    if (error.name !== 'AuthenticationError' && error.name !== 'NotAllowedError' && this.desiredPlaying && this.playNext({ reason: 'error' })) {
      this.update({ error: `${message} Skipping to the next available track.` });
    } else {
      this.desiredPlaying = false;
      this.audio?.pause({ immediate: true });
      this.update({ isPlaying: false, isBuffering: false });
      this.persist();
    }
  }
  nextIndex() {
    const { queue, queueIndex, repeatMode, shuffleMode } = this.state;
    const eligible = (song, index) => index !== queueIndex && playable(song) && !this.failed.has(keyOf(song));
    if (shuffleMode === 'smart') {
      const candidates = queue.map((song, index) => ({ song, index }))
        .filter(({ song, index }) => eligible(song, index) && (repeatMode === 'all' || !this.played.has(keyOf(song))));
      const planned = candidates.find(({ song }) => keyOf(song) === this.smartNextKey);
      if (planned) return planned.index;
      const weights = candidates.map(({ song }) => (1 + Math.log1p(Math.max(0, Number(song.playCount) || 0))) * (this.played.has(keyOf(song)) ? 0.15 : 1));
      let target = Math.random() * weights.reduce((sum, weight) => sum + weight, 0);
      const chosen = candidates.find((_, i) => (target -= weights[i]) < 0);
      this.smartNextKey = chosen ? keyOf(chosen.song) : null;
      if (chosen) return chosen.index;
    } else {
      const steps = repeatMode === 'all' ? queue.length - 1 : queue.length - queueIndex - 1;
      for (let i = 1; i <= steps; i++) {
        const index = (queueIndex + i) % queue.length;
        if (eligible(queue[index], index)) return index;
      }
    }
    // A single playable track repeats in repeat-all, but a failed track never does.
    return repeatMode === 'all' && playable(queue[queueIndex]) && !this.failed.has(keyOf(queue[queueIndex])) ? queueIndex : -1;
  }
  preloadNext = () => {
    if (!this.active || this.loading || !this.loadedSong || this.retiring) return;
    const index = this.state.repeatMode === 'one' ? -1 : this.nextIndex();
    const song = this.djPlan?.candidate || this.state.queue[index];
    if (!song || sameSource(song, this.loadedSong)) { this.cancelPreload(); return; }
    if (sameSource(song, this.preloadSong) && (this.preloadPending || this.preloaded)) return;
    this.cancelPreload();
    this.standby ||= this.makeAudio();
    const standby = this.standby;
    const request = this.preloadSequence;
    const abort = new AbortController();
    this.preloadAbort = abort;
    this.preloadSong = song;
    this.preloadPending = (async () => {
      try {
        const url = await this.resolveUrl(song, abort.signal);
        if (!this.active || request !== this.preloadSequence) return;
        await standby.loadUrl(url);
        if (this.active && request === this.preloadSequence) this.preloaded = song;
      } catch {
        if (request === this.preloadSequence && sameSource(song, this.djPlan?.candidate)) {
          this.update({ djHistory: { ...this.state.djHistory,
            candidateKeys: [keyOf(song), ...this.state.djHistory.candidateKeys.filter(key => key !== keyOf(song))].slice(0, 6) } });
          this.clearDjPlan({ persist: false });
          this.persist();
        }
        // Normal queue failures remain owned by foreground playback.
      }
      finally { if (request === this.preloadSequence) this.preloadPending = null; }
    })();
  };
  handleAudioEvent(type, event) {
    if (type === 'timeupdate' || type === 'durationchange' || type === 'progress') {
      if (this.retiring && this.now() >= this.fadeDeadline) { this.finishFade(); this.preloadNext(); }
      if (this.checkSleep()) return;
      const duration = this.audio.duration || 0;
      let buffered = 0;
      const ranges = this.audio.element?.buffered;
      for (let i = 0; i < (ranges?.length || 0); i++) {
        if (ranges.start(i) <= this.audio.currentTime && ranges.end(i) >= this.audio.currentTime) buffered = ranges.end(i) / duration * 100;
      }
      this.update({ duration, progress: duration ? bounded(this.audio.currentTime / duration * 100, 100) : 0, buffered: bounded(buffered, 100) });
      if (this.now() - this.lastPersisted > 5000) { this.lastPersisted = this.now(); this.persist(); }
      const remaining = (duration - this.audio.currentTime) / Math.max(0.0625, this.audio.targetMotorRate || 1);
      const djDue = this.djPlan
        && keyOf(this.djPlan.source) === keyOf(this.state.currentSong)
        && this.audio.currentTime >= this.djPlan.transitionAtSeconds;
      const requestedFade = djDue ? Math.min(this.djPlan.crossfadeSeconds, remaining) : remaining;
      if (duration > 0 && remaining > 0 && (djDue || remaining <= Math.min(this.state.crossfadeSeconds, duration / 2))
        && this.preloaded && this.desiredPlaying && !this.loading && !this.transitioning && !this.audio.isScratching
        && !this.audio.needleLifted && !this.audio.element?.seeking && this.state.repeatMode !== 'one'
        && this.state.sleepTimer?.mode !== 'track' && this.audio.element?.readyState >= 3 && this.standby?.element?.readyState >= 3) {
        let index = this.nextIndex();
        if (djDue && sameSource(this.djPlan.candidate, this.preloaded)) {
          const queue = insertAfter(this.state.queue, this.state.queueIndex, this.djPlan.candidate);
          const queueIndex = queue.findIndex(song => keyOf(song) === this.state.currentSongKey);
          this.update({ queue, queueIndex });
          index = queueIndex + 1;
        }
        const song = this.state.queue[index];
        if (index >= 0 && sameSource(song, this.preloaded) && (!djDue || keyOf(song) === keyOf(this.djPlan.candidate))) {
          this.event(djDue ? 'dj-transition' : 'playback-complete', this.state.currentSong, { expectedFullPlay: !djDue, message: djDue ? 'Adaptive DJ crossfaded before a predicted skip.' : 'Crossfaded into the next track.' });
          this.select(index, { keepAudio: true, autoLoad: false });
          this.transitioning = true;
          this.loadAndPlay(song, { crossfade: requestedFade });
        }
      }
      return;
    }
    if (type === 'ended') {
      if (this.loading) return;
      this.update({ isPlaying: false, isBuffering: false });
      this.event('playback-complete', this.state.currentSong, { expectedFullPlay: true, message: 'Audio ended normally.' });
      if (this.state.sleepTimer?.mode === 'track') { this.expireSleep(); return; }
      if (this.state.repeatMode === 'one') { this.audio.seek(0); this.play(); }
      else if (!this.playNext({ reason: 'ended' })) { this.desiredPlaying = false; this.update({ isPlaying: false }); this.persist(); }
    } else if (type === 'error') {
      if (!this.loading) this.handleFailure(new Error(event.message || 'The audio stream failed.'));
    } else if (type === 'play') {
      if (!this.desiredPlaying) { this.audio.pause({ immediate: true }); return; }
      this.update({ isPlaying: true });
    } else if (type === 'pause') {
      if (!this.loading) { this.desiredPlaying = false; this.update({ isPlaying: false, isBuffering: false }); this.persist(); }
    } else if (type === 'waiting' || type === 'seeking') this.update({ isBuffering: this.desiredPlaying });
    else if (type === 'playing' || type === 'seeked') this.update({ isBuffering: false });
  }
  play = async () => {
    if (!this.active || !this.state.queue.length || this.checkSleep()) return;
    this.desiredPlaying = true;
    this.update({ resumeOnRestore: true, error: '' });
    if (this.loading) return;
    const song = this.state.queue[this.state.queueIndex];
    if (!this.loadedSong || this.audio.error || !this.audio.getAttribute('src')) {
      if (song) this.select(this.state.queueIndex);
      return;
    }
    const request = this.sequence;
    try {
      await this.audio.play();
      if (request !== this.sequence) return;
      this.event('playback-resume', undefined, { userInitiated: true, message: 'Playback resumed by the listener.' });
      this.update({ isPlaying: !this.audio.paused });
      this.persist();
    } catch (error) {
      if (request !== this.sequence || error.name === 'AbortError') return;
      this.desiredPlaying = false;
      this.update({ isPlaying: false, isBuffering: false, error: error.message || 'Press play to retry.' });
    }
  };
  pause = () => {
    this.desiredPlaying = false;
    this.finishFade();
    this.clearDjPlan({ persist: false });
    this.pendingAudio?.pause({ immediate: true });
    this.audio?.pause({ immediate: true });
    this.event('playback-pause', undefined, { userInitiated: true });
    this.update({ isPlaying: false, isBuffering: false, resumeOnRestore: false });
    this.persist();
  };
  togglePlay = () => this.desiredPlaying ? this.pause() : this.play();
  seek = pct => {
    if (!this.audio?.duration || !Number.isFinite(Number(pct))) return;
    this.finishFade();
    this.clearDjPlan({ persist: false });
    const from = this.audio.currentTime;
    const to = bounded(pct, 100) / 100 * this.audio.duration;
    if (Math.abs(to - from) < 0.001) return;
    this.audio.seek(to);
    this.update({ queueRevision: this.state.queueRevision + 1 });
    this.event('playback-seek', undefined, { userInitiated: true, fromPositionSeconds: from, toPositionSeconds: to, positionSeconds: to });
    this.preloadNext();
    this.persist();
  };
  playNext = ({ reason = 'auto-next' } = {}) => {
    const index = this.nextIndex();
    if (index < 0) return false;
    if (reason.startsWith('user')) this.event('user-skip', undefined, { userInitiated: true, message: reason });
    if (index === this.state.queueIndex && reason === 'ended') { this.audio.seek(0); this.play(); return true; }
    return this.select(index);
  };
  playPrev = () => {
    if (!this.state.queue.length) return false;
    if (this.audio?.currentTime > 3) { this.seek(0); return true; }
    const { queue, queueIndex, repeatMode } = this.state;
    for (let step = 1; step <= queue.length; step++) {
      const raw = queueIndex - step;
      if (raw < 0 && repeatMode !== 'all') break;
      const index = (raw + queue.length) % queue.length;
      if (playable(queue[index]) && !this.failed.has(keyOf(queue[index]))) {
        this.event('user-skip', undefined, { userInitiated: true, message: 'user-prev' });
        return this.select(index);
      }
    }
    this.seek(0);
    return true;
  };
  setQueueAndPlay = (songs, startIndex = 0) => {
    const selectedKey = keyOf(songs?.[startIndex]);
    let queue = dedupeQueue(songs).map(cleanSong);
    if (!queue.length) { this.clearQueue(); return; }
    this.failed.clear(); this.played.clear(); this.originalQueue = [];
    let index = Math.max(0, queue.findIndex(song => keyOf(song) === selectedKey));
    if (this.state.shuffleMode === 'shuffle') {
      this.originalQueue = [...queue];
      queue = [queue[index], ...shuffle(queue.filter((_, i) => i !== index))];
      index = 0;
    }
    this.update({ queue });
    this.select(index);
  };
  editQueue(queue, originalQueue = queue) {
    this.clearDjPlan({ persist: false });
    const currentKey = keyOf(this.state.queue[this.state.queueIndex]);
    const index = Math.max(0, queue.findIndex(song => keyOf(song) === currentKey));
    if (this.originalQueue.length) this.originalQueue = originalQueue;
    this.smartNextKey = null;
    this.update({ queue, queueIndex: index, queueRevision: this.state.queueRevision + 1 });
    this.preloadNext(); this.persist();
  }
  enqueueNext = song => {
    if (!keyOf(song)) return false;
    if (!this.state.queue.length) { this.setQueueAndPlay([song]); return true; }
    if (keyOf(song) === keyOf(this.state.queue[this.state.queueIndex])) return false;
    this.failed.delete(keyOf(song));
    this.editQueue(insertAfter(this.state.queue, this.state.queueIndex, cleanSong(song)), insertAtEnd(this.originalQueue, cleanSong(song)));
    return true;
  };
  addToQueue = song => {
    if (!keyOf(song)) return false;
    if (!this.state.queue.length) { this.setQueueAndPlay([song]); return true; }
    if (keyOf(song) === keyOf(this.state.queue[this.state.queueIndex])) return false;
    this.failed.delete(keyOf(song));
    this.editQueue(insertAtEnd(this.state.queue, cleanSong(song)), insertAtEnd(this.originalQueue, cleanSong(song)));
    return true;
  };
  removeFromQueue = index => {
    if (!Number.isInteger(index) || !this.state.queue[index]) return false;
    const key = keyOf(this.state.queue[index]);
    const queue = this.state.queue.filter((_, i) => i !== index);
    const original = this.originalQueue.filter(song => keyOf(song) !== key);
    const removedCurrent = index === this.state.queueIndex;
    if (!queue.length) { this.clearQueue(); return true; }
    const autoplay = this.desiredPlaying;
    this.editQueue(queue, original);
    if (removedCurrent) this.select(Math.min(index, queue.length - 1), { autoplay });
    return true;
  };
  reorderQueue = (from, to) => {
    const queue = reorderQueue(this.state.queue, from, to);
    this.editQueue(queue);
    return queue;
  };
  playQueueItem = index => {
    if (index === this.state.queueIndex && this.loadedSong) { this.togglePlay(); return true; }
    this.failed.delete(keyOf(this.state.queue[index]));
    return this.select(index);
  };
  clearQueue = () => {
    this.stop(); this.cancelPreload(); this.originalQueue = []; this.failed.clear(); this.played.clear();
    this.update({ queue: [], queueIndex: 0, queueRevision: this.state.queueRevision + 1 }); this.persist();
  };
  stop = () => {
    this.clearDjPlan({ persist: false });
    this.event('playback-stop', undefined, { userInitiated: true });
    this.desiredPlaying = false; this.invalidateSelection(); this.cancelPreload(); this.loadedSong = null;
    this.update({ currentSong: null, currentSongKey: null, isPlaying: false, isBuffering: false,
      progress: 0, duration: 0, buffered: 0, resumePosition: 0, resumeOnRestore: false }); this.persist();
  };
  toggleShuffle = () => {
    this.clearDjPlan({ persist: false });
    const mode = ['off', 'shuffle', 'smart'][(['off', 'shuffle', 'smart'].indexOf(this.state.shuffleMode) + 1) % 3];
    let queue = this.state.queue;
    const currentKey = keyOf(queue[this.state.queueIndex]);
    if (mode === 'shuffle' && queue.length) {
      this.originalQueue = [...queue];
      queue = [queue[this.state.queueIndex], ...shuffle(queue.filter((_, i) => i !== this.state.queueIndex))];
    } else if (mode === 'off' && this.originalQueue.length) {
      const byKey = new Map(queue.map(song => [keyOf(song), song]));
      queue = dedupeQueue([...this.originalQueue.filter(song => byKey.has(keyOf(song))).map(song => byKey.get(keyOf(song))), ...queue]);
      this.originalQueue = [];
    }
    this.smartNextKey = null;
    this.update({ shuffleMode: mode, queue, queueIndex: Math.max(0, queue.findIndex(song => keyOf(song) === currentKey)) });
    this.preloadNext(); this.persist();
  };
  toggleRepeat = () => {
    this.clearDjPlan({ persist: false });
    const modes = ['off', 'one', 'all'];
    this.update({ repeatMode: modes[(modes.indexOf(this.state.repeatMode) + 1) % modes.length] });
    this.smartNextKey = null; this.preloadNext(); this.persist();
  };
  changeVolume = value => { this.update({ volume: bounded(value, 1), muted: false }); this.applyVolume(); };
  toggleMute = () => { this.update({ muted: !this.state.muted }); this.applyVolume(); };
  applyVolume() { for (const audio of [this.audio, this.retiring]) audio?.setVolume(this.state.muted ? 0 : this.state.volume); this.persist(); }
  setCrossfade = value => { this.finishFade(); this.update({ crossfadeSeconds: bounded(value, 12) }); this.preloadNext(); this.persist(); };
  setDjModeEnabled = enabled => {
    const djModeEnabled = Boolean(enabled);
    if (!djModeEnabled) this.clearDjPlan({ persist: false });
    this.update({ djModeEnabled, djPrediction: null });
    this.preloadNext();
    this.persist();
  };
  setDjPrediction = prediction => this.update({ djPrediction: prediction ? { ...prediction } : null });
  clearDjPlan = ({ persist = true } = {}) => {
    if (!this.djPlan && !this.state.djPlan) return;
    this.djPlan = null;
    this.update({ djPlan: null, djPrediction: null });
    this.cancelPreload();
    this.preloadNext();
    if (persist) this.persist();
  };
  planDjTransition = plan => {
    const source = this.state.currentSong;
    const candidate = plan?.candidate && cleanSong(plan.candidate);
    if (!this.state.djModeEnabled || !source || !candidate || keyOf(source) === keyOf(candidate) || !this.desiredPlaying
      || this.state.repeatMode === 'one' || this.state.sleepTimer?.mode === 'track' || !playable(candidate)
      || (plan.sourceSongKey && plan.sourceSongKey !== keyOf(source)) || this.loading || this.transitioning) return false;
    if (this.djPlan?.sourceSongKey === keyOf(source)) return false;
    const currentIndex = this.state.queueIndex;
    const current = this.state.queue[currentIndex];
    if (!current || keyOf(current) !== keyOf(source)) return false;
    const crossfadeSeconds = Math.max(2, Math.min(7, Number(plan.crossfadeSeconds) || 4));
    const transitionAtSeconds = Number(plan.transitionAtSeconds);
    if (!Number.isFinite(transitionAtSeconds) || transitionAtSeconds <= this.audio.currentTime || transitionAtSeconds > this.audio.duration - crossfadeSeconds) return false;
    this.cancelPreload();
    this.djPlan = { ...plan, source, candidate, sourceSongKey: keyOf(source), transitionAtSeconds, crossfadeSeconds };
    this.update({ djPlan: {
      candidateSongKey: keyOf(candidate), candidateTitle: candidate.track, transitionAtSeconds, crossfadeSeconds, probability: Number(plan.probability || 0), fallback: Boolean(plan.fallback),
    } });
    this.preloadNext();
    this.persist();
    return true;
  };
  setSleepTimer = value => {
    this.clearDjPlan({ persist: false });
    const sleepTimer = value === 'track' ? { mode: 'track' } : Number(value) > 0 ? { mode: 'time', deadline: this.now() + Number(value) * 60000 } : null;
    this.update({ sleepTimer }); this.checkSleep(); this.persist();
  };
  checkSleep = () => {
    const timer = this.state.sleepTimer;
    if (timer?.mode !== 'time') return false;
    const remaining = Math.max(0, Math.ceil((timer.deadline - this.now()) / 1000));
    if (!remaining) { this.expireSleep(); return true; }
    if (remaining !== this.state.sleepRemaining) this.update({ sleepRemaining: remaining });
    return false;
  };
  expireSleep() {
    this.update({ sleepTimer: null, sleepRemaining: 0 });
    this.pause();
    this.update({ error: '' });
    this.persist();
  }
  setRpm = value => { const rpm = Number(value) === 33 ? 33 : 45; this.audio?.setRpm(rpm); this.update({ rpm }); };
  setPitchModifier = value => { const pitchModifier = Math.max(1 - this.state.pitchRange, bounded(value, 1 + this.state.pitchRange, 1)); this.audio?.setPitchModifier(pitchModifier); this.update({ pitchModifier }); };
  setPitchRange = value => { this.update({ pitchRange: Number(value) >= 0.16 ? 0.16 : 0.08 }); this.setPitchModifier(this.state.pitchModifier); };
  beginScratch = resume => { this.finishFade(); this.audio?.beginScratch({ resume }); };
  setScratchAngularVelocity = value => this.audio?.setScratchAngularVelocity(value);
  endScratch = () => this.audio?.endScratch();
  setNeedleLifted = value => { this.finishFade(); this.audio?.setNeedleLifted(value); };
  setEqPreset = preset => { if (!EQ_PRESETS[preset]) return; this.update({ eqPreset: preset, eqGains: [...EQ_PRESETS[preset].gains] }); this.applySettings(this.audio); this.persist(); };
  setBandGain = (index, gain) => { this.audio?.setBandGain(index, gain); this.update({ eqPreset: 'custom', eqGains: this.audio.currentGains }); this.persist(); };
  clearError = () => this.update({ error: '' });
  setPlayerError = message => this.update({ error: message || '', isBuffering: false });
  visibilityChanged = hidden => { this.audio?.handleVisibilityChange(hidden); this.retiring?.handleVisibilityChange(hidden); this.checkSleep(); this.persist(); };
  dispose = () => {
    this.djPlan = null;
    this.update({ djPlan: null, djPrediction: null });
    this.persist(); this.active = false; this.enabled = false; this.cancelLoad(); this.cancelPreload(); this.finishFade();
    this.audio?.dispose(); this.standby?.dispose(); this.audio = null; this.standby = null; this.loadedSong = null;
  };
}
