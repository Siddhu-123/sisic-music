import test from 'node:test';
import assert from 'node:assert/strict';
import { greedyPath, improve2opt, nextFlowPick, orderForFlow, transitionCost, vectorNeighbours } from './flowPath.js';

const item = (id, vector, extra = {}) => ({ id, vector, ...extra });
const totalCost = (order, items, opts) => {
  const byId = new Map(items.map(entry => [entry.id, entry]));
  return order.slice(1).reduce((sum, id, index) => sum + transitionCost(byId.get(order[index]), byId.get(id), opts), 0);
};

test('greedy path starts at startId and follows the obvious nearest vector order', () => {
  const items = [item('a', [1, 0]), item('b', [0.8, 0.6]), item('c', [0, 1])];
  assert.deepEqual(greedyPath(items, { startId: 'a', opts: { wTempo: 0, wKey: 0, wEnergy: 0 } }), ['a', 'b', 'c']);
  assert.deepEqual(orderForFlow(items, { startId: 'a', wTempo: 0, wKey: 0, wEnergy: 0 }).order, ['a', 'b', 'c']);
});

test('2-opt preserves an obvious best open path and never raises greedy cost', () => {
  const items = [item('a', [1, 0]), item('b', [0, 1]), item('c', [-1, 0]), item('d', [0, -1])];
  const opts = { wTempo: 0, wKey: 0, wEnergy: 0 };
  const greedy = greedyPath(items, { startId: 'a', opts });
  const improved = improve2opt(greedy, items, { opts, maxIterations: 20 });
  assert.deepEqual(improved, ['a', 'b', 'c', 'd']);
  assert.ok(totalCost(improved, items, opts) <= totalCost(greedy, items, opts));
});

test('tempo accepts half or double time and Camelot neighbours have low key cost', () => {
  const a = item('a', [1], { bpm: 70, key: '8A' });
  const halfTime = item('b', [1], { bpm: 140, key: '8A' });
  const adjacent = item('c', [1], { bpm: 70, key: '9A' });
  const relative = item('d', [1], { bpm: 140, key: '8B' });
  assert.equal(transitionCost(a, halfTime, { wSim: 0, wKey: 0, wEnergy: 0 }), 0);
  assert.equal(transitionCost(a, adjacent, { wSim: 0, wTempo: 0, wEnergy: 0 }), 0.05);
  assert.equal(transitionCost(a, relative, { wSim: 0, wTempo: 0, wEnergy: 0 }), 0.05);
});

test('missing transition metadata adds bounded uncertainty costs, disabled weights stay exact zero', () => {
  const a = item('a', [1], {});
  const b = item('b', [1], { bpm: null, key: null, energy: null });
  assert.equal(transitionCost(a, b, { wSim: 0 }), (0.35 * 0.3) + (0.35 * 0.2) + (0.25 * 0.15));
  assert.equal(transitionCost(a, b, { wSim: 0, wTempo: 0, wKey: 0, wEnergy: 0 }), 0);
});

test('nextFlowPick avoids recent ids and accepts object history entries', () => {
  const current = item('current', [1, 0]);
  const recent = item('recent', [1, 0]);
  const next = item('next', [0.9, 0.1]);
  assert.equal(nextFlowPick(current, [recent, next], { history: [{ id: 'recent' }], rng: () => 0 }), next);
  assert.equal(nextFlowPick(current, [recent, next], { history: ['recent', 'next'], rng: () => 0 }), recent);
});

test('3,000 random items are ordered within five seconds', () => {
  let seed = 7321;
  const random = () => {
    seed = ((seed * 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const count = 3000;
  const items = Array.from({ length: count }, (_, id) => {
    const vector = Array.from({ length: 8 }, () => (random() * 2) - 1);
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + (value * value), 0));
    return item(id, vector.map(value => value / magnitude));
  });
  const started = Date.now();
  const result = orderForFlow(items, { maxIterations: 8, timeBudgetMs: 3000 });
  assert.equal(result.order.length, count);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started}ms`);
});

test('approximate neighbours retain clustered exact neighbours at 3,000 items', () => {
  let seed = 9173;
  const random = () => {
    seed = ((seed * 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const count = 3000;
  const dimensions = 16;
  const centers = Array.from({ length: 24 }, () => {
    const vector = Array.from({ length: dimensions }, () => (random() * 2) - 1);
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return vector.map(value => value / norm);
  });
  const items = Array.from({ length: count }, (_, id) => {
    const center = centers[Math.floor(id / (count / centers.length))];
    const vector = center.map(value => value + ((random() * 0.12) - 0.06));
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return item(id, vector.map(value => value / norm));
  });
  const neighbours = vectorNeighbours(items, 10);
  let matched = 0;
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    const exact = items.map((entry, j) => ({ j, dot: i === j ? -Infinity : items[i].vector.reduce((sum, value, d) => sum + value * entry.vector[d], 0) }))
      .sort((a, b) => b.dot - a.dot || a.j - b.j).slice(0, 10);
    const approximate = new Set(neighbours[i]);
    for (const entry of exact) {
      total += 1;
      if (approximate.has(entry.j)) matched += 1;
    }
  }
  assert.ok(matched / total >= 0.6, `recall was ${(matched / total).toFixed(3)}`);
});

test('6,000 256-dimensional items order within three seconds and improve random cost', () => {
  let seed = 38129;
  const random = () => {
    seed = ((seed * 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const normalize = values => {
    const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
    return values.map(value => value / norm);
  };
  const count = 6000;
  const dimensions = 256;
  const centers = Array.from({ length: 48 }, () => normalize(Array.from({ length: dimensions }, () => (random() * 2) - 1)));
  const items = Array.from({ length: count }, (_, id) => {
    const center = centers[id % centers.length];
    const vector = normalize(center.map(value => value + ((random() * 0.2) - 0.1)));
    return item(id, vector, {
      start: normalize(vector.slice(0, 128).map(value => value + ((random() * 0.03) - 0.015))),
      end: normalize(vector.slice(128).concat(vector.slice(0, 64)).map(value => value + ((random() * 0.03) - 0.015))),
      bpm: 80 + (random() * 80),
      key: `${1 + Math.floor(random() * 12)}${random() < 0.5 ? 'A' : 'B'}`,
      energy: random(),
    });
  });
  const shuffled = [...items].sort((a, b) => (a.id * 48271 % 2147483647) - (b.id * 48271 % 2147483647)).map(entry => entry.id);
  const randomCost = totalCost(shuffled, items);
  const started = Date.now();
  const result = orderForFlow(items);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3000, `took ${elapsed}ms`);
  assert.equal(result.order.length, count);
  assert.equal(new Set(result.order).size, count);
  assert.ok(result.totalCost < randomCost, `${result.totalCost} was not below ${randomCost}`);
});
