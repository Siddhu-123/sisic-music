import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInterests, dot, interestAffinity, unit } from './tasteInterests.js';

const DIMS = 24;
function axis(index, noiseSeed = 0) {
  const vector = new Array(DIMS).fill(0);
  vector[index] = 1;
  // Small deterministic jitter so members of a group are similar, not identical.
  for (let d = 0; d < DIMS; d++) vector[d] += (Math.sin((d + 1) * (noiseSeed + 1.7)) * 0.04);
  return unit(vector);
}
const blend = (a, b) => unit(a.map((value, i) => value + b[i]));

test('a listener with two separate tastes gets two interests; one broad taste stays one', () => {
  const metal = Array.from({ length: 12 }, (_, i) => ({ vector: axis(0, i), weight: 1 }));
  const jazz = Array.from({ length: 8 }, (_, i) => ({ vector: axis(1, i + 20), weight: 1 }));
  const two = buildInterests([...metal, ...jazz]);
  assert.equal(two.length, 2);
  assert.ok(Math.abs(two[0].weight - 0.6) < 1e-9 && Math.abs(two[1].weight - 0.4) < 1e-9);
  assert.ok(dot(two[0].vector, axis(0)) > 0.95 && dot(two[1].vector, axis(1)) > 0.95);

  const one = buildInterests(Array.from({ length: 20 }, (_, i) => ({ vector: axis(0, i), weight: 1 })));
  assert.equal(one.length, 1);
  assert.equal(one[0].size, 20);
});

test('a tiny stray taste is not promoted to an interest', () => {
  const main = Array.from({ length: 30 }, (_, i) => ({ vector: axis(0, i), weight: 1 }));
  const stray = [{ vector: axis(5, 99), weight: 1 }];
  assert.equal(buildInterests([...main, ...stray]).length, 1);
});

test('interests are deterministic and ignore invalid items', () => {
  const items = [
    ...Array.from({ length: 6 }, (_, i) => ({ vector: axis(0, i), weight: 1 })),
    ...Array.from({ length: 6 }, (_, i) => ({ vector: axis(2, i), weight: 1 })),
    { vector: [NaN, 1], weight: 1 }, { vector: axis(3), weight: 0 }, { vector: null, weight: 1 },
  ];
  assert.deepEqual(buildInterests(items), buildInterests(items));
  assert.equal(buildInterests(items).length, 2);
  assert.deepEqual(buildInterests([]), []);
});

test('interest scoring beats a single centroid when tastes are far apart (the bridge failure)', () => {
  // Listener plays "A" and "B". Song D sits between them but is a genre they never play.
  const A = axis(0);
  const B = axis(1);
  const D = blend(A, B);
  const listened = [
    ...Array.from({ length: 10 }, (_, i) => ({ vector: axis(0, i), weight: 1 })),
    ...Array.from({ length: 10 }, (_, i) => ({ vector: axis(1, i + 30), weight: 1 })),
  ];
  const centroid = unit(listened.reduce((sum, item) => sum.map((value, i) => value + item.vector[i]), new Array(DIMS).fill(0)));
  const interests = buildInterests(listened);
  assert.equal(interests.length, 2);

  const candidates = { newA: axis(0, 71), newB: axis(1, 72), bridge: D };
  const byCentroid = Object.entries(candidates).sort((x, y) => dot(centroid, y[1]) - dot(centroid, x[1])).map(([name]) => name);
  const byInterests = Object.entries(candidates).sort((x, y) => interestAffinity(y[1], interests) - interestAffinity(x[1], interests)).map(([name]) => name);

  assert.equal(byCentroid[0], 'bridge', 'centroid wrongly prefers the in-between song');
  assert.equal(byInterests.at(-1), 'bridge', 'interests rank the in-between song last');
  assert.ok(byInterests.slice(0, 2).every(name => name !== 'bridge'));
});

test('interestAffinity never rewards a poor match for belonging to a small interest', () => {
  const interests = [{ vector: axis(0), weight: 0.9 }, { vector: axis(1), weight: 0.1 }];
  // Negative to both interests: the score must be the raw (undiscounted) closest cosine.
  const against = unit(axis(0).map((value, i) => -(value + axis(1)[i])));
  const rawBest = Math.max(dot(against, interests[0].vector), dot(against, interests[1].vector));
  assert.ok(rawBest < 0);
  assert.ok(Math.abs(interestAffinity(against, interests) - rawBest) < 1e-12);
  // Positive fits are discounted only mildly (at most 20%) for the smaller interest.
  const small = interests[1].vector;
  assert.ok(interestAffinity(small, interests) >= 0.8 * dot(small, small) - 1e-9);
  assert.equal(interestAffinity(axis(0), []), null);
});
