import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackController, QUEUE_STORAGE_KEY } from './PlaybackController.js';

const songs = ['a', 'b', 'c', 'd'].map(songKey => ({ songKey, track: songKey, artist: 'Artist', driveFileId: songKey }));
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

class FakeAudio {
  constructor() {
    this.listeners = new Map(); this.duration = 0; this.currentTime = 0; this.paused = true; this.src = ''; this.error = null;
    this.currentGains = [0, 0, 0, 0, 0]; this.fades = []; this.targetMotorRate = 1;
    this.element = { readyState: 4, seeking: false, buffered: { length: 0 } };
  }
  addEventListener(type, cb) { const listeners = this.listeners.get(type) || []; listeners.push(cb); this.listeners.set(type, listeners); }
  emit(type, detail = {}) { for (const cb of this.listeners.get(type) || []) cb({ type, ...detail }); }
  async loadUrl(url) { this.src = url; this.duration = 100; this.currentTime = 0; this.emit('durationchange'); }
  getAttribute() { return this.src; }
  async play() { if (this.playGate) await this.playGate.promise; this.paused = false; this.emit('play'); }
  pause() { this.paused = true; this.emit('pause'); }
  clear() { this.src = ''; this.duration = 0; this.currentTime = 0; this.paused = true; this.emit('timeupdate'); }
  seek(value) { this.currentTime = value; this.emit('timeupdate'); }
  setVolume(value) { this.volume = value; }
  setRpm() {} setPitchModifier() {} applyPreset() {} setBandGain() {}
  ensureContext() { return {}; } setFade(value, seconds) { this.fades.push([value, seconds]); return true; }
  handleVisibilityChange() {} beginScratch() {} endScratch() {} setNeedleLifted() {}
  dispose() { this.clear(); this.disposed = true; }
}
function fixture(t, options = {}) {
  const entries = new Map();
  const storage = { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value) };
  const controller = new PlaybackController({ resolveUrl: async song => song.driveFileId, createAudio: () => new FakeAudio(), storage, ...options });
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
