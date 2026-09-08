import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exponentialInertiaVelocity,
  playbackRateFromAngularVelocity,
  vinylBrakeRateAtTime,
} from './VinylAudioEngine.js';

test('varispeed uses signed angular velocity relative to platter speed', () => {
  const nominal = (45 * 2 * Math.PI) / 60;
  assert.equal(playbackRateFromAngularVelocity(nominal, nominal), 1);
  assert.equal(playbackRateFromAngularVelocity(-nominal, nominal), -1);
  assert.equal(playbackRateFromAngularVelocity(nominal * 0.5, nominal, 1.08), 0.54);
  assert.equal(playbackRateFromAngularVelocity(nominal * 20, nominal), 8);
});

test('release inertia exponentially settles at motor speed', () => {
  const initial = -3.4;
  const target = 1;
  assert.ok(Math.abs(exponentialInertiaVelocity(initial, target, 0) - initial) < 1e-9);
  assert.ok(Math.abs(exponentialInertiaVelocity(initial, target, 190) - target) < Math.abs(initial - target));
  assert.ok(Math.abs(exponentialInertiaVelocity(initial, target, 2000) - target) < 0.001);
});

test('physical brake exponentially brings the record to rest', () => {
  assert.equal(vinylBrakeRateAtTime(1, 0), 1);
  assert.ok(vinylBrakeRateAtTime(1, 160) < 0.4);
  assert.ok(vinylBrakeRateAtTime(1, 640) < 0.02);
});

import { VinylAudioEngine } from './VinylAudioEngine.js';

class NativeAudio extends EventTarget {
  constructor() { super(); this.readyState = 0; this.currentTime = 0; this.duration = 100; this.src = ''; this.paused = true; this.playbackRate = 1; }
  load() { this.readyState = 0; }
  removeAttribute() { this.src = ''; }
  getAttribute() { return this.src; }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  async play() { if (this.gate) await this.gate; this.paused = false; this.dispatchEvent(new Event('play')); }
  ready() { this.readyState = 4; this.dispatchEvent(new Event('loadedmetadata')); }
}
function nativeFixture(t) {
  const previous = globalThis.Audio;
  globalThis.Audio = NativeAudio;
  const engine = new VinylAudioEngine();
  t.after(() => { engine.dispose(); globalThis.Audio = previous; });
  return engine;
}

test('replaced native loads reject immediately and remove readiness listeners', async t => {
  const engine = nativeFixture(t);
  const first = engine.loadUrl('a');
  const rejected = assert.rejects(first, { name: 'AbortError' });
  const second = engine.loadUrl('b'); engine.element.ready(); await second; await rejected;
  assert.equal(engine.src, 'b'); assert.equal(engine.pendingLoadCancel, null);
});

test('clear cancels an unresolved native load without waiting for its timeout', async t => {
  const engine = nativeFixture(t); const loading = engine.loadUrl('a');
  const rejected = assert.rejects(loading, { name: 'AbortError' }); engine.clear(); await rejected;
  assert.equal(engine.src, ''); assert.equal(engine.pendingLoadCancel, null);
});

test('seek before metadata is retained and applied when metadata arrives', async t => {
  const engine = nativeFixture(t); const loading = engine.loadUrl('a'); engine.seek(42); engine.element.ready(); await loading;
  assert.equal(engine.currentTime, 42); assert.equal(engine.pendingSeek, null);
});

test('late native play promise cannot restart playback after pause', async t => {
  const engine = nativeFixture(t); const loading = engine.loadUrl('a'); engine.element.ready(); await loading;
  let release; engine.element.gate = new Promise(resolve => { release = resolve; });
  const playing = engine.play(); const rejected = assert.rejects(playing, { name: 'AbortError' });
  engine.pause(); release(); await rejected;
  assert.equal(engine.isPlaying, false); assert.equal(engine.element.paused, true);
});

test('ordinary playback stays native and pause completes immediately while backgrounded', async t => {
  const engine = nativeFixture(t); const loading = engine.loadUrl('a'); engine.element.ready(); await loading;
  await engine.play(); assert.equal(engine.graph.audioContext, null);
  engine.pause(); engine.handleVisibilityChange(true);
  assert.equal(engine.element.paused, true); assert.equal(engine.timeUpdateTimer, null);
});
