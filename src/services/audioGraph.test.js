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
  setTargetAtTime(value, time, constant) { this.value = value; this.calls.push(['target', value, constant]); }
  cancelScheduledValues() {}
  linearRampToValueAtTime(value) { this.value = value; }
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

test('the signal path is source, preamp, ten EQ bands, volume, fade, limiter, analyser, output', t => {
  const graph = withGraph(t);
  const chain = chainFrom(graph.sourceNode);
  assert.deepEqual(chain.map(node => node.kind), ['source', 'gain', ...Array(10).fill('filter'), 'gain', 'gain', 'shaper', 'analyser', 'destination']);
  assert.equal(chain[1], graph.preampNode);
  assert.deepEqual(graph.filterNodes.map(node => node.type), ['lowshelf', ...Array(8).fill('peaking'), 'highshelf']);
  assert.deepEqual(graph.filterNodes.map(node => node.frequency.value), EQ_FREQUENCIES);
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

test('detaching disconnects every node', t => {
  const graph = withGraph(t);
  const nodes = [graph.sourceNode, graph.preampNode, graph.limiterNode, graph.analyserNode, ...graph.filterNodes];
  graph.detachAudioElement();
  assert.ok(nodes.every(node => node.disconnected));
  assert.equal(graph.sourceNode, null);
  assert.equal(graph.filterNodes.length, 0);
});
