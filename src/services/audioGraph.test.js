import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioGraphManager, EQ_FREQUENCIES, EQ_PRESETS } from './audioGraph.js';

test('the equalizer has ten octave bands and every preset stays within +-12 dB', () => {
  assert.deepEqual(EQ_FREQUENCIES, [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);
  for (const [key, preset] of Object.entries(EQ_PRESETS)) {
    assert.equal(typeof preset.name, 'string', `${key} has a name`);
    assert.equal(preset.gains.length, EQ_FREQUENCIES.length, `${key} has one gain per band`);
    assert.ok(preset.gains.every(gain => gain >= -12 && gain <= 12), `${key} within +-12 dB`);
  }
});

class FakeParam {
  constructor(value = 0) { this.value = value; this.calls = []; }
  setValueAtTime(value) { this.value = value; this.calls.push(['set', value]); }
  setValueCurveAtTime(curve, time, duration) { this.value = curve.at(-1); this.calls.push(['curve', curve, duration]); }
  setTargetAtTime(value, time, constant) { this.value = value; this.calls.push(['target', value, constant]); }
  cancelScheduledValues() {}
  linearRampToValueAtTime(value) { this.value = value; this.calls.push(['ramp', value]); }
  get last() { return this.calls.at(-1); }
}
class FakeNode {
  constructor(kind) { this.kind = kind; this.outputs = []; this.gain = new FakeParam(1); this.frequency = new FakeParam(); this.Q = new FakeParam(); this.disconnected = false; }
  connect(node) { this.outputs.push(node); return node; }
  disconnect() { this.outputs = []; this.disconnected = true; }
}
class FakeContext {
  constructor() { this.currentTime = 0; this.sampleRate = 48000; this.state = 'running'; this.destination = new FakeNode('destination'); }
  createMediaElementSource() { return new FakeNode('source'); }
  createGain() { return new FakeNode('gain'); }
  createBiquadFilter() { return new FakeNode('filter'); }
  createWaveShaper() { return new FakeNode('shaper'); }
  createAnalyser() { return Object.assign(new FakeNode('analyser'), { fftSize: 0, smoothingTimeConstant: 0, frequencyBinCount: 64 }); }
  close() { return Promise.resolve(); }
}

function withGraph(t) {
  const previous = globalThis.window;
  globalThis.window = { AudioContext: FakeContext };
  t.after(() => { globalThis.window = previous; if (previous === undefined) delete globalThis.window; });
  const graph = new AudioGraphManager();
  graph.attachAudioElement({});
  return graph;
}

function chainFrom(node) {
  const chain = [node];
  while (chain.at(-1).outputs.length) chain.push(chain.at(-1).outputs[0]);
  return chain;
}

test('the signal path is source, preamp, ten EQ bands, volume, fade, bass shelf, limiter, analyser, output', t => {
  const graph = withGraph(t);
  const chain = chainFrom(graph.sourceNode);
  assert.deepEqual(chain.map(node => node.kind), ['source', 'gain', ...Array(10).fill('filter'), 'gain', 'gain', 'filter', 'shaper', 'analyser', 'destination']);
  assert.equal(chain[1], graph.preampNode);
  assert.deepEqual(graph.filterNodes.map(node => node.type), ['lowshelf', ...Array(8).fill('peaking'), 'highshelf']);
  assert.deepEqual(graph.filterNodes.map(node => node.frequency.value), EQ_FREQUENCIES);
  assert.equal(graph.bassNode.type, 'lowshelf');
  assert.equal(graph.bassNode.gain.value, 0, 'the DJ bass shelf is flat unless a mix is running');
  assert.equal(graph.limiterNode.oversample, 'none');
  assert.ok(graph.limiterNode.curve instanceof Float32Array && graph.limiterNode.curve.length > 1000);
});

test('slider moves glide instead of stepping, so dragging does not click', t => {
  const graph = withGraph(t);
  graph.setBandGain(5, 6);
  const [kind, value, constant] = graph.filterNodes[5].gain.last;
  assert.equal(kind, 'target');
  assert.equal(value, 6);
  assert.ok(constant > 0 && constant < 0.1);
  assert.equal(graph.currentPreset, 'custom');
  graph.setBandGain(5, 99);
  assert.equal(graph.currentGains[5], 12, 'clamped');
  graph.setBandGain(99, 3);
  assert.equal(graph.currentGains.length, 10, 'an out-of-range band is ignored');
});

test('boosting turns the preamp down by the strongest boost; cuts and flat leave it at unity', t => {
  const graph = withGraph(t);
  assert.equal(graph.preampNode.gain.value, 1);
  graph.applyPreset('bass_boost');
  const cutDb = graph.headroomDb;
  assert.ok(cutDb < -5, `bass boost needs real headroom, got ${cutDb}`);
  assert.ok(Math.abs(graph.preampNode.gain.value - (10 ** (cutDb / 20))) < 1e-9);
  assert.ok(graph.preampNode.gain.value < 0.6);

  graph.setGains(EQ_FREQUENCIES.map(() => -6));
  assert.equal(graph.preampNode.gain.value, 1, 'cuts never need headroom');
  graph.applyPreset('flat');
  assert.equal(graph.preampNode.gain.value, 1);
});

test('bypass silences the EQ without losing the settings, and restores them', t => {
  const graph = withGraph(t);
  graph.applyPreset('electronic');
  const saved = [...graph.currentGains];
  graph.setEnabled(false);
  assert.ok(graph.filterNodes.every(node => node.gain.value === 0));
  assert.equal(graph.preampNode.gain.value, 1);
  assert.deepEqual(graph.currentGains, saved, 'settings are kept while bypassed');
  graph.setBandGain(0, 3);
  assert.ok(graph.filterNodes.every(node => node.gain.value === 0), 'still bypassed after an edit');
  graph.setEnabled(true);
  assert.deepEqual(graph.filterNodes.map(node => node.gain.value), graph.currentGains);
  assert.ok(graph.preampNode.gain.value < 1);
});

test('settings chosen before audio starts are applied when the graph is created', t => {
  const previous = globalThis.window;
  globalThis.window = { AudioContext: FakeContext };
  t.after(() => { globalThis.window = previous; if (previous === undefined) delete globalThis.window; });
  const graph = new AudioGraphManager();
  graph.applyPreset('vocal');
  graph.setEnabled(true);
  graph.attachAudioElement({});
  assert.deepEqual(graph.filterNodes.map(node => node.gain.value), EQ_PRESETS.vocal.gains);
  assert.ok(graph.preampNode.gain.value < 1);

  const bypassed = new AudioGraphManager();
  bypassed.applyPreset('vocal');
  bypassed.setEnabled(false);
  bypassed.attachAudioElement({});
  assert.ok(bypassed.filterNodes.every(node => node.gain.value === 0));
  assert.equal(bypassed.preampNode.gain.value, 1);
});

test('DJ fades use equal-power curves, keeping combined power constant, and only from the expected start', t => {
  const graph = withGraph(t);
  graph.setFade(0);
  graph.setFade(1, 8, { curve: 'equal-power' });
  const [kind, curve, duration] = graph.fadeGainNode.gain.last;
  assert.equal(kind, 'curve');
  assert.equal(duration, 8);
  assert.ok(curve[0] < 1e-6 && Math.abs(curve.at(-1) - 1) < 1e-6);
  const midpoint = curve.length >> 1;
  assert.ok(curve[midpoint] > 0.70 && curve[midpoint] < 0.72, 'a fade-in is at -3 dB, not -6 dB, halfway');

  graph.setFade(1);
  graph.setFade(0, 8, { curve: 'equal-power' });
  assert.equal(graph.fadeGainNode.gain.last[0], 'curve');
  assert.ok(Math.abs(graph.fadeGainNode.gain.last[1][0] - 1) < 1e-6, 'a fade-out starts at full gain');

  graph.setFade(0.4);
  graph.setFade(1, 8, { curve: 'equal-power' });
  assert.equal(graph.fadeGainNode.gain.last[0], 'ramp', 'from an unexpected start it falls back to a linear ramp rather than jump');
  graph.setFade(1);
  graph.setFade(0, 4);
  assert.equal(graph.fadeGainNode.gain.last[0], 'ramp', 'the default remains linear');
});

test('a fade requested right after another starts from the requested level, not a stale AudioParam read', t => {
  const graph = withGraph(t);
  // A real AudioParam reports its old value until the next render quantum; simulate that.
  Object.defineProperty(graph.fadeGainNode.gain, 'value', { get: () => 1, set: () => {}, configurable: true });
  graph.setFade(0);
  graph.setFade(1, 8, { curve: 'equal-power' });
  assert.equal(graph.fadeGainNode.gain.last[0], 'curve', 'the fade-in used the equal-power curve, so it started from 0');
  assert.ok(graph.fadeGainNode.gain.calls.some(([kind, value]) => kind === 'set' && value === 0), 'and the gain was actually set to 0 first');
  graph.setFade(1);
  graph.setFade(0, 8, { curve: 'equal-power' });
  assert.equal(graph.fadeGainNode.gain.last[0], 'curve');
});

test('the bass shelf can be cut, restored and set before the graph exists', t => {
  const graph = withGraph(t);
  graph.setBassCut(-24, 2);
  assert.equal(graph.bassNode.gain.last[0], 'ramp');
  assert.equal(graph.bassNode.gain.value, -24);
  graph.setBassCut(-99);
  assert.equal(graph.bassNode.gain.value, -36, 'clamped');
  graph.setBassCut(0, 1);
  assert.equal(graph.bassNode.gain.value, 0);

  const previous = globalThis.window;
  globalThis.window = { AudioContext: FakeContext };
  t.after(() => { globalThis.window = previous; if (previous === undefined) delete globalThis.window; });
  const early = new AudioGraphManager();
  early.setBassCut(-18);
  early.attachAudioElement({});
  assert.equal(early.bassNode.gain.value, -18, 'a pending cut is applied when the graph is created');
});

test('detaching disconnects every node', t => {
  const graph = withGraph(t);
  const nodes = [graph.sourceNode, graph.preampNode, graph.limiterNode, graph.analyserNode, graph.bassNode, ...graph.filterNodes];
  graph.detachAudioElement();
  assert.ok(nodes.every(node => node.disconnected));
  assert.equal(graph.sourceNode, null);
  assert.equal(graph.filterNodes.length, 0);
});
