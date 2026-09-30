import { VinylAudioEngine } from './VinylAudioEngine.js';
import { EQ_PRESETS } from './audioGraph.js';
import { beatFollower, beatSeconds, decodeBeatList, followerStep, hasBeatGrid, incomingStartPosition, phaseErrorSeconds } from './djBeatMath.js';
import { createFollowLoop } from './followLoop.js';
import { rememberDjTransition } from './djModeService.js';
import { dedupeQueue, insertAfter, insertAtEnd, queueItemKey, reorderQueue, restoreQueueState, serializeQueueState } from '../queueManager.js';
import { createDjVoice } from './djVoice.js';

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
  constructor({ resolveUrl, createAudio = () => new VinylAudioEngine(), storage, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), getRecommendations, followTimers, createVoice = createDjVoice } = {}) {
    this.sleep = sleep;
    this.followTimers = followTimers;
    this.resolveUrl = resolveUrl;
    this.createAudio = createAudio;
    this.storage = storage;
    this.now = now;
    this.getRecommendations = getRecommendations || null;
    this.recommendationSequence = 0;
    this.recommendationAbort = null;
    this.voice = createVoice({ duck: (db, s) => this.setDuck(db, s) });
    let saved;
    try { saved = restoreQueueState(storage?.getItem(QUEUE_STORAGE_KEY)); } catch { /* storage may be disabled */ }
    this.state = {
      currentSong: null, currentSongKey: null, queue: saved?.queue || [], queueIndex: saved?.queueIndex || 0,
      manualQueue: saved?.manualQueue || [],
      queueRevision: 0, isPlaying: false, isSpinningDown: false, isBuffering: false,
      progress: 0, duration: 0, buffered: 0, error: '', playbackEvent: null,
      shuffleMode: saved?.shuffleMode || 'off', repeatMode: saved?.repeatMode || 'off',
      resumeOnRestore: Boolean(saved?.isPlaying), resumePosition: saved?.positionSeconds || 0,
      volume: saved?.volume ?? 1, muted: saved?.muted || false, crossfadeSeconds: saved?.crossfadeSeconds || 0,
      sleepTimer: saved?.sleepTimer || null, sleepRemaining: 0,
      djModeEnabled: Boolean(saved?.djModeEnabled), djVoiceEnabled: Boolean(saved?.djVoiceEnabled), djPrediction: null, djPlan: null,
      djHistory: saved?.djHistory || { candidateKeys: [], timingBuckets: [], styles: [] },
      eqPreset: saved?.eqPreset || 'flat', eqGains: saved?.eqGains || [...EQ_PRESETS.flat.gains], eqEnabled: saved?.eqEnabled !== false,
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
    this.fadeTimer = null;
    this.bassTimer = null;
    this.filterTimer = null;
    this.beatMixPitchShifted = false;
    this.bassCutApplied = false;
    this.filterSweepApplied = false;
    this.echoApplied = false;
    this.pitchGlide = null;
    this.followLoop = null;
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
  configurePlayback = ({ enabled, resolveSong, getRecommendations }) => {
    this.resolveSong = resolveSong || this.resolveSong;
    if (getRecommendations !== undefined) this.getRecommendations = getRecommendations;
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
    audio.setEqEnabled?.(this.state.eqEnabled);
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
    this.finishFade();
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
  // After a beat-synced mix the new track keeps the tempo it was matched to, then eases back to the user's
  // own pitch setting over several seconds, like sliding a pitch fader home. Jumping back would be heard
  // as a pitch bend of up to a semitone.
  glidePitchHome = (engine, seconds = 6) => {
    clearInterval(this.pitchGlide);
    const from = engine.pitchModifier;
    const startedAt = this.now();
    this.pitchGlide = setInterval(() => {
      if (this.audio !== engine) { clearInterval(this.pitchGlide); this.pitchGlide = null; return; }
      const progress = Math.min(1, (this.now() - startedAt) / (seconds * 1000));
      const eased = progress * progress * (3 - 2 * progress);
      engine.setPitchModifier(from + (this.state.pitchModifier - from) * eased);
      if (progress >= 1) { clearInterval(this.pitchGlide); this.pitchGlide = null; }
    }, 250);
  };
  finishFade = ({ glide = false } = {}) => {
    clearTimeout(this.fadeTimer);
    this.fadeTimer = null;
    clearTimeout(this.bassTimer);
    this.bassTimer = null;
    clearTimeout(this.filterTimer);
    this.filterTimer = null;
    if (this.bassCutApplied) {
      this.bassCutApplied = false;
      this.audio?.setBassCut?.(0);
      this.retiring?.setBassCut?.(0);
      this.standby?.setBassCut?.(0); // A mix abandoned before it started leaves the cut on the idle engine.
    }
    if (this.filterSweepApplied) {
      this.filterSweepApplied = false;
    }
    this.audio?.setSweep?.('off');
    this.retiring?.setSweep?.('off');
    this.standby?.setSweep?.('off');

    if (this.echoApplied) {
      this.echoApplied = false;
    }
    this.audio?.setEcho?.(0);
    this.retiring?.setEcho?.(0);
    this.standby?.setEcho?.(0);

    this.followLoop?.stop('finished');
    this.followLoop = null;
    clearInterval(this.pitchGlide);
    this.pitchGlide = null;
    if (this.beatMixPitchShifted) {
      this.beatMixPitchShifted = false;
      if (glide && this.audio) this.glidePitchHome(this.audio);
      else this.audio?.setPitchModifier?.(this.state.pitchModifier);
    }
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
    this.voice?.cancel?.();
    this.invalidateSelection({ keepAudio });
    this.desiredPlaying = autoplay;
    this.smartNextKey = null;
    if (!this.djPlan || keyOf(this.djPlan.candidate) !== keyOf(this.state.queue[index])) this.djPlan = null;
    const currentSong = this.state.queue[index];
    const currentKey = keyOf(currentSong);
    const manualQueue = (this.state.manualQueue || []).filter(item => keyOf(item) !== currentKey);
    this.update({ queueIndex: index, queueRevision: this.state.queueRevision + 1,
      resumePosition: resetPosition ? 0 : this.state.resumePosition, resumeOnRestore: autoplay,
      manualQueue,
      currentSong, currentSongKey: currentKey, djPlan: this.djPlan ? this.state.djPlan : null, djPrediction: null,
      progress: 0, duration: 0, buffered: 0, isPlaying: false, isBuffering: true, error: '',
    });
    this.persist();
    if (autoLoad) this.prepareSelection();
    if (this.state.queue.length - index - 1 < 3) {
      this.fetchRecommendations(currentSong);
    }
    return true;
  }
  // `play()` resolves before the first audible sample, so the start position chosen up front is off by the
  // start-up latency. Once the element is really advancing, measure the beat-phase error against the
  // outgoing track and step the incoming track onto the grid. It is still at gain 0 (the fade-in has not
  // begun), so the seeks are inaudible; a seek takes a moment to settle, so measure again and repeat.
  lockBeatPhase = async (mix, outgoing, incoming, isCurrent) => {
    const octave = mix.tempoOctave || 0;
    const beat = beatSeconds(mix.candidateRhythm);
    if (!beat) return;
    let reference = incoming.currentTime;
    let lead = 0; // Time a seek costs before audio resumes; learned from the error left after the previous seek.
    for (let attempt = 0; attempt < 4 && isCurrent(); attempt++) {
      if (attempt === 0) for (let waited = 0; waited < 300 && incoming.currentTime - reference < 0.01; waited += 20) await this.sleep(20);
      else await this.sleep(60);
      if (!isCurrent()) return;
      const outNow = outgoing.currentTime;
      const inNow = incoming.currentTime;
      const err = phaseErrorSeconds(mix.sourceRhythm, outNow, mix.candidateRhythm, inNow, octave);
      if (!Number.isFinite(err) || Math.abs(err) <= 0.008 || Math.abs(err) >= 0.75 * beat) return;
      if (attempt > 0) lead = Math.max(0, Math.min(0.15, lead - err));
      incoming.seek(inNow - err + lead);
      reference = inNow - err + lead;
    }
  };
  loadAndPlay = async (song, { autoplay = true, startAt = 0, signal, crossfade = 0, mix = null } = {}) => {
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
    this.commentarySpoken = false;
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
        mix = null;
        crossfade = 0;
        outgoing.clear();
        const url = await this.resolveUrl(song, abort.signal);
        if (!latest()) return false;
        await incoming.loadUrl(url);
      }
      if (!latest()) return false;
      this.applySettings(incoming);
      if (startAt > 0) incoming.seek(bounded(startAt, Math.max(0, incoming.duration - 0.25)));
      const style = mix ? (mix.style || 'beat-blend') : 'plain';
      let canFade = false;
      if (crossfade > 0 && this.desiredPlaying && incoming !== outgoing && !outgoing.paused) {
        const incomingContext = incoming.ensureContext();
        const outgoingContext = outgoing.ensureContext();
        canFade = Boolean(incomingContext && outgoingContext);
        if (canFade) {
          if (style === 'cut' || style === 'echo-out') {
            incoming.setFade(1);
          } else {
            incoming.setFade(0);
          }
        }
      }
      const isBeatMix = Boolean(canFade && mix && (style === 'beat-blend' || style === 'filter-blend'));
      if (isBeatMix) {
        this.beatMixPitchShifted = true;
        const outPitch = Number.isFinite(outgoing.pitchModifier) ? outgoing.pitchModifier : (this.state.pitchModifier || 1);
        incoming.setPitchModifier(outPitch * (mix.tempoRatio || 1));
        const outRate = Math.max(0.05, Number(outgoing.targetMotorRate) || 1);
        const start = incomingStartPosition(
          mix.sourceRhythm,
          outgoing.currentTime + 0.06 * outRate,
          mix.candidateRhythm,
          mix.tempoOctave || 0
        );
        if (start && Number.isFinite(start.position)) {
          const maxPosition = incoming.duration ? Math.max(0, incoming.duration - 0.25) : start.position;
          incoming.seek(Math.max(0, Math.min(maxPosition, start.position)));
        }
        if (style === 'beat-blend') {
          this.bassCutApplied = true;
          incoming.setBassCut(-30);
        } else if (style === 'filter-blend') {
          this.filterSweepApplied = true;
          incoming.setSweep('highpass', 400);
        }
      } else if (canFade && mix && style === 'echo-out') {
        this.echoApplied = true;
        const outBeat = beatSeconds(mix.sourceRhythm);
        const delaySec = outBeat || 0.5;
        outgoing.setEcho(1, delaySec);
        if (mix.candidateRhythm?.firstDownbeat != null) {
          incoming.seek(mix.candidateRhythm.firstDownbeat);
        }
      } else if (canFade && mix && style === 'cut') {
        const inDownbeat = mix.candidateRhythm?.firstDownbeat != null ? mix.candidateRhythm.firstDownbeat : 0;
        incoming.seek(inDownbeat);
      }
      if (this.desiredPlaying) await incoming.play();
      if (!latest()) return false;
      if (!this.desiredPlaying) incoming.pause({ immediate: true });
      if (incoming !== outgoing) {
        this.audio = incoming;
        this.audioRef.current = incoming;
        if (canFade && this.desiredPlaying) {
          this.retiring = outgoing;
          if (isBeatMix) {
            await this.lockBeatPhase(mix, outgoing, incoming, latest);
            if (!latest()) return false;
            this.speakTransitionCommentary(mix);
            const outBeats = decodeBeatList(mix.sourceRhythm?.outroBeats);
            const inBeats = decodeBeatList(mix.candidateRhythm?.introBeats);
            if (
              outBeats &&
              inBeats &&
              mix.sourceRhythm?.beatListVersion === 1 &&
              mix.candidateRhythm?.beatListVersion === 1 &&
              (mix.sourceRhythm?.outroVirtual ?? 0) <= 0.25 * outBeats.length &&
              (mix.candidateRhythm?.introVirtual ?? 0) <= 0.25 * inBeats.length &&
              outgoing.currentTime >= outBeats[0] - 8 &&
              outgoing.currentTime <= outBeats[outBeats.length - 1] + 8
            ) {
              const follower = beatFollower({
                outBeats,
                inBeats,
                octave: mix.tempoOctave || 0,
                outTime: outgoing.currentTime,
                inTime: incoming.currentTime,
              });
              if (follower) {
                const incomingBeatPeriod = beatSeconds(mix.candidateRhythm, mix.candidateRhythm?.startBpm)
                  || (inBeats.length >= 2 ? inBeats[1] - inBeats[0] : null)
                  || beatSeconds(mix.candidateRhythm)
                  || 0.5;
                const read = () => {
                  if (!latest() || this.retiring !== outgoing || this.audio !== incoming) return null;
                  if (outgoing.paused || incoming.paused) return null;
                  return {
                    outTime: outgoing.currentTime,
                    inTime: incoming.currentTime,
                    outRate: Number.isFinite(outgoing.targetMotorRate) ? outgoing.targetMotorRate : 1,
                  };
                };
                const step = reading => followerStep(follower, reading);
                const apply = rate => incoming.setPitchModifier(rate / ((incoming.rpm || 45) / 45));
                this.followLoop?.stop('finished');
                this.followLoop = createFollowLoop({
                  intervalMs: 100,
                  maxErrorSeconds: 0.75 * incomingBeatPeriod,
                  read,
                  step,
                  apply,
                  ...this.followTimers,
                });
                this.followLoop.start();
              }
            }
            const inBeat = beatSeconds(mix.candidateRhythm);
            incoming.setFade(1, crossfade, { curve: 'equal-power' });
            outgoing.setFade(0, crossfade, { curve: 'equal-power' });
            if (style === 'beat-blend') {
              const rate = Math.max(0.05, Number(incoming.targetMotorRate || outgoing.targetMotorRate) || 1);
              const r = Math.max(0.25, Math.min(1.5, (inBeat || 0.5) / rate));
              this.bassTimer = setTimeout(() => {
                this.bassTimer = null;
                outgoing?.setBassCut?.(-30, r);
                incoming?.setBassCut?.(0, r);
              }, crossfade * 500);
            } else if (style === 'filter-blend') {
              outgoing.setSweep('lowpass', 250, crossfade);
              incoming.setSweep('off', 10, crossfade / 2);
              this.filterTimer = setTimeout(() => {
                this.filterTimer = null;
                incoming?.setSweep?.('off');
              }, crossfade * 500);
            }
          } else if (style === 'echo-out' || style === 'cut') {
            this.speakTransitionCommentary(mix);
            incoming.setFade(1);
            outgoing.setFade(0, crossfade);
          } else {
            incoming.setFade(1, crossfade);
            outgoing.setFade(0, crossfade);
            this.speakTransitionCommentary(mix);
          }
          this.fadeDeadline = this.now() + crossfade * 1000;
          this.fadeTimer = setTimeout(() => { this.finishFade({ glide: isBeatMix }); this.preloadNext(); }, crossfade * 1000 + 50);
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
      if (completedDjPlan && !this.commentarySpoken) {
        this.speakTransitionCommentary(mix);
      }
      const djHistory = completedDjPlan ? rememberDjTransition(this.state.djHistory, keyOf(song), this.djPlan.transitionAtSeconds, this.djPlan.mixBars, this.djPlan.style) : this.state.djHistory;
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
      if (this.retiring && this.now() >= this.fadeDeadline) { this.finishFade({ glide: true }); this.preloadNext(); }
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
      const isSynced = Boolean(djDue && this.djPlan.beatSync);
      const requestedFade = djDue
        ? Math.min(isSynced ? this.djPlan.crossfadeSeconds / Math.max(0.0625, this.audio.targetMotorRate || 1) : this.djPlan.crossfadeSeconds, remaining)
        : remaining;
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
          this.loadAndPlay(song, { crossfade: requestedFade, ...(djDue ? { mix: this.djPlan } : (isSynced ? { mix: this.djPlan } : {})) });
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
    this.voice?.cancel?.();
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
    this.voice?.cancel?.();
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
  setQueueAndPlay = (songs, startIndex = 0, options = {}) => {
    const isSearch = Boolean(options?.isSearch);
    const preserveManual = options?.preserveManualQueue !== false;
    const selectedSong = songs?.[startIndex] || songs?.[0];
    const selectedKey = keyOf(selectedSong);
    if (!selectedKey) { this.clearQueue(); return; }

    // Preserve unplayed manual queue tracks
    const unplayedManual = preserveManual
      ? (this.state.manualQueue || []).filter(item => keyOf(item) !== selectedKey).map(cleanSong)
      : [];
    const manualQueue = unplayedManual;

    this.failed.clear(); this.played.clear(); this.originalQueue = [];
    let queue;
    let index = 0;

    if (isSearch) {
      // ONLY the selected track starts; the rest of that search batch must not enter the queue.
      // Preserved manual queue has priority immediately after selected track.
      queue = dedupeQueue([cleanSong(selectedSong), ...manualQueue]);
      index = 0;
    } else {
      // Explicit playlist/album context:
      const rawQueue = dedupeQueue(songs).map(cleanSong);
      const startInRaw = Math.max(0, rawQueue.findIndex(s => keyOf(s) === selectedKey));
      const head = rawQueue[startInRaw] || cleanSong(selectedSong);
      let contextUpcoming;

      if (this.state.shuffleMode === 'shuffle') {
        this.originalQueue = [...rawQueue];
        const remaining = rawQueue.filter((_, i) => i !== startInRaw);
        contextUpcoming = shuffle(remaining);
      } else {
        contextUpcoming = rawQueue.slice(startInRaw + 1);
      }

      // Manual queue priority: manual queue comes before context tracks!
      queue = dedupeQueue([head, ...manualQueue, ...contextUpcoming]);
      index = 0;
    }

    this.update({ queue, manualQueue });
    this.select(index);
    this.fetchRecommendations(queue[index]);
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
    const cleaned = cleanSong(song);
    const key = keyOf(cleaned);
    if (!this.state.queue.length) {
      this.update({ manualQueue: [cleaned] });
      this.setQueueAndPlay([cleaned]);
      return true;
    }
    if (key === keyOf(this.state.queue[this.state.queueIndex])) return false;
    this.failed.delete(key);

    const manualQueue = [cleaned, ...(this.state.manualQueue || []).filter(item => keyOf(item) !== key)];
    const filteredQueue = this.state.queue.filter((item, idx) => idx <= this.state.queueIndex || keyOf(item) !== key);
    const nextQueue = insertAfter(filteredQueue, this.state.queueIndex, cleaned);

    this.update({ manualQueue });
    this.editQueue(nextQueue, insertAtEnd(this.originalQueue, cleaned));
    return true;
  };
  addToQueue = song => {
    if (!keyOf(song)) return false;
    const cleaned = cleanSong(song);
    const key = keyOf(cleaned);
    if (!this.state.queue.length) {
      this.update({ manualQueue: [cleaned] });
      this.setQueueAndPlay([cleaned]);
      return true;
    }
    if (key === keyOf(this.state.queue[this.state.queueIndex])) return false;
    this.failed.delete(key);

    const manualQueue = [...(this.state.manualQueue || []).filter(item => keyOf(item) !== key), cleaned];
    const currentQueue = this.state.queue;
    const currentIndex = this.state.queueIndex;
    const manualKeys = new Set(manualQueue.map(keyOf));

    // Filter out previous occurrences of key after currentIndex
    const filteredQueue = currentQueue.filter((item, idx) => idx <= currentIndex || keyOf(item) !== key);

    // Find insertion position: after the last existing manual queue song after currentIndex
    let insertPos = currentIndex;
    for (let i = currentIndex + 1; i < filteredQueue.length; i++) {
      if (manualKeys.has(keyOf(filteredQueue[i]))) {
        insertPos = i;
      } else {
        break;
      }
    }

    const nextQueue = [...filteredQueue];
    nextQueue.splice(insertPos + 1, 0, cleaned);

    this.update({ manualQueue });
    this.editQueue(nextQueue, insertAtEnd(this.originalQueue, cleaned));
    return true;
  };
  removeFromQueue = index => {
    if (!Number.isInteger(index) || !this.state.queue[index]) return false;
    const key = keyOf(this.state.queue[index]);
    const queue = this.state.queue.filter((_, i) => i !== index);
    const original = this.originalQueue.filter(song => keyOf(song) !== key);
    const manualQueue = (this.state.manualQueue || []).filter(song => keyOf(song) !== key);
    const removedCurrent = index === this.state.queueIndex;
    if (!queue.length) { this.clearQueue(); return true; }
    const autoplay = this.desiredPlaying;
    this.update({ manualQueue });
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
    this.recommendationAbort?.abort();
    this.update({ queue: [], manualQueue: [], queueIndex: 0, queueRevision: this.state.queueRevision + 1 }); this.persist();
  };
  fetchRecommendations = async (currentSong = this.state.currentSong) => {
    if (!this.active || !this.getRecommendations || !currentSong) return;
    const songKey = keyOf(currentSong);
    if (!songKey) return;

    const seq = ++this.recommendationSequence;
    this.recommendationAbort?.abort();
    const abort = new AbortController();
    this.recommendationAbort = abort;

    try {
      const recommendations = await this.getRecommendations({
        currentSong,
        manualQueue: this.state.manualQueue || [],
        signal: abort.signal,
      });

      // Stale response guard: check if sequence matches, current song hasn't changed, and controller is still active
      if (!this.active || seq !== this.recommendationSequence || abort.signal.aborted) return;
      if (keyOf(this.state.currentSong) !== songKey) return;
      if (!Array.isArray(recommendations) || recommendations.length === 0) return;

      const currentQueue = this.state.queue;
      const existingKeys = new Set(currentQueue.map(keyOf));
      const cleanRecs = dedupeQueue(recommendations)
        .map(cleanSong)
        .filter(rec => !existingKeys.has(keyOf(rec)));

      if (!cleanRecs.length || seq !== this.recommendationSequence || abort.signal.aborted) return;
      if (keyOf(this.state.currentSong) !== songKey) return;

      // Append cleanRecs to queue (after any manual queue and context tracks)
      const newQueue = [...this.state.queue, ...cleanRecs];
      this.update({ queue: newQueue, queueRevision: this.state.queueRevision + 1 });
      this.preloadNext();
      this.persist();
    } catch (error) {
      if (seq !== this.recommendationSequence || abort.signal.aborted) return;
      console.warn('Up Next recommendation fetch failed:', error);
    } finally {
      if (this.recommendationAbort === abort) this.recommendationAbort = null;
    }
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
  setDjVoiceEnabled = enabled => {
    const djVoiceEnabled = Boolean(enabled);
    if (!djVoiceEnabled) this.voice?.cancel?.();
    this.update({ djVoiceEnabled });
    this.persist();
  };
  setDuck(db, seconds = 0) {
    this.audio?.setDuck?.(db, seconds);
    this.retiring?.setDuck?.(db, seconds);
  }
  speakDj(text) {
    if (!this.state.djVoiceEnabled) return Promise.resolve('disabled');
    return this.voice?.speak(text) ?? Promise.resolve('unavailable');
  }
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
    const beatSync = Boolean(plan.beatSync) && hasBeatGrid(plan.sourceRhythm) && hasBeatGrid(plan.candidateRhythm);
    const style = plan.style || (beatSync ? 'beat-blend' : 'plain');
    const isCut = style === 'cut';
    const crossfadeSeconds = isCut
      ? Math.max(0.05, Math.min(1, Number(plan.crossfadeSeconds) || 0.06))
      : beatSync
        ? Math.max(2, Math.min(40, Number(plan.crossfadeSeconds) || 4))
        : Math.max(0.05, Math.min(7, Number(plan.crossfadeSeconds) || 4));
    const transitionAtSeconds = Number(plan.transitionAtSeconds);
    if (!Number.isFinite(transitionAtSeconds) || transitionAtSeconds <= this.audio.currentTime || transitionAtSeconds > this.audio.duration - crossfadeSeconds) return false;
    this.cancelPreload();
    this.djPlan = {
      ...plan,
      source,
      candidate,
      sourceSongKey: keyOf(source),
      transitionAtSeconds,
      crossfadeSeconds,
      beatSync,
      style,
      styleReason: plan.styleReason || null,
      mixBars: plan.mixBars,
      tempoRatio: plan.tempoRatio,
      tempoOctave: plan.tempoOctave,
      sourceRhythm: plan.sourceRhythm,
      candidateRhythm: plan.candidateRhythm,
      commentaryText: plan.commentaryText || plan.commentary || null,
    };
    this.update({ djPlan: {
      candidateSongKey: keyOf(candidate), candidateTitle: candidate.track, transitionAtSeconds, crossfadeSeconds, probability: Number(plan.probability || 0), fallback: Boolean(plan.fallback),
      beatSync,
      style,
    } });
    this.preloadNext();
    this.persist();
    return true;
  };
  speakTransitionCommentary(mix) {
    if (this.commentarySpoken) return;
    const text = mix?.commentaryText || mix?.commentary || this.djPlan?.commentaryText || this.djPlan?.commentary;
    if (text) {
      this.commentarySpoken = true;
      try {
        Promise.resolve(this.speakDj(text)).catch(() => {});
      } catch {
        /* catch and ignore */
      }
    }
  }
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
  setPitchModifier = value => { this.followLoop?.stop('finished'); this.followLoop = null; clearInterval(this.pitchGlide); this.pitchGlide = null; const pitchModifier = Math.max(1 - this.state.pitchRange, bounded(value, 1 + this.state.pitchRange, 1)); this.audio?.setPitchModifier(pitchModifier); this.update({ pitchModifier }); };
  setPitchRange = value => { this.update({ pitchRange: Number(value) >= 0.16 ? 0.16 : 0.08 }); this.setPitchModifier(this.state.pitchModifier); };
  beginScratch = resume => { this.finishFade(); this.audio?.beginScratch({ resume }); };
  setScratchAngularVelocity = value => this.audio?.setScratchAngularVelocity(value);
  endScratch = () => this.audio?.endScratch();
  setNeedleLifted = value => { this.finishFade(); this.audio?.setNeedleLifted(value); };
  setEqPreset = preset => { if (!EQ_PRESETS[preset]) return; this.update({ eqPreset: preset, eqGains: [...EQ_PRESETS[preset].gains] }); this.applySettings(this.audio); this.persist(); };
  setBandGain = (index, gain) => { this.audio?.setBandGain(index, gain); this.update({ eqPreset: 'custom', eqGains: this.audio.currentGains }); this.persist(); };
  setEqGains = gains => { this.audio?.setEqGains?.(gains); this.update({ eqPreset: 'custom', eqGains: this.audio?.currentGains || [...gains] }); this.persist(); };
  setEqEnabled = enabled => { this.audio?.setEqEnabled?.(enabled); this.update({ eqEnabled: enabled !== false }); this.persist(); };
  clearError = () => this.update({ error: '' });
  setPlayerError = message => this.update({ error: message || '', isBuffering: false });
  visibilityChanged = hidden => { this.audio?.handleVisibilityChange(hidden); this.retiring?.handleVisibilityChange(hidden); this.checkSleep(); this.persist(); };
  dispose = () => {
    this.voice?.cancel?.();
    this.djPlan = null;
    this.recommendationAbort?.abort();
    this.update({ djPlan: null, djPrediction: null });
    this.persist(); this.active = false; this.enabled = false; this.cancelLoad(); this.cancelPreload(); this.finishFade();
    this.followLoop?.stop('finished'); this.followLoop = null;
    this.audio?.dispose(); this.standby?.dispose(); this.audio = null; this.standby = null; this.loadedSong = null;
  };
}
