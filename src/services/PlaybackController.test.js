import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackController, QUEUE_STORAGE_KEY } from './PlaybackController.js';
import { MAX_FOLLOW_RATE_STEP, incomingStartPosition, phaseErrorSeconds } from './djBeatMath.js';

const songs = ['a', 'b', 'c', 'd'].map(songKey => ({ songKey, track: songKey, artist: 'Artist', driveFileId: songKey }));
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

class FakeAudio {
  constructor() {
    this.listeners = new Map(); this.duration = 0; this.currentTime = 0; this.paused = true; this.src = ''; this.error = null;
    this.currentGains = [0, 0, 0, 0, 0]; this.fades = []; this.targetMotorRate = 1; this.pitchModifier = 1; this.rpm = 45;
    this.pitchModifierCalls = []; this.bassCuts = []; this.seeks = [];
    this.element = { readyState: 4, seeking: false, buffered: { length: 0 } };
  }
  addEventListener(type, cb) { const listeners = this.listeners.get(type) || []; listeners.push(cb); this.listeners.set(type, listeners); }
  emit(type, detail = {}) { for (const cb of this.listeners.get(type) || []) cb({ type, ...detail }); }
  async loadUrl(url) { this.src = url; this.duration = 100; this.currentTime = 0; this.emit('durationchange'); }
  getAttribute() { return this.src; }
  async play() { if (this.playGate) await this.playGate.promise; this.paused = false; this.emit('play'); }
  pause() { this.paused = true; this.emit('pause'); }
  clear() { this.src = ''; this.duration = 0; this.currentTime = 0; this.paused = true; this.emit('timeupdate'); }
  seek(value) { this.currentTime = value; this.seeks.push(value); this.emit('timeupdate'); }
  setVolume(value) { this.volume = value; }
  setRpm(value) { this.rpm = Number(value) < 40 ? 100 / 3 : 45; }
  setPitchModifier(value) { this.pitchModifier = value; this.pitchModifierCalls.push(value); this.targetMotorRate = (this.rpm / 45) * value; }
  applyPreset() {} setBandGain() {}
  ensureContext() { return {}; }
  setFade(value, seconds, options) { this.fades.push([value, seconds, options]); return true; }
  setBassCut(db, seconds = 0) { this.bassCuts.push([db, seconds]); return true; }
  handleVisibilityChange() {} beginScratch() {} endScratch() {} setNeedleLifted() {}
  dispose() { this.clear(); this.disposed = true; }
}
function fixture(t, options = {}) {
  const entries = new Map();
  const storage = { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value) };
  const controller = new PlaybackController({ resolveUrl: async song => song.driveFileId, createAudio: () => new FakeAudio(), storage, sleep: async () => {}, ...options });
  controller.activate(); controller.configurePlayback({ enabled: true });
  t.after(() => controller.dispose());
  return { c: controller, storage };
}

test('rapid skipping rejects an older preparation without touching the newest source', async t => {
  const first = deferred();
  const { c } = fixture(t);
  c.configurePlayback({ enabled: true, resolveSong: song => song.songKey === 'a' ? first.promise : Promise.resolve(song) });
  c.setQueueAndPlay(songs);
  c.playNext({ reason: 'user-next' }); c.playNext({ reason: 'user-next' });
  await settle(); first.resolve(songs[0]); await settle();
  assert.equal(c.state.queueIndex, 2); assert.equal(c.audio.src, 'c'); assert.equal(c.state.currentSongKey, 'c'); assert.equal(c.state.isPlaying, true);
});

test('stale URL resolution and clearing a loading queue never resurrect playback', async t => {
  const gate = deferred(); const { c } = fixture(t, { resolveUrl: () => gate.promise });
  c.setQueueAndPlay(songs); await settle(); c.clearQueue(); gate.resolve('a'); await settle();
  assert.equal(c.audio.src, ''); assert.equal(c.state.currentSong, null); assert.equal(c.state.isPlaying, false); assert.deepEqual(c.state.queue, []);
});

test('pause and volume changes while loading win over the original autoplay request', async t => {
  const gate = deferred(); const { c } = fixture(t, { resolveUrl: () => gate.promise });
  c.setQueueAndPlay(songs); await settle(); c.pause(); c.changeVolume(.23); gate.resolve('a'); await settle();
  assert.equal(c.state.isPlaying, false); assert.equal(c.audio.paused, true); assert.equal(c.audio.volume, .23);
  assert.equal(c.state.isBuffering, false);
});

test('queue edits preserve the playing identity and shuffle restoration preserves additions/deletions', async t => {
  const { c } = fixture(t); c.setQueueAndPlay(songs, 1); await settle(); const audio = c.audio;
  c.addToQueue(songs[0]); assert.equal(c.state.queue[c.state.queueIndex].songKey, 'b'); assert.equal(c.audio, audio);
  c.enqueueNext(songs[1]); assert.equal(c.state.queue[c.state.queueIndex].songKey, 'b');
  c.toggleShuffle(); c.removeFromQueue(c.state.queue.findIndex(s => s.songKey === 'c'));
  c.addToQueue({ ...songs[0], songKey: 'e', driveFileId: 'e' }); c.toggleShuffle(); c.toggleShuffle();
  assert.equal(c.state.queue.some(s => s.songKey === 'c'), false); assert.equal(c.state.queue.some(s => s.songKey === 'e'), true);
  assert.equal(c.state.queue[c.state.queueIndex].songKey, 'b');
});

test('empty shuffled queue and deduplication retain a valid selection', async t => {
  const { c } = fixture(t); c.toggleShuffle(); c.setQueueAndPlay([]); assert.deepEqual(c.state.queue, []);
  c.setQueueAndPlay([songs[0], songs[0], songs[2]], 2); await settle(); assert.equal(c.state.currentSongKey, 'c');
});

test('end of queue stops UI state, repeat all replays a single track, previous restarts', async t => {
  const { c } = fixture(t); c.setQueueAndPlay([songs[0]]); await settle();
  c.audio.currentTime = 100; c.audio.paused = true; c.audio.emit('ended');
  assert.equal(c.state.isPlaying, false); assert.equal(c.desiredPlaying, false);
  c.toggleRepeat(); c.toggleRepeat(); c.play(); await settle();
  c.audio.currentTime = 100; c.audio.paused = true; c.audio.emit('ended'); await settle();
  assert.equal(c.audio.currentTime, 0); assert.equal(c.state.isPlaying, true);
  c.audio.currentTime = 20; c.playPrev(); assert.equal(c.audio.currentTime, 0);
});

test('all failed tracks stop once; blocked tracks are skipped without an infinite retry loop', async t => {
  const { c } = fixture(t, { resolveUrl: async () => { throw new Error('broken file'); } });
  c.setQueueAndPlay(songs.slice(0, 3)); await settle();
  assert.equal(c.state.queueIndex, 2); assert.equal(c.failed.size, 3); assert.equal(c.state.isPlaying, false); assert.equal(c.loading, false);
  assert.match(c.state.error, /broken file/);
});

test('preloading reuses the next decoder, and reordering replaces a stale preload', async t => {
  const { c } = fixture(t); c.setQueueAndPlay(songs); await settle();
  assert.equal(c.preloaded.songKey, 'b'); const prepared = c.standby;
  c.playNext(); await settle(); assert.equal(c.audio, prepared); assert.equal(c.state.currentSongKey, 'b');
  c.reorderQueue(3, 2); await settle(); assert.equal(c.preloaded.songKey, 'd');
});

test('crossfade overlaps two decks, and pause clears outgoing audio and gain automation', async t => {
  const { c } = fixture(t); c.setCrossfade(6); c.setQueueAndPlay(songs); await settle();
  const outgoing = c.audio; c.audio.currentTime = 95; c.audio.emit('timeupdate'); await settle();
  assert.equal(c.state.currentSongKey, 'b'); assert.equal(c.retiring, outgoing); assert.equal(outgoing.paused, false);
  assert.ok(outgoing.fades.some(([value, seconds]) => value === 0 && seconds === 5));
  c.pause(); assert.equal(c.retiring, null); assert.equal(outgoing.paused, true); assert.equal(c.audio.paused, true);
});

test('sleep timer uses a wall-clock deadline across background suspension', async t => {
  let now = 1000; const { c } = fixture(t, { now: () => now });
  c.setQueueAndPlay(songs); await settle(); c.setSleepTimer(5); now += 301000; c.visibilityChanged(false);
  assert.equal(c.state.sleepTimer, null); assert.equal(c.state.isPlaying, false); assert.equal(c.desiredPlaying, false);
});

test('end-of-track sleep overrides crossfade and repeat', async t => {
  const { c } = fixture(t); c.setQueueAndPlay(songs); await settle(); c.setCrossfade(6); c.setSleepTimer('track'); c.toggleRepeat();
  c.audio.currentTime = 95; c.audio.emit('timeupdate'); await settle(); assert.equal(c.state.currentSongKey, 'a');
  c.audio.currentTime = 100; c.audio.emit('ended'); await settle(); assert.equal(c.state.isPlaying, false); assert.equal(c.state.sleepTimer, null);
});

test('StrictMode cleanup and activation replace disposed native engines and restore playback', async t => {
  const { c } = fixture(t); c.setQueueAndPlay(songs); await settle(); const original = c.audio;
  c.dispose(); c.activate(); c.configurePlayback({ enabled: true }); await settle();
  assert.notEqual(c.audio, original); assert.equal(original.disposed, true); assert.equal(c.state.currentSongKey, 'a'); assert.equal(c.state.isPlaying, true);
});

test('saved shuffle, volume, mute and crossfade settings survive restoration', async t => {
  const { c, storage } = fixture(t); c.setQueueAndPlay(songs); await settle(); c.toggleShuffle(); c.changeVolume(.4); c.toggleMute(); c.setCrossfade(4);
  const saved = JSON.parse(storage.getItem(QUEUE_STORAGE_KEY));
  assert.equal(saved.volume, .4); assert.equal(saved.muted, true); assert.equal(saved.crossfadeSeconds, 4); assert.equal(saved.shuffleMode, 'shuffle'); assert.equal(saved.originalQueue.length, 4);
});

test('pausing a pending native play rejection keeps the loaded track resumable', async t => {
  const { c } = fixture(t); const gate = deferred(); c.audio.playGate = gate;
  c.setQueueAndPlay([songs[0]]); await settle(); c.pause();
  gate.reject(Object.assign(new Error('interrupted'), { name: 'AbortError' })); await settle();
  assert.equal(c.loading, false); assert.equal(c.loadedSong.songKey, 'a');
  c.audio.playGate = null; await c.play(); assert.equal(c.state.isPlaying, true);
});

test('cancelling a pending crossfade releases the incoming decoder immediately', async t => {
  const { c } = fixture(t); c.setQueueAndPlay(songs); await settle(); c.setCrossfade(6);
  const incoming = c.standby; const gate = deferred(); incoming.playGate = gate;
  c.audio.currentTime = 95; c.audio.emit('timeupdate'); await settle(); c.clearQueue();
  assert.equal(incoming.src, ''); assert.equal(incoming.paused, true);
  gate.reject(Object.assign(new Error('interrupted'), { name: 'AbortError' })); await settle();
  assert.equal(c.state.isPlaying, false); assert.deepEqual(c.state.queue, []);
});


test('disconnect cancels both crossfade decks and reconnect preserves the paused position', async t => {
  const { c } = fixture(t); c.setQueueAndPlay(songs); await settle();
  c.setCrossfade(6); c.audio.currentTime = 95; c.audio.emit('timeupdate'); await settle();
  assert.ok(c.retiring); c.audio.currentTime = 3;
  c.configurePlayback({ enabled: false });
  assert.equal(c.retiring, null); assert.equal(c.audio.paused, true); assert.equal(c.state.resumePosition, 3);
  c.configurePlayback({ enabled: true }); await settle();
  assert.equal(c.audio.currentTime, 3); assert.equal(c.audio.paused, true);
});


test('autoplay denial on a preloaded deck retains both engines for retry and disposal', async t => {
  const { c } = fixture(t); c.setQueueAndPlay(songs); await settle();
  const outgoing = c.audio, incoming = c.standby;
  incoming.playGate = deferred(); c.playNext(); await settle();
  incoming.playGate.reject(Object.assign(new Error('gesture required'), { name: 'NotAllowedError' })); await settle();
  assert.equal(c.audio, incoming); assert.equal(c.standby, outgoing); assert.equal(outgoing.paused, true);
  assert.equal(c.state.isPlaying, false); assert.match(c.state.error, /Press play/);
  incoming.playGate = null; await c.play(); assert.equal(c.state.isPlaying, true);
});

test('DJ preloads without editing the queue, waits for media time through buffering, and records no false completion', async t => {
  let now = 1000;
  const { c } = fixture(t, { now: () => now });
  c.setQueueAndPlay(songs); await settle(); c.setDjModeEnabled(true);
  const events = [];
  c.subscribe(() => { if (c.state.playbackEvent) events.push(c.state.playbackEvent.eventType); });
  c.audio.currentTime = 10;
  assert.equal(c.planDjTransition({ sourceSongKey: 'a', candidate: songs[2], transitionAtSeconds: 20, crossfadeSeconds: 4 }), true);
  await settle();
  assert.deepEqual(c.state.queue.map(song => song.songKey), ['a', 'b', 'c', 'd']);
  assert.equal(c.preloaded.songKey, 'c');
  now += 60000; c.audio.emit('timeupdate'); await settle();
  assert.equal(c.state.currentSongKey, 'a');
  c.audio.currentTime = 20; c.audio.emit('timeupdate'); await settle();
  assert.equal(c.state.currentSongKey, 'c');
  assert.ok(c.retiring);
  assert.ok(events.includes('dj-transition'));
  assert.ok(!events.includes('playback-complete'));
  assert.deepEqual(c.state.djHistory.candidateKeys, ['c']);
});

test('DJ plans cancel on seek, queue edits, disable, and reject a stale source', async t => {
  const { c } = fixture(t); c.setQueueAndPlay(songs); await settle(); c.setDjModeEnabled(true);
  const plan = () => c.planDjTransition({ sourceSongKey: 'a', candidate: songs[2], transitionAtSeconds: 30, crossfadeSeconds: 4 });
  assert.equal(c.planDjTransition({ sourceSongKey: 'other', candidate: songs[2], transitionAtSeconds: 30 }), false);
  assert.ok(plan()); c.seek(10); assert.equal(c.state.djPlan, null); await settle();
  assert.ok(plan()); c.reorderQueue(2, 3); assert.equal(c.state.djPlan, null); await settle();
  assert.ok(plan()); c.setDjModeEnabled(false); assert.equal(c.state.djPlan, null); await settle();
  assert.deepEqual(c.state.djHistory.candidateKeys, []);
  assert.equal(c.preloaded.songKey, 'b');
});

test('failed DJ preload leaves current audio playing and restores ordinary preloading', async t => {
  const { c } = fixture(t, { resolveUrl: async song => { if (song.songKey === 'c') throw Error('unavailable'); return song.driveFileId; } });
  c.setQueueAndPlay(songs); await settle(); c.setDjModeEnabled(true);
  c.planDjTransition({ candidate: songs[2], transitionAtSeconds: 30, crossfadeSeconds: 4 }); await settle();
  assert.equal(c.state.currentSongKey, 'a');
  assert.equal(c.state.isPlaying, true);
  assert.equal(c.state.djPlan, null);
  assert.equal(c.preloaded.songKey, 'b');
  assert.ok(c.state.djHistory.candidateKeys.includes('c'));
});

test('search selection starts only the selected track and ignores the rest of the search batch', async t => {
  const { c } = fixture(t);
  c.setQueueAndPlay(songs, 1, { isSearch: true });
  await settle();
  assert.equal(c.state.currentSongKey, 'b');
  assert.deepEqual(c.state.queue.map(s => s.songKey), ['b']);
});

test('explicit context selection preserves upcoming playlist tracks in queue order', async t => {
  const { c } = fixture(t);
  c.setQueueAndPlay(songs, 1, { isSearch: false });
  await settle();
  assert.equal(c.state.currentSongKey, 'b');
  assert.deepEqual(c.state.queue.map(s => s.songKey), ['b', 'c', 'd']);
});

test('manual queue is preserved across search and playlist changes and maintains priority', async t => {
  const { c } = fixture(t);
  c.setQueueAndPlay([songs[0]], 0, { isSearch: true });
  await settle();
  c.addToQueue({ songKey: 'm1', track: 'M1', driveFileId: 'm1' });
  c.addToQueue({ songKey: 'm2', track: 'M2', driveFileId: 'm2' });

  // Starting a search result preserves unplayed manual queue tracks with priority
  c.setQueueAndPlay([songs[1], songs[2]], 0, { isSearch: true });
  await settle();
  assert.equal(c.state.currentSongKey, 'b');
  assert.deepEqual(c.state.queue.map(s => s.songKey), ['b', 'm1', 'm2']);

  // Starting an explicit playlist preserves manual queue with priority ahead of playlist context
  c.setQueueAndPlay([songs[0], songs[1], songs[2]], 0, { isSearch: false });
  await settle();
  assert.equal(c.state.currentSongKey, 'a');
  assert.deepEqual(c.state.queue.map(s => s.songKey), ['a', 'm1', 'm2', 'b', 'c']);
});

test('recommendations append after manual queue and stale async responses are safely discarded', async t => {
  const firstGate = deferred();
  const { c } = fixture(t, {
    getRecommendations: async ({ currentSong }) => {
      if (currentSong.songKey === 'a') {
        await firstGate.promise;
        return [{ songKey: 'rec-a', track: 'Rec A' }];
      }
      return [{ songKey: 'rec-b', track: 'Rec B' }];
    },
  });

  c.setQueueAndPlay([songs[0]], 0, { isSearch: true });
  c.addToQueue({ songKey: 'm1', track: 'M1', driveFileId: 'm1' });

  // Rapidly switch to song b before first recommendations resolve
  c.setQueueAndPlay([songs[1]], 0, { isSearch: true });
  await settle();

  // First deferred recommendations resolve after track switch
  firstGate.resolve();
  await settle();

  // Queue must contain song b, manual queue m1, and recommendations for b, NOT stale rec-a
  assert.equal(c.state.currentSongKey, 'b');
  assert.equal(c.state.queue.some(s => s.songKey === 'rec-a'), false);
  assert.deepEqual(c.state.queue.map(s => s.songKey), ['b', 'm1', 'rec-b']);
});

test('beat-synced DJ mix matches pitch, seeks start, equal-power fades, cuts bass, and finishFade restores settings', async t => {
  const outRhythm = { bpm: 120, firstDownbeat: 0, barBeats: 4, gridCoverage: 0.9, downbeatAgreement: 0.8, rhythmStatus: 'ready' };
  const inRhythm = { bpm: 125, firstDownbeat: 0, barBeats: 4, gridCoverage: 0.9, downbeatAgreement: 0.8, rhythmStatus: 'ready' };
  const songA = { ...songs[0], djRhythm: outRhythm };
  const songB = { ...songs[1], djRhythm: inRhythm };

  const { c } = fixture(t);
  c.setDjModeEnabled(true);
  c.setQueueAndPlay([songA, songB]);
  await settle();

  const outgoing = c.audio;
  outgoing.currentTime = 10;

  const plan = {
    candidate: songB,
    sourceSongKey: 'a',
    transitionAtSeconds: 20,
    crossfadeSeconds: 8,
    beatSync: true,
    mixBars: 4,
    tempoRatio: 120 / 125,
    tempoOctave: 0,
    sourceRhythm: outRhythm,
    candidateRhythm: inRhythm,
  };
  assert.equal(c.planDjTransition(plan), true);
  await settle();

  const incoming = c.standby;
  const expectedStart = incomingStartPosition(outRhythm, 20 + 0.06 * outgoing.targetMotorRate, inRhythm, 0);

  outgoing.currentTime = 20;
  outgoing.emit('timeupdate');
  await settle();

  // (a) calls setPitchModifier(outPitch * ratio) on the incoming engine
  assert.equal(incoming.pitchModifier, 1 * (120 / 125));
  assert.ok(incoming.pitchModifierCalls.includes(1 * (120 / 125)));

  // seeks incoming to incomingStartPosition(...)
  assert.equal(incoming.seeks[0], expectedStart.position);

  // uses curve: 'equal-power'
  assert.ok(incoming.fades.some(([val, , opt]) => val === 1 && opt?.curve === 'equal-power'));
  assert.ok(outgoing.fades.some(([val, , opt]) => val === 0 && opt?.curve === 'equal-power'));

  // applies bass cut -30 to incoming initially
  assert.ok(incoming.bassCuts.some(([db]) => db === -30));

  // after the fade finishFade restores bass 0 and the user's pitch
  c.finishFade();
  assert.equal(incoming.bassCuts.at(-1)[0], 0);
  assert.equal(outgoing.bassCuts.at(-1)[0], 0);
  assert.equal(c.audio.pitchModifier, 1);
});

test('plan without beatSync performs no setBassCut, no pitch change and a linear fade', async t => {
  const { c } = fixture(t);
  c.setDjModeEnabled(true);
  c.setQueueAndPlay(songs);
  await settle();

  const outgoing = c.audio;
  outgoing.currentTime = 10;

  const plan = {
    candidate: songs[1],
    sourceSongKey: 'a',
    transitionAtSeconds: 20,
    crossfadeSeconds: 4,
    beatSync: false,
  };
  assert.equal(c.planDjTransition(plan), true);
  await settle();

  const incoming = c.standby;

  outgoing.currentTime = 20;
  outgoing.emit('timeupdate');
  await settle();

  // No setBassCut during the transition
  assert.equal(incoming.bassCuts.length, 0);
  assert.equal(outgoing.bassCuts.length, 0);

  // No pitch change (pitch remains user setting 1)
  assert.equal(incoming.pitchModifier, 1);
  assert.deepEqual(incoming.pitchModifierCalls, [1]);

  // Linear fade (no equal-power curve)
  assert.ok(incoming.fades.some(([val, sec, opt]) => val === 1 && sec === 4 && (!opt || opt.curve !== 'equal-power')));
  assert.ok(outgoing.fades.some(([val, sec, opt]) => val === 0 && sec === 4 && (!opt || opt.curve !== 'equal-power')));
});

test('planDjTransition rejects beat-synced plan whose rhythms fail hasBeatGrid by falling back to 7s clamp with beatSync false', async t => {
  const { c } = fixture(t);
  c.setDjModeEnabled(true);
  c.setQueueAndPlay(songs);
  await settle();

  const badRhythm = { rhythmStatus: 'no-beats', bpm: 0 };
  const goodRhythm = { bpm: 120, firstDownbeat: 0, barBeats: 4, gridCoverage: 0.9, downbeatAgreement: 0.8, rhythmStatus: 'ready' };

  const plan = {
    candidate: songs[1],
    sourceSongKey: 'a',
    transitionAtSeconds: 20,
    crossfadeSeconds: 16,
    beatSync: true,
    sourceRhythm: badRhythm,
    candidateRhythm: goodRhythm,
  };
  assert.equal(c.planDjTransition(plan), true);
  assert.equal(c.djPlan.beatSync, false);
  assert.equal(c.djPlan.crossfadeSeconds, 7);
});

test('phase-correction seek only happens when measured error exceeds 4 ms', async t => {
  const outRhythm = { bpm: 120, firstDownbeat: 0, barBeats: 4, gridCoverage: 0.9, downbeatAgreement: 0.8, rhythmStatus: 'ready' };
  const inRhythm = { bpm: 120, firstDownbeat: 0, barBeats: 4, gridCoverage: 0.9, downbeatAgreement: 0.8, rhythmStatus: 'ready' };
  const songA = { ...songs[0], djRhythm: outRhythm };
  const songB = { ...songs[1], djRhythm: inRhythm };

  // Subcase 1: error <= 4ms (no phase correction seek)
  {
    const { c } = fixture(t);
    c.setDjModeEnabled(true);
    c.setQueueAndPlay([songA, songB]);
    await settle();

    const outgoing = c.audio;
    outgoing.currentTime = 10;

    const plan = {
      candidate: songB,
      sourceSongKey: 'a',
      transitionAtSeconds: 20,
      crossfadeSeconds: 8,
      beatSync: true,
      mixBars: 4,
      tempoRatio: 1,
      tempoOctave: 0,
      sourceRhythm: outRhythm,
      candidateRhythm: inRhythm,
    };
    assert.equal(c.planDjTransition(plan), true);
    await settle();

    const incoming = c.standby;
    // Advancing outgoing by 0.06 aligns it with the +0.06 lookahead used to compute start position
    const originalPlay = incoming.play.bind(incoming);
    incoming.play = async () => {
      outgoing.currentTime += 0.06;
      return originalPlay();
    };

    outgoing.currentTime = 20;
    outgoing.emit('timeupdate');
    await settle();

    // Only 1 seek occurred (initial seek before play)
    assert.equal(incoming.seeks.length, 1);
  }

  // Subcase 2: error > 4ms (phase correction seek occurs)
  {
    const { c } = fixture(t);
    c.setDjModeEnabled(true);
    c.setQueueAndPlay([songA, songB]);
    await settle();

    const outgoing = c.audio;
    outgoing.currentTime = 10;

    const plan = {
      candidate: songB,
      sourceSongKey: 'a',
      transitionAtSeconds: 20,
      crossfadeSeconds: 8,
      beatSync: true,
      mixBars: 4,
      tempoRatio: 1,
      tempoOctave: 0,
      sourceRhythm: outRhythm,
      candidateRhythm: inRhythm,
    };
    assert.equal(c.planDjTransition(plan), true);
    await settle();

    const incoming = c.standby;

    outgoing.currentTime = 20;
    outgoing.emit('timeupdate');
    await settle();

    // 2 seeks occurred: initial seek, then phase correction seek
    assert.equal(incoming.seeks.length, 2);
    // The incoming was placed for 60 ms after the outgoing's position, which it has not reached: it is
    // 60 ms ahead, so the correction moves it back by exactly that much.
    assert.ok(Math.abs(incoming.seeks[1] - (incoming.seeks[0] - 0.06)) < 1e-6, `expected a 60 ms step back, got ${incoming.seeks}`);
  }

  // Subcase 3: the outgoing ran 60 ms further than allowed for, so the incoming is behind: step forward.
  {
    const { c } = fixture(t);
    c.setDjModeEnabled(true);
    c.setQueueAndPlay([songA, songB]);
    await settle();
    const outgoing = c.audio;
    outgoing.currentTime = 10;
    assert.equal(c.planDjTransition({ candidate: songB, sourceSongKey: 'a', transitionAtSeconds: 20, crossfadeSeconds: 8, beatSync: true, mixBars: 4, tempoRatio: 1, tempoOctave: 0, sourceRhythm: outRhythm, candidateRhythm: inRhythm }), true);
    await settle();
    const incoming = c.standby;
    const originalPlay = incoming.play.bind(incoming);
    incoming.play = async () => { outgoing.currentTime += 0.12; return originalPlay(); };
    outgoing.currentTime = 20;
    outgoing.emit('timeupdate');
    await settle();
    assert.equal(incoming.seeks.length, 2);
    assert.ok(Math.abs(incoming.seeks[1] - (incoming.seeks[0] + 0.06)) < 1e-6, `expected a 60 ms step forward, got ${incoming.seeks}`);
  }
});

test('a beat mix that is abandoned before it starts does not leave the idle engine with its bass cut', async t => {
  const outRhythm = { bpm: 120, firstDownbeat: 0, barBeats: 4, gridCoverage: 0.9, downbeatAgreement: 0.8, rhythmStatus: 'ready' };
  const { c } = fixture(t);
  c.setDjModeEnabled(true);
  c.setQueueAndPlay([{ ...songs[0], djRhythm: outRhythm }, { ...songs[1], djRhythm: outRhythm }]);
  await settle();
  const outgoing = c.audio;
  outgoing.currentTime = 10;
  assert.equal(c.planDjTransition({ candidate: { ...songs[1], djRhythm: outRhythm }, sourceSongKey: 'a', transitionAtSeconds: 20, crossfadeSeconds: 8, beatSync: true, mixBars: 4, tempoRatio: 1, tempoOctave: 0, sourceRhythm: outRhythm, candidateRhythm: outRhythm }), true);
  await settle();
  const idle = c.standby;
  idle.play = async () => { throw new Error('autoplay blocked'); };
  outgoing.currentTime = 20;
  outgoing.emit('timeupdate');
  await settle();
  assert.deepEqual(idle.bassCuts[0], [-30, 0], 'the mix did cut the incoming bass before failing');
  c.finishFade();
  assert.deepEqual(idle.bassCuts.at(-1), [0, 0], 'and the cut is undone for whoever uses this engine next');
});

test('the beat lock waits for real playback, then keeps measuring until the incoming is on the grid even when seeks land late', async t => {
  const rhythm = { bpm: 120, firstDownbeat: 0, barBeats: 4, gridCoverage: 0.9, downbeatAgreement: 0.8, rhythmStatus: 'ready' };
  let outgoing; let incoming; let live = false; let stall = 0;
  // A stand-in clock: sleeping advances the outgoing track, and the incoming one once it has really started.
  const tick = seconds => {
    outgoing.currentTime += seconds;
    if (!live) return;
    const lost = Math.min(stall, seconds);
    stall -= lost;
    incoming.currentTime += seconds - lost;
  };
  const { c } = fixture(t, { sleep: async ms => tick(ms / 1000) });
  const next = { ...songs[1], djRhythm: rhythm };
  c.setDjModeEnabled(true);
  c.setQueueAndPlay([{ ...songs[0], djRhythm: rhythm }, next]);
  await settle();
  outgoing = c.audio;
  outgoing.currentTime = 10;
  assert.equal(c.planDjTransition({ candidate: next, sourceSongKey: 'a', transitionAtSeconds: 20, crossfadeSeconds: 8, beatSync: true, mixBars: 4, tempoRatio: 1, tempoOctave: 0, sourceRhythm: rhythm, candidateRhythm: rhythm }), true);
  await settle();
  incoming = c.standby;
  const play = incoming.play.bind(incoming);
  incoming.play = async () => { live = true; stall = 0.08; return play(); }; // play() resolves 80 ms before any sound
  const seek = incoming.seek.bind(incoming);
  incoming.seek = value => { seek(value); if (live) stall = 0.03; }; // every seek costs 30 ms
  outgoing.currentTime = 20;
  outgoing.emit('timeupdate');
  await settle();
  tick(0.1); // let any seek settle, then check where the incoming really is
  const error = phaseErrorSeconds(rhythm, outgoing.currentTime, rhythm, incoming.currentTime);
  assert.ok(Math.abs(error) <= 0.008, `expected the incoming within 8 ms of the grid, off by ${(error * 1000).toFixed(1)} ms after ${incoming.seeks.length - 1} corrections`);
  assert.ok(incoming.seeks.length >= 3, 'more than one correction was needed');
  assert.ok(incoming.seeks.length <= 5, 'and it converged instead of chasing');
  assert.deepEqual(incoming.fades.at(-1).slice(0, 3), [1, 8, { curve: 'equal-power' }], 'the fade-in only starts after the lock');
});

test('after a beat mix the pitch eases home over seconds instead of jumping, and a user change stops the glide', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { c } = fixture(t, { now: () => Date.now() });
  c.setQueueAndPlay([songs[0]]);
  await settle();
  const engine = c.audio;
  engine.pitchModifier = 1 / 1.05; // matched to a track 5% faster during the mix
  c.beatMixPitchShifted = true;
  c.finishFade({ glide: true });
  assert.equal(engine.pitchModifier, 1 / 1.05, 'nothing moves at the instant the mix ends');
  t.mock.timers.tick(1500);
  assert.ok(engine.pitchModifier > 1 / 1.05 && engine.pitchModifier < 0.99, `partway home after 1.5 s, got ${engine.pitchModifier}`);
  const steps = engine.pitchModifierCalls.slice(-6);
  assert.ok(steps.every((value, i) => i === 0 || (value >= steps[i - 1] && value - steps[i - 1] < 0.01)), 'in small steps');
  t.mock.timers.tick(6000);
  assert.equal(engine.pitchModifier, 1, 'home after the glide');

  engine.pitchModifier = 0.96;
  c.beatMixPitchShifted = true;
  c.finishFade({ glide: true });
  t.mock.timers.tick(1000);
  c.setPitchModifier(1.04);
  t.mock.timers.tick(7000);
  assert.equal(engine.pitchModifier, 1.04, 'the listener\'s own pitch move wins');

  engine.pitchModifier = 0.96;
  c.beatMixPitchShifted = true;
  c.finishFade();
  assert.equal(engine.pitchModifier, 1.04, 'an abrupt end (scratch, skip) restores at once');
});

function createTestTimer() {
  let cb = null;
  const setIntervalFn = fn => { cb = fn; return 1; };
  const clearIntervalFn = () => { cb = null; };
  const tick = () => { if (cb) cb(); };
  return {
    setIntervalFn,
    clearIntervalFn,
    tick,
    get registered() { return Boolean(cb); },
  };
}

test('beat follower PLL loop wiring in PlaybackController', async t => {
  const outBeats = [10000, ...Array(31).fill(500)];
  const inBeats = [0, ...Array(31).fill(500)];
  const outRhythm = {
    bpm: 120, firstDownbeat: 10, barBeats: 4, gridCoverage: 0.9, downbeatAgreement: 0.8,
    rhythmStatus: 'ready', outroStart: 10, outroBars: 8,
    outroBeats: outBeats, outroVirtual: 0, beatListVersion: 1,
  };
  const inRhythm = {
    bpm: 120, firstDownbeat: 0, barBeats: 4, gridCoverage: 0.9, downbeatAgreement: 0.8,
    rhythmStatus: 'ready', introBars: 8, startBpm: 120,
    introBeats: inBeats, introVirtual: 0, beatListVersion: 1,
  };

  // (a) with valid beat lists and an incoming engine whose fake currentTime runs 30 ms ahead of the desired beat,
  // after some 100 ms ticks the requested pitch modifier is lower than the feed-forward ratio (slowing down),
  // and the applied rates stay within MAX_FOLLOW_RATE_STEP of the feed-forward rate; with a 30 ms lag it speeds up
  // (mutating the sign of the correction must fail a test)
  {
    const timer = createTestTimer();
    const songA = { ...songs[0], djRhythm: outRhythm };
    const songB = { ...songs[1], djRhythm: inRhythm };
    const { c } = fixture(t, { followTimers: timer });
    c.setDjModeEnabled(true);
    c.setQueueAndPlay([songA, songB]);
    await settle();

    const outgoing = c.audio;
    outgoing.currentTime = 10;
    const plan = {
      candidate: songB,
      sourceSongKey: 'a',
      transitionAtSeconds: 20,
      crossfadeSeconds: 8,
      beatSync: true,
      mixBars: 4,
      tempoRatio: 1,
      tempoOctave: 0,
      sourceRhythm: outRhythm,
      candidateRhythm: inRhythm,
    };
    assert.equal(c.planDjTransition(plan), true);
    await settle();

    outgoing.currentTime = 20;
    outgoing.emit('timeupdate');
    await settle();

    const incoming = c.audio;
    assert.equal(c.retiring, outgoing);
    assert.ok(c.followLoop?.running, 'followLoop should be running');
    assert.equal(timer.registered, true);

    const feedForwardRatio = 1.0;
    const initialOut = outgoing.currentTime;
    const initialIn = incoming.currentTime;

    // Simulate tick: outgoing advances by 0.1s, incoming runs 30 ms ahead (+0.03s) of desired beat
    outgoing.currentTime = initialOut + 0.1;
    incoming.currentTime = initialIn + 0.1 + 0.03;
    timer.tick();

    assert.ok(
      incoming.pitchModifier < feedForwardRatio,
      `expected pitch modifier to slow down (< ${feedForwardRatio}), got ${incoming.pitchModifier}`
    );
    assert.ok(
      feedForwardRatio - incoming.pitchModifier <= MAX_FOLLOW_RATE_STEP + 1e-6,
      `expected rate correction within MAX_FOLLOW_RATE_STEP, got ${feedForwardRatio - incoming.pitchModifier}`
    );
    const slowModifier = incoming.pitchModifier;

    // Simulate tick: incoming lags 30 ms behind (-0.03s) desired beat
    outgoing.currentTime = initialOut + 0.2;
    incoming.currentTime = initialIn + 0.2 - 0.03;
    timer.tick();

    assert.ok(
      incoming.pitchModifier > feedForwardRatio,
      `expected pitch modifier to speed up (> ${feedForwardRatio}), got ${incoming.pitchModifier}`
    );
    assert.ok(
      incoming.pitchModifier - feedForwardRatio <= MAX_FOLLOW_RATE_STEP + 1e-6,
      `expected rate correction within MAX_FOLLOW_RATE_STEP, got ${incoming.pitchModifier - feedForwardRatio}`
    );
    assert.ok(incoming.pitchModifier > slowModifier, 'speed-up must be higher than slow-down');
  }

  // (b) an outgoing list whose tempo ramps makes the requested rate follow it beat by beat
  {
    const timer = createTestTimer();
    const rampOutBeats = [10000, 500, 480, 450, 400, ...Array(27).fill(400)];
    const rampOutRhythm = { ...outRhythm, outroBeats: rampOutBeats };
    const songA = { ...songs[0], djRhythm: rampOutRhythm };
    const songB = { ...songs[1], djRhythm: inRhythm };
    const { c } = fixture(t, { followTimers: timer });
    c.setDjModeEnabled(true);
    c.setQueueAndPlay([songA, songB]);
    await settle();

    const outgoing = c.audio;
    outgoing.currentTime = 5;
    assert.equal(c.planDjTransition({
      candidate: songB,
      sourceSongKey: 'a',
      transitionAtSeconds: 10,
      crossfadeSeconds: 8,
      beatSync: true,
      mixBars: 4,
      tempoRatio: 1,
      tempoOctave: 0,
      sourceRhythm: rampOutRhythm,
      candidateRhythm: inRhythm,
    }), true);
    await settle();

    outgoing.currentTime = 10;
    outgoing.emit('timeupdate');
    await settle();

    const incoming = c.audio;
    assert.ok(c.followLoop?.running);

    outgoing.currentTime = 10.6;
    incoming.currentTime = 0.604167;
    timer.tick();
    const rate1 = incoming.pitchModifier;
    assert.ok(Math.abs(rate1 - 500 / 480) < 1e-4, `expected ~${500 / 480}, got ${rate1}`);

    outgoing.currentTime = 11.1;
    incoming.currentTime = 1.13333;
    timer.tick();
    const rate2 = incoming.pitchModifier;
    assert.ok(Math.abs(rate2 - 500 / 450) < 1e-4, `expected ~${500 / 450}, got ${rate2}`);
    assert.ok(rate2 > rate1, 'requested rate accelerates beat by beat following outgoing tempo ramp');
  }

  // (c) without lists, or with introVirtual over 25 %, no follower loop is started and the pitch modifier stays at the constant ratio
  {
    const timer = createTestTimer();
    const noListsOut = { ...outRhythm, outroBeats: null };
    const noListsIn = { ...inRhythm, introBeats: null };
    const songA = { ...songs[0], djRhythm: noListsOut };
    const songB = { ...songs[1], djRhythm: noListsIn };
    const { c } = fixture(t, { followTimers: timer });
    c.setDjModeEnabled(true);
    c.setQueueAndPlay([songA, songB]);
    await settle();

    const outgoing = c.audio;
    outgoing.currentTime = 10;
    assert.equal(c.planDjTransition({
      candidate: songB,
      sourceSongKey: 'a',
      transitionAtSeconds: 20,
      crossfadeSeconds: 8,
      beatSync: true,
      mixBars: 4,
      tempoRatio: 1,
      tempoOctave: 0,
      sourceRhythm: noListsOut,
      candidateRhythm: noListsIn,
    }), true);
    await settle();

    outgoing.currentTime = 20;
    outgoing.emit('timeupdate');
    await settle();

    assert.equal(c.followLoop, null, 'no follower loop started without beat lists');
    assert.equal(timer.registered, false);
    assert.equal(c.audio.pitchModifier, 1, 'pitch modifier stays at constant ratio');
  }
  {
    const timer = createTestTimer();
    const highVirtualIn = { ...inRhythm, introVirtual: 9 };
    const songA = { ...songs[0], djRhythm: outRhythm };
    const songB = { ...songs[1], djRhythm: highVirtualIn };
    const { c } = fixture(t, { followTimers: timer });
    c.setDjModeEnabled(true);
    c.setQueueAndPlay([songA, songB]);
    await settle();

    const outgoing = c.audio;
    outgoing.currentTime = 10;
    assert.equal(c.planDjTransition({
      candidate: songB,
      sourceSongKey: 'a',
      transitionAtSeconds: 20,
      crossfadeSeconds: 8,
      beatSync: true,
      mixBars: 4,
      tempoRatio: 1,
      tempoOctave: 0,
      sourceRhythm: outRhythm,
      candidateRhythm: highVirtualIn,
    }), true);
    await settle();

    outgoing.currentTime = 20;
    outgoing.emit('timeupdate');
    await settle();

    assert.equal(c.followLoop, null, 'no follower loop started when introVirtual > 25%');
    assert.equal(timer.registered, false);
    assert.equal(c.audio.pitchModifier, 1, 'pitch modifier stays at constant ratio');
  }

  // (d) finishFade stops the follower loop and restores pitch as before
  {
    const timer = createTestTimer();
    const songA = { ...songs[0], djRhythm: outRhythm };
    const songB = { ...songs[1], djRhythm: inRhythm };
    const { c } = fixture(t, { followTimers: timer });
    c.setDjModeEnabled(true);
    c.setQueueAndPlay([songA, songB]);
    await settle();

    const outgoing = c.audio;
    outgoing.currentTime = 10;
    assert.equal(c.planDjTransition({
      candidate: songB,
      sourceSongKey: 'a',
      transitionAtSeconds: 20,
      crossfadeSeconds: 8,
      beatSync: true,
      mixBars: 4,
      tempoRatio: 1,
      tempoOctave: 0,
      sourceRhythm: outRhythm,
      candidateRhythm: inRhythm,
    }), true);
    await settle();

    outgoing.currentTime = 20;
    outgoing.emit('timeupdate');
    await settle();

    assert.ok(c.followLoop?.running);
    assert.equal(timer.registered, true);

    c.finishFade({ glide: false });
    assert.equal(c.followLoop, null, 'followLoop stopped and cleared on finishFade');
    assert.equal(timer.registered, false, 'timer cleared on finishFade');
    assert.equal(c.audio.pitchModifier, 1, 'pitch modifier restored to state setting');
  }

  // (e) a large error (over 0.75 beat) stops following (the loop reports 'lost-lock')
  {
    const timer = createTestTimer();
    const songA = { ...songs[0], djRhythm: outRhythm };
    const songB = { ...songs[1], djRhythm: inRhythm };
    const { c } = fixture(t, { followTimers: timer });
    c.setDjModeEnabled(true);
    c.setQueueAndPlay([songA, songB]);
    await settle();

    const outgoing = c.audio;
    outgoing.currentTime = 10;
    assert.equal(c.planDjTransition({
      candidate: songB,
      sourceSongKey: 'a',
      transitionAtSeconds: 20,
      crossfadeSeconds: 8,
      beatSync: true,
      mixBars: 4,
      tempoRatio: 1,
      tempoOctave: 0,
      sourceRhythm: outRhythm,
      candidateRhythm: inRhythm,
    }), true);
    await settle();

    outgoing.currentTime = 20;
    outgoing.emit('timeupdate');
    await settle();

    const incoming = c.audio;
    assert.ok(c.followLoop?.running);

    const initialOut = outgoing.currentTime;
    const initialIn = incoming.currentTime;
    outgoing.currentTime = initialOut + 0.1;
    incoming.currentTime = initialIn + 0.1 + 0.40;
    timer.tick();

    assert.equal(c.followLoop.running, false, 'loop stopped following after large error');
    assert.equal(c.followLoop.stopReason, 'lost-lock', 'loop reported lost-lock');
    assert.equal(timer.registered, false, 'timer was cleared on lost-lock');
  }

  // (f) setPitchModifier during a mix stops the follower
  {
    const timer = createTestTimer();
    const songA = { ...songs[0], djRhythm: outRhythm };
    const songB = { ...songs[1], djRhythm: inRhythm };
    const { c } = fixture(t, { followTimers: timer });
    c.setDjModeEnabled(true);
    c.setQueueAndPlay([songA, songB]);
    await settle();

    const outgoing = c.audio;
    outgoing.currentTime = 10;
    assert.equal(c.planDjTransition({
      candidate: songB,
      sourceSongKey: 'a',
      transitionAtSeconds: 20,
      crossfadeSeconds: 8,
      beatSync: true,
      mixBars: 4,
      tempoRatio: 1,
      tempoOctave: 0,
      sourceRhythm: outRhythm,
      candidateRhythm: inRhythm,
    }), true);
    await settle();

    outgoing.currentTime = 20;
    outgoing.emit('timeupdate');
    await settle();

    assert.ok(c.followLoop?.running);
    assert.equal(timer.registered, true);

    c.setPitchModifier(1.05);
    assert.equal(c.followLoop, null, 'setPitchModifier stops and clears followLoop');
    assert.equal(timer.registered, false, 'timer cleared on setPitchModifier');
    assert.equal(c.audio.pitchModifier, 1.05);
  }
});


test('the beat follower only starts on lists it can trust and applies the rate the engine really plays', async t => {
  const beats = (first, count = 32) => [first, ...Array(count - 1).fill(500)];
  const rhythm = extra => ({ bpm: 120, firstDownbeat: 10, barBeats: 4, gridCoverage: 0.9, downbeatAgreement: 0.8, rhythmStatus: 'ready', outroStart: 10, outroBars: 8,
    introBars: 8, startBpm: 120, beatListVersion: 1, outroVirtual: 0, introVirtual: 0, outroBeats: beats(10000), introBeats: beats(0), ...extra });
  const start = async ({ source = {}, incomingRhythm = {}, outRate = 1, incomingRpm = 45 } = {}) => {
    const timer = createTestTimer();
    const outRhythm = rhythm(source);
    const inRhythm = rhythm(incomingRhythm);
    const { c } = fixture(t, { followTimers: timer });
    c.setDjModeEnabled(true);
    c.setQueueAndPlay([{ ...songs[0], djRhythm: outRhythm }, { ...songs[1], djRhythm: inRhythm }]);
    await settle();
    const outgoing = c.audio;
    outgoing.currentTime = 10;
    outgoing.targetMotorRate = outRate;
    assert.equal(c.planDjTransition({ candidate: { ...songs[1], djRhythm: inRhythm }, sourceSongKey: 'a', transitionAtSeconds: 20, crossfadeSeconds: 8, beatSync: true, mixBars: 4,
      tempoRatio: 1, tempoOctave: 0, sourceRhythm: outRhythm, candidateRhythm: inRhythm }), true);
    await settle();
    outgoing.currentTime = 20;
    outgoing.emit('timeupdate');
    await settle();
    const incoming = c.audio;
    incoming.setRpm(incomingRpm);
    return { c, timer, outgoing, incoming };
  };

  assert.equal((await start()).c.followLoop?.running, true, 'trusted lists start a follower');
  assert.equal((await start({ source: { outroVirtual: 16 } })).c.followLoop, null, 'half the outgoing list guessed');
  assert.equal((await start({ incomingRhythm: { introVirtual: 16 } })).c.followLoop, null, 'half the incoming list guessed');
  assert.equal((await start({ source: { beatListVersion: 2 } })).c.followLoop, null, 'unknown outgoing list version');
  assert.equal((await start({ incomingRhythm: { beatListVersion: 2 } })).c.followLoop, null, 'unknown incoming list version');
  assert.equal((await start({ source: { outroBeats: beats(30000) } })).c.followLoop, null, 'lock far before the outgoing list begins');

  for (const [outRate, incomingRpm] of [[1.05, 45], [1, 100 / 3]]) {
    const { timer, outgoing, incoming } = await start({ outRate, incomingRpm });
    const outAt = outgoing.currentTime;
    const inAt = incoming.currentTime;
    outgoing.currentTime = outAt + 0.1 * outRate;
    incoming.currentTime = inAt + 0.1 * outRate;
    timer.tick();
    assert.ok(Math.abs(incoming.targetMotorRate - outRate) < 1e-6, `engine rate ${incoming.targetMotorRate} should equal the outgoing rate ${outRate} when on the beat (rpm ${incomingRpm})`);
  }
});
