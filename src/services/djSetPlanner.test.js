import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { planSet } from './djSetPlanner.js';

const PENALTY_NAMES = new Set(['sameArtist', 'tempoStep', 'keyDistance', 'energyJump']);

const CAMELOT = [];
for (let n = 1; n <= 12; n += 1) CAMELOT.push(`${n}A`, `${n}B`);

const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

function mulberry32(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round2 = (x) => Math.round(x * 100) / 100;

function song(id, artist, tempo, camelot, energy, taste = 0.5) {
  return { id, artist, tempo, camelot, energy, taste };
}

function startSong(over = {}) {
  return { id: 'start-song', artist: 'Root Artist', tempo: 128, camelot: '8A', energy: 0.5, taste: 0.5, ...over };
}

// Fully populated, uniquely identified songs: no candidate is ever "malformed" here,
// so min(count, candidates) is unambiguous.
function makeLibrary(n, seed = 20260101) {
  const rnd = mulberry32(seed);
  return range(n).map((i) => song(
    `song-${i}`,
    `artist-${i % 6}`,
    90 + Math.floor(rnd() * 60),
    CAMELOT[Math.floor(rnd() * CAMELOT.length)],
    round2(0.25 + rnd() * 0.5),
  ));
}

// Mutating a frozen object throws in ES module strict mode, so deep-freezing is
// the mutation detector: a planner that sorts/splices in place fails the test.
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function assertReason(reason) {
  assert.ok(reason && typeof reason === 'object', 'reason must be an object');
  for (const key of ['stepPct', 'keyDistance']) {
    if (reason[key] === null) continue; // unknown tempo or key
    assert.ok(Number.isFinite(reason[key]) && reason[key] >= 0, `${key} must be a finite non-negative number or null`);
  }
  if (reason.energyDelta !== null && reason.energyDelta !== undefined) {
    assert.ok(Number.isFinite(reason.energyDelta), 'energyDelta must be finite when present');
    assert.ok(Math.abs(reason.energyDelta) <= 1, 'energyDelta must stay inside the 0..1 energy range');
  }
  if (reason.pair !== null && reason.pair !== undefined) {
    assert.equal(typeof reason.pair, 'number', 'pair must be a number when present');
    assert.ok(reason.pair >= 0 && reason.pair <= 1, 'pair must be within 0..1');
  }
  assert.ok(Array.isArray(reason.penalties), 'penalties must be an array');
  for (const name of reason.penalties) {
    assert.ok(PENALTY_NAMES.has(name), `unknown penalty name: ${String(name)}`);
  }
}

// Accepts null as a legal answer; anything else must be a well formed plan.
function assertNullOrPlan(plan, { startId = undefined, count = Infinity, allowedIds = null } = {}) {
  if (plan === null) return false;
  assert.ok(plan && typeof plan === 'object', 'plan must be an object or null');
  assert.equal(typeof plan.arc, 'string', 'arc must be a string');
  assert.equal(typeof plan.score, 'number', 'score must be a number');
  assert.ok(Number.isFinite(plan.score), 'score must be finite');
  assert.ok(Array.isArray(plan.items), 'items must be an array');
  assert.ok(plan.items.length <= count, `got ${plan.items.length} items for count ${count}`);
  const seen = new Set();
  for (const item of plan.items) {
    assert.ok(item && typeof item === 'object', 'item must be an object');
    assert.equal(typeof item.id, 'string', 'item.id must be a string');
    assert.ok(item.id.length > 0, 'item.id must not be empty');
    if (startId !== undefined) assert.notEqual(item.id, startId, 'start song leaked into the plan');
    assert.ok(!seen.has(item.id), `duplicate id in plan: ${item.id}`);
    seen.add(item.id);
    if (allowedIds) assert.ok(allowedIds.has(item.id), `unexpected id in plan: ${item.id}`);
    assertReason(item.reason);
  }
  return true;
}

function assertPlan(plan, options) {
  assert.notEqual(plan, null, 'expected a plan but got null');
  assertNullOrPlan(plan, options);
  return plan;
}

function firstIds(seeds, run) {
  return seeds.map((seed) => {
    const plan = assertPlan(run(seed), { count: Infinity });
    assert.ok(plan.items.length > 0, `expected at least one item for seed ${seed}`);
    return plan.items[0].id;
  });
}

function winRate(ids, wanted, seeds) {
  const wins = ids.filter((id) => id === wanted).length;
  assert.ok(
    wins / ids.length >= 0.45,
    `expected ${wanted} first in >= 45% of runs, got ${wins}/${ids.length} (seeds ${seeds[0]}..${seeds[seeds.length - 1]})`,
  );
  return wins;
}

describe('planSet contract', () => {
  test('returns null when count is below one', () => {
    const candidates = makeLibrary(5, 3);
    const start = startSong();
    for (const count of [0, -1, -100]) {
      assert.equal(planSet({ candidates, start, count, seed: 1 }), null, `count=${count}`);
    }
  });

  test('defaults to four items when count is omitted', () => {
    const plan = assertPlan(planSet({ candidates: makeLibrary(9, 4), start: startSong(), seed: 3 }), { count: 4 });
    assert.equal(plan.items.length, 4);
  });

  test('returns null for a malformed start song', () => {
    const candidates = makeLibrary(5, 5);
    const bad = [null, undefined, 42, 'start-song', [], {}, { id: 7 }, { id: null, artist: 'A' }];
    for (const start of bad) {
      assert.equal(planSet({ candidates, start, seed: 1 }), null, `start=${JSON.stringify(start) ?? String(start)}`);
    }
  });

  test('returns null when no candidate is usable', () => {
    const unusable = [null, undefined, 0, 1, 'x', [], {}, { artist: 'A', tempo: 120 }, { id: null, artist: 'A' }];
    assert.equal(planSet({ candidates: unusable, start: startSong(), seed: 1 }), null);
    assert.equal(planSet({ candidates: [], start: startSong(), seed: 1 }), null);
    assert.equal(planSet({ candidates: null, start: startSong(), seed: 1 }), null);
    assert.equal(planSet({ start: startSong(), seed: 1 }), null);
  });

  test('missing or empty options resolve to null or a clear TypeError', () => {
    for (const options of [undefined, null, {}, { candidates: [] }]) {
      let plan;
      try {
        plan = planSet(options);
      } catch (error) {
        assert.ok(error instanceof TypeError, `expected a TypeError, got ${error}`);
        continue;
      }
      assert.equal(plan, null);
    }
  });

  test('plans when the start song has null tempo fields', () => {
    const start = startSong({ tempo: null, camelot: null, energy: null });
    const plan = planSet({ candidates: makeLibrary(6, 6), start, count: 2, seed: 2 });
    assertNullOrPlan(plan, { startId: start.id, count: 2 });
  });

  test('never emits the start song and never repeats an id', () => {
    const start = song('clash-1', 'Root', 128, '8A', 0.5);
    const candidates = [
      song('clash-1', 'Other', 124, '9A', 0.5),
      song('dup-2', 'B', 120, '8A', 0.5),
      song('dup-2', 'C', 130, '8A', 0.5),
      song('dup-3', 'D', 122, '9A', 0.55),
    ];
    for (const seed of range(25)) {
      const plan = planSet({ candidates, start, count: 4, seed });
      assertNullOrPlan(plan, { startId: 'clash-1', count: 4 });
      if (plan === null) continue;
      const ids = plan.items.map((item) => item.id);
      assert.equal(new Set(ids).size, ids.length, `duplicate ids for seed ${seed}`);
      assert.ok(!ids.includes('clash-1'), 'start id leaked into the plan');
    }
  });

  test('returns min(count, valid candidates) items', () => {
    for (const [count, n] of [[1, 6], [2, 6], [4, 4], [4, 3], [50, 3], [3, 7]]) {
      const candidates = makeLibrary(n, 100 + n + count);
      for (const seed of range(5)) {
        const plan = assertPlan(planSet({ candidates, start: startSong(), count, seed }), { count });
        assert.equal(plan.items.length, Math.min(count, n), `count=${count} n=${n} seed=${seed}`);
      }
    }
  });

  test('is deterministic for a given seed', () => {
    const candidates = makeLibrary(9, 8);
    const start = startSong();
    for (const seed of range(12)) {
      const options = { count: 5, beamWidth: 4, seed };
      const first = planSet({ candidates, start, ...options });
      const copyStart = JSON.parse(JSON.stringify(start));
      const copyCandidates = JSON.parse(JSON.stringify(candidates));
      const second = planSet({ candidates: copyCandidates, start: copyStart, ...options });
      assert.deepEqual(second, first, `seed ${seed} was not reproducible`);
      const again = planSet({ candidates, start, ...options });
      assert.deepEqual(again, first, `seed ${seed} drifted on a repeat call`);
    }
  });

  test('does not mutate its inputs', () => {
    const candidates = deepFreeze(makeLibrary(7, 9));
    const start = deepFreeze(startSong());
    const before = JSON.stringify({ candidates, start });
    const plan = planSet({ candidates, start, count: 3, beamWidth: 6, seed: 7 });
    assert.ok(plan !== null);
    assert.equal(JSON.stringify({ candidates, start }), before, 'inputs were mutated');
    assert.notEqual(plan.items, candidates);
  });

  test('echoes the requested arc', () => {
    for (const arc of ['build-peak-cool', 'warm-up']) {
      const plan = assertPlan(planSet({ candidates: makeLibrary(6, 11), start: startSong(), count: 3, arc, seed: 2 }), { count: 3 });
      assert.equal(plan.arc, arc);
    }
  });

  test('every plan is well formed across many seeds', () => {
    const candidates = makeLibrary(14, 12);
    for (const seed of range(50)) {
      const plan = planSet({ candidates, start: startSong(), count: 6, beamWidth: 8, seed });
      assertNullOrPlan(plan, { startId: 'start-song', count: 6 });
    }
  });
});

describe('preferences', () => {
  // Every candidate below is deliberately incompatible: >=25% tempo step (and no
  // useful doubling/halving) plus a Camelot distance of 3 or more from 8A.
  const farCandidates = () => [
    song('far-1', 'A', 92, '4A', 0.5),
    song('far-2', 'B', 98, '12A', 0.52),
    song('far-3', 'C', 101, '5A', 0.48),
    song('far-4', 'D', 165, '11A', 0.5),
    song('far-5', 'E', 172, '2A', 0.5),
    song('far-6', 'F', 178, '1A', 0.5),
  ];

  for (const [label, tempo] of [['halved', 64], ['doubled', 256]]) {
    test(`ranks the only ${label}-tempo, key-compatible candidate first`, () => {
      const start = startSong();
      const candidates = [song('gem', 'Gem', tempo, '8A', 0.5), ...farCandidates()];
      const seeds = range(50);
      const ids = firstIds(seeds, (seed) => planSet({ candidates, start, count: 3, seed }));
      winRate(ids, 'gem', seeds);
    });
  }

  test('prefers the smaller tempo step', () => {
    const start = startSong();
    const candidates = [
      song('near-tempo', 'A', 130, '8A', 0.5),
      song('far-tempo-1', 'B', 92, '8A', 0.5),
      song('far-tempo-2', 'C', 101, '8A', 0.5),
      song('far-tempo-3', 'D', 165, '8A', 0.5),
      song('far-tempo-4', 'E', 178, '8A', 0.5),
    ];
    const seeds = range(50);
    const ids = firstIds(seeds, (seed) => planSet({ candidates, start, count: 3, seed }));
    winRate(ids, 'near-tempo', seeds);
  });

  test('prefers the closer Camelot key', () => {
    const start = startSong();
    const candidates = [
      song('near-key', 'A', 128, '9A', 0.5),
      song('far-key-1', 'B', 128, '2A', 0.5),
      song('far-key-2', 'C', 128, '1A', 0.5),
      song('far-key-3', 'D', 128, '11A', 0.5),
      song('far-key-4', 'E', 128, '12A', 0.5),
    ];
    const seeds = range(50);
    const ids = firstIds(seeds, (seed) => planSet({ candidates, start, count: 1, arc: 'none', seed }));
    winRate(ids, 'near-key', seeds);
  });

  test('prefers the smaller energy change', () => {
    const start = startSong({ energy: 0.2 });
    const candidates = [
      song('steady', 'A', 128, '8A', 0.25),
      song('jump-1', 'B', 128, '8A', 0.9),
      song('jump-2', 'C', 128, '8A', 0.75),
      song('jump-3', 'D', 128, '8A', 0.65),
    ];
    const seeds = range(50);
    const ids = firstIds(seeds, (seed) => planSet({ candidates, start, count: 1, arc: 'none', seed }));
    winRate(ids, 'steady', seeds);
  });

  test('avoids the start artist in the opening songs', () => {
    const start = startSong();
    const candidates = [
      song('root-again', 'Root Artist', 128, '8A', 0.5),
      ...range(11).map((i) => song(`other-${i}`, `Guest ${i}`, 128, i % 2 ? '8A' : '9A', 0.5)),
    ];
    const seeds = range(50);
    let clean = 0;
    for (const seed of seeds) {
      const plan = assertPlan(planSet({ candidates, start, count: 5, seed }), { count: 5, startId: start.id });
      const opening = plan.items.slice(0, 3);
      if (opening.every((item) => candidates.find((c) => c.id === item.id).artist !== start.artist)) clean += 1;
    }
    assert.ok(clean >= 45, `expected the start artist kept out of the first 3 slots in >= 45/50 runs, got ${clean}/50`);
  });

  test('avoids repeating an artist in neighbouring slots', () => {
    const start = startSong();
    const artists = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'];
    const candidates = artists.flatMap((artist) => [
      song(`${artist}-1`, artist, 128, '8A', 0.5),
      song(`${artist}-2`, artist, 128, '9A', 0.5),
    ]);
    const seeds = range(50);
    let clean = 0;
    for (const seed of seeds) {
      const plan = assertPlan(planSet({ candidates, start, count: 8, beamWidth: 8, seed }), { count: 8, startId: start.id });
      const names = plan.items.map((item) => candidates.find((c) => c.id === item.id).artist);
      const cramped = names.some((name, i) => names.slice(i + 1, i + 3).includes(name));
      if (!cramped) clean += 1;
    }
    assert.ok(clean >= 35, `expected no artist twice within 3 slots in >= 35/50 runs, got ${clean}/50`);
  });
});

describe('custom pairScore', () => {
  const buildStart = () => startSong();
  const buildCandidates = () => [
    song('z', 'Alpha', 128, '8A', 0.5),
    song('y', 'Beta', 128, '8A', 0.5),
    song('f1', 'Gamma', 128, '8A', 0.5),
    song('f2', 'Delta', 128, '8A', 0.5),
    song('f3', 'Epsilon', 128, '8A', 0.5),
    song('f4', 'Zeta', 128, '8A', 0.5),
  ];

  // Direction-agnostic on purpose: the contract does not fix the argument order,
  // so the only way to make "z first" unavoidable is to reward the z/playing-song pair.
  const favourZ = (startId) => (a, b) => {
    const withStart = (x, y) => (x && x.id === 'z' && y && y.id === startId) || (y && y.id === 'z' && x && x.id === startId);
    if (withStart(a, b)) return 1;
    if ((a && a.id === 'z') || (b && b.id === 'z')) return 0.6;
    return 0.1;
  };

  test('a pairScore favouring id "z" puts "z" first in most runs', () => {
    const start = buildStart();
    const candidates = buildCandidates();
    const pairScore = favourZ(start.id);
    const seeds = range(50);
    const ids = firstIds(seeds, (seed) => planSet({ candidates, start, count: 3, pairScore, seed }));
    winRate(ids, 'z', seeds);
  });

  test('a pairScore favouring id "z" pulls "z" into the plan', () => {
    const start = buildStart();
    const candidates = buildCandidates();
    const pairScore = favourZ(start.id);
    const seeds = range(50);
    let present = 0;
    for (const seed of seeds) {
      const plan = assertPlan(planSet({ candidates, start, count: 2, pairScore, seed }), { count: 2, startId: start.id });
      if (plan.items.some((item) => item.id === 'z')) present += 1;
    }
    assert.ok(present >= 45, `expected "z" in the plan in >= 45/50 runs, got ${present}/50`);
  });

  test('is called with two song-like arguments and may return any 0..1 score', () => {
    const calls = [];
    const candidates = makeLibrary(6, 77);
    const start = startSong();
    const plan = planSet({
      candidates,
      start,
      count: 3,
      seed: 5,
      pairScore(a, b) {
        calls.push([a, b]);
        return 0.5;
      },
    });
    assertPlan(plan, { count: 3, startId: start.id });
    assert.ok(calls.length > 0, 'expected pairScore to be called');
    for (const [a, b] of calls) {
      assert.ok(a && typeof a === 'object', 'first pairScore argument must be an object');
      assert.ok(b && typeof b === 'object', 'second pairScore argument must be an object');
    }
    assert.ok(calls.some(([a, b]) => typeof a.id === 'string' || typeof b.id === 'string'), 'no id seen by pairScore');
  });

  test('a flat pairScore still yields a full length plan', () => {
    const candidates = makeLibrary(5, 78);
    const start = startSong();
    for (const value of [0, 1]) {
      const plan = assertPlan(planSet({ candidates, start, count: 4, pairScore: () => value, seed: 6 }), { count: 4, startId: start.id });
      assert.equal(plan.items.length, 4);
    }
  });
});

describe('hostile inputs', () => {
  test('never throws, never hangs, and stays structurally valid', () => {
    const start = startSong();
    const cases = [
      { candidates: [], start, count: 4 },
      { candidates: [null, undefined, 0, '', [], {}], start, count: 4 },
      { candidates: [song('x', 'A', NaN, '8A', 0.5), song('y', 'B', Infinity, '8A', 0.5), song('z', 'C', -40, '8A', 0.5)], start, count: 3 },
      { candidates: [song('x', 'A', 120, '8A', null), song('y', 'B', null, null, null), song('z', 'C', 121, '8A', NaN)], start, count: 3 },
      { candidates: [{ id: 'no-taste', artist: 'A', tempo: 120, camelot: '8A', energy: 0.5 }], start, count: 1 },
      { candidates: Array.from({ length: 8 }, () => song('same-id', 'A', 120, '8A', 0.5)), start, count: 6 },
      { candidates: makeLibrary(3, 21), start, count: 1000 },
      { candidates: makeLibrary(3, 22), start, count: 3, beamWidth: 0 },
      { candidates: makeLibrary(3, 23), start, count: 3, beamWidth: -5 },
      { candidates: makeLibrary(3, 24), start, count: 3, beamWidth: 1e6 },
      { candidates: makeLibrary(3, 25), start: startSong({ tempo: NaN, camelot: null, energy: 0.5 }), count: 3 },
      { candidates: makeLibrary(3, 26), start: startSong({ artist: null, taste: 0.9 }), count: 3 },
    ];
    for (const options of cases) {
      const plan = planSet(options);
      assertNullOrPlan(plan, { startId: options.start.id, count: options.count });
    }
  });

  test('skips malformed candidates and only returns real songs', () => {
    const start = startSong();
    const good = makeLibrary(5, 31);
    const candidates = [...good.slice(0, 2), null, 'nope', 7, {}, { artist: 'A' }, ...good.slice(2)];
    const allowed = new Set(good.map((s) => s.id));
    for (const seed of range(20)) {
      const plan = planSet({ candidates, start, count: 5, seed });
      assertNullOrPlan(plan, { startId: start.id, count: 5, allowedIds: allowed });
      if (plan === null) continue;
      const ids = plan.items.map((item) => item.id);
      assert.equal(new Set(ids).size, ids.length);
    }
  });

  test('plans a large library inside the test timeout', { timeout: 20000 }, () => {
    const candidates = makeLibrary(200, 4242);
    const start = startSong();
    const plan = assertPlan(planSet({ candidates, start, count: 12, beamWidth: 16, seed: 11 }), { count: 12, startId: start.id });
    const ids = plan.items.map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('pinned weights, penalties and score formulas', () => {
  const round6 = (x) => Math.round(x * 1e6) / 1e6;

  test('tempo step calculation, tempo score, and tempoStep penalty at 6% boundary', () => {
    const start = { id: 's', artist: 'Artist1', tempo: 100, camelot: '8A', energy: 0.5, taste: 0.5 };

    // step = 4% (tempo 104), tempoScore = 1 - 4/8 = 0.5, no penalty
    const c4 = { id: 'c4', artist: 'Artist2', tempo: 104, camelot: '8A', energy: 0.5, taste: 0.5 };
    const p4 = planSet({ candidates: [c4], start, count: 1, arc: 'none', seed: 1 });
    assert.equal(p4.items[0].reason.stepPct, 4);
    assert.deepEqual(p4.items[0].reason.penalties, []);
    // pair = 0.45 * 0.5 + 0.3 * 1.0 + 0.25 * 1.0 = 0.225 + 0.3 + 0.25 = 0.775
    assert.equal(round6(p4.items[0].reason.pair), 0.775);
    // score = 0.7 * 0.775 + 0.3 * 0.5 = 0.5425 + 0.15 = 0.6925
    assert.equal(round6(p4.score), 0.6925);

    // step = 6% exact (tempo 106), stepPct <= 6 -> no penalty!
    const c6 = { id: 'c6', artist: 'Artist2', tempo: 106, camelot: '8A', energy: 0.5, taste: 0.5 };
    const p6 = planSet({ candidates: [c6], start, count: 1, arc: 'none', seed: 1 });
    assert.equal(p6.items[0].reason.stepPct, 6);
    assert.ok(!p6.items[0].reason.penalties.includes('tempoStep'));

    // step = 6.4% (tempo 106.4), stepPct > 6 -> tempoStep penalty!
    const c64 = { id: 'c64', artist: 'Artist2', tempo: 106.4, camelot: '8A', energy: 0.5, taste: 0.5 };
    const p64 = planSet({ candidates: [c64], start, count: 1, arc: 'none', seed: 1 });
    assert.equal(round6(p64.items[0].reason.stepPct), 6.4);
    assert.deepEqual(p64.items[0].reason.penalties, ['tempoStep']);
    // tempoScore = 1 - 6.4/8 = 0.2
    // pair = 0.45 * 0.2 + 0.3 * 1.0 + 0.25 * 1.0 = 0.09 + 0.3 + 0.25 = 0.64
    assert.equal(round6(p64.items[0].reason.pair), 0.64);
    // score = 0.7 * 0.64 + 0.3 * 0.5 - 0.3 (penalty) = 0.448 + 0.15 - 0.3 = 0.298
    assert.equal(round6(p64.score), 0.298);

    // step = 10% (tempo 110), tempoScore = 1 - min(1, 10/8) = 0
    const c10 = { id: 'c10', artist: 'Artist2', tempo: 110, camelot: '8A', energy: 0.5, taste: 0.5 };
    const p10 = planSet({ candidates: [c10], start, count: 1, arc: 'none', seed: 1 });
    assert.equal(p10.items[0].reason.stepPct, 10);
    // pair = 0.45 * 0 + 0.3 * 1.0 + 0.25 * 1.0 = 0.55
    assert.equal(round6(p10.items[0].reason.pair), 0.55);

    // tempo null -> stepPct null, tempoScore = UNKNOWN = 0.5
    const cNull = { id: 'cn', artist: 'Artist2', tempo: null, camelot: '8A', energy: 0.5, taste: 0.5 };
    const pn = planSet({ candidates: [cNull], start, count: 1, arc: 'none', seed: 1 });
    assert.equal(pn.items[0].reason.stepPct, null);
    // pair = 0.45 * 0.5 + 0.3 * 1.0 + 0.25 * 1.0 = 0.225 + 0.55 = 0.775
    assert.equal(round6(pn.items[0].reason.pair), 0.775);
  });

  test('Camelot key distance, key score (1, 0.85, 0.4, 0), and keyDistance penalty', () => {
    const start = { id: 's', artist: 'Artist1', tempo: 100, camelot: '8A', energy: 0.5, taste: 0.5 };

    // Distance 0: same number & letter (8A -> 8A): dist 0, keyScore 1.0, no penalty
    const c0a = { id: 'c0a', artist: 'Artist2', tempo: 100, camelot: '8A', energy: 0.5, taste: 0.5 };
    const p0a = planSet({ candidates: [c0a], start, count: 1, arc: 'none', seed: 1 });
    assert.equal(p0a.items[0].reason.keyDistance, 0);
    assert.equal(round6(p0a.items[0].reason.pair), 1.0); // 0.45 + 0.30 + 0.25

    // Distance 0: same number, different letter (8A -> 8B): dist 0, keyScore 1.0, no penalty
    const c0b = { id: 'c0b', artist: 'Artist2', tempo: 100, camelot: '8B', energy: 0.5, taste: 0.5 };
    const p0b = planSet({ candidates: [c0b], start, count: 1, arc: 'none', seed: 1 });
    assert.equal(p0b.items[0].reason.keyDistance, 0);
    assert.equal(round6(p0b.items[0].reason.pair), 1.0);

    // Distance 1: number +- 1, same letter (8A -> 9A): dist 1, keyScore 0.85, no penalty (<= 1)
    const c1 = { id: 'c1', artist: 'Artist2', tempo: 100, camelot: '9A', energy: 0.5, taste: 0.5 };
    const p1 = planSet({ candidates: [c1], start, count: 1, arc: 'none', seed: 1 });
    assert.equal(p1.items[0].reason.keyDistance, 1);
    assert.deepEqual(p1.items[0].reason.penalties, []);
    // pair = 0.45 * 1 + 0.3 * 0.85 + 0.25 * 1 = 0.45 + 0.255 + 0.25 = 0.955
    assert.equal(round6(p1.items[0].reason.pair), 0.955);
    // score = 0.7 * 0.955 + 0.3 * 0.5 = 0.6685 + 0.15 = 0.8185
    assert.equal(round6(p1.score), 0.8185);

    // Distance 2: circular step 1 + letter diff 1 (8A -> 9B): dist 2, keyScore 0.4, penalty keyDistance
    const c2a = { id: 'c2a', artist: 'Artist2', tempo: 100, camelot: '9B', energy: 0.5, taste: 0.5 };
    const p2a = planSet({ candidates: [c2a], start, count: 1, arc: 'none', seed: 1 });
    assert.equal(p2a.items[0].reason.keyDistance, 2);
    assert.deepEqual(p2a.items[0].reason.penalties, ['keyDistance']);
    // pair = 0.45 * 1 + 0.3 * 0.4 + 0.25 * 1 = 0.45 + 0.12 + 0.25 = 0.82
    assert.equal(round6(p2a.items[0].reason.pair), 0.82);
    // score = 0.7 * 0.82 + 0.3 * 0.5 - 0.2 (penalty) = 0.574 + 0.15 - 0.2 = 0.524
    assert.equal(round6(p2a.score), 0.524);

    // Distance 2: circular step 2, same letter (8A -> 10A): dist 2, keyScore 0.4, penalty keyDistance
    const c2b = { id: 'c2b', artist: 'Artist2', tempo: 100, camelot: '10A', energy: 0.5, taste: 0.5 };
    const p2b = planSet({ candidates: [c2b], start, count: 1, arc: 'none', seed: 1 });
    assert.equal(p2b.items[0].reason.keyDistance, 2);
    assert.equal(round6(p2b.items[0].reason.pair), 0.82);

    // Distance 3: (8A -> 11A): dist 3, keyScore 0, penalty keyDistance
    const c3 = { id: 'c3', artist: 'Artist2', tempo: 100, camelot: '11A', energy: 0.5, taste: 0.5 };
    const p3 = planSet({ candidates: [c3], start, count: 1, arc: 'none', seed: 1 });
    assert.equal(p3.items[0].reason.keyDistance, 3);
    assert.deepEqual(p3.items[0].reason.penalties, ['keyDistance']);
    // pair = 0.45 * 1 + 0.3 * 0 + 0.25 * 1 = 0.70
    assert.equal(round6(p3.items[0].reason.pair), 0.70);

    // Circular wrap boundary: 12A to 1A: circularStep = 1, same letter -> dist 1
    const s12 = { id: 's12', artist: 'A', tempo: 100, camelot: '12A', energy: 0.5, taste: 0.5 };
    const cWrap = { id: 'cw', artist: 'B', tempo: 100, camelot: '1A', energy: 0.5, taste: 0.5 };
    const pWrap = planSet({ candidates: [cWrap], start: s12, count: 1, arc: 'none', seed: 1 });
    assert.equal(pWrap.items[0].reason.keyDistance, 1);

    // key null -> keyDistance null, keyScore 0
    const cNullKey = { id: 'cnk', artist: 'Artist2', tempo: 100, camelot: null, energy: 0.5, taste: 0.5 };
    const pnk = planSet({ candidates: [cNullKey], start, count: 1, arc: 'none', seed: 1 });
    assert.equal(pnk.items[0].reason.keyDistance, null);
    assert.equal(round6(pnk.items[0].reason.pair), 0.70);
  });

  test('energy score, energy jump limit at 0.3 boundary, and energyJump penalty', () => {
    const start = { id: 's', artist: 'Artist1', tempo: 100, camelot: '8A', energy: 0.5, taste: 0.5 };

    // Delta = 0.15: energyScore = 1 - 0.15/0.3 = 0.5. No penalty
    const c15 = { id: 'c15', artist: 'Artist2', tempo: 100, camelot: '8A', energy: 0.65, taste: 0.5 };
    const p15 = planSet({ candidates: [c15], start, count: 1, arc: 'none', seed: 1 });
    assert.equal(round6(p15.items[0].reason.energyDelta), 0.15);
    assert.deepEqual(p15.items[0].reason.penalties, []);
    // pair = 0.45 * 1 + 0.3 * 1 + 0.25 * 0.5 = 0.45 + 0.3 + 0.125 = 0.875
    assert.equal(round6(p15.items[0].reason.pair), 0.875);

    // Delta = 0.30 exact: energyScore = 1 - 0.30/0.30 = 0. No penalty (|delta| <= 0.3)
    const s20 = { id: 's20', artist: 'Artist1', tempo: 100, camelot: '8A', energy: 0.2, taste: 0.5 };
    const c30 = { id: 'c30', artist: 'Artist2', tempo: 100, camelot: '8A', energy: 0.5, taste: 0.5 };
    const p30 = planSet({ candidates: [c30], start: s20, count: 1, arc: 'none', seed: 1 });
    assert.equal(round6(p30.items[0].reason.energyDelta), 0.30);
    assert.deepEqual(p30.items[0].reason.penalties, []);
    // pair = 0.45 + 0.3 + 0.25 * 0 = 0.75
    assert.equal(round6(p30.items[0].reason.pair), 0.75);

    // Delta = 0.35: energyScore = 0. Penalty energyJump
    const c35 = { id: 'c35', artist: 'Artist2', tempo: 100, camelot: '8A', energy: 0.85, taste: 0.5 };
    const p35 = planSet({ candidates: [c35], start, count: 1, arc: 'none', seed: 1 });
    assert.equal(round6(p35.items[0].reason.energyDelta), 0.35);
    assert.deepEqual(p35.items[0].reason.penalties, ['energyJump']);
    // pair = 0.75
    assert.equal(round6(p35.items[0].reason.pair), 0.75);
    // score = 0.7 * 0.75 + 0.3 * 0.5 - 0.2 (penalty) = 0.525 + 0.15 - 0.2 = 0.475
    assert.equal(round6(p35.score), 0.475);

    // Delta = -0.35 (downward jump): penalty energyJump
    const cDown = { id: 'cdown', artist: 'Artist2', tempo: 100, camelot: '8A', energy: 0.15, taste: 0.5 };
    const pDown = planSet({ candidates: [cDown], start, count: 1, arc: 'none', seed: 1 });
    assert.equal(round6(pDown.items[0].reason.energyDelta), -0.35);
    assert.deepEqual(pDown.items[0].reason.penalties, ['energyJump']);

    // Energy null -> energyDelta null, energyScore = UNKNOWN = 0.5
    const cNull = { id: 'cne', artist: 'Artist2', tempo: 100, camelot: '8A', energy: null, taste: 0.5 };
    const pne = planSet({ candidates: [cNull], start, count: 1, arc: 'none', seed: 1 });
    assert.equal(pne.items[0].reason.energyDelta, null);
    // pair = 0.45 + 0.3 + 0.25 * 0.5 = 0.875
    assert.equal(round6(pne.items[0].reason.pair), 0.875);
  });

  test('artist repetition penalty sameArtist (0.4) within recent 4 window', () => {
    const start = { id: 's', artist: 'Artist1', tempo: 100, camelot: '8A', energy: 0.5, taste: 0.5 };
    // Candidate with same artist as start
    const cSame = { id: 'csame', artist: 'Artist1', tempo: 100, camelot: '8A', energy: 0.5, taste: 0.5 };
    const pSame = planSet({ candidates: [cSame], start, count: 1, arc: 'none', seed: 1 });
    assert.deepEqual(pSame.items[0].reason.penalties, ['sameArtist']);
    // score = 0.7 * 1.0 + 0.3 * 0.5 - 0.4 (penalty) = 0.7 + 0.15 - 0.4 = 0.45
    assert.equal(round6(pSame.score), 0.45);
  });

  test('arcTarget and arcTerm for steady, build-peak-cool, and none', () => {
    const start = { id: 's', artist: 'Artist1', tempo: 100, camelot: '8A', energy: 0.6, taste: 0.5 };
    const cand = { id: 'c', artist: 'Artist2', tempo: 100, camelot: '8A', energy: 0.8, taste: 0.5 };

    // arc: 'none' -> target null, arcTerm 0
    const pNone = planSet({ candidates: [cand], start, count: 1, arc: 'none', seed: 1 });
    // score = 0.7 * (pair=1 - 0.25*(0.2/0.3)) = 0.7 * (0.45 + 0.3 + 0.25*(1 - 0.2/0.3))
    // energyScore = 1 - 2/3 = 1/3. pair = 0.45 + 0.3 + 0.25/3 = 0.75 + 0.083333 = 0.833333
    // score = 0.7 * 0.833333 + 0.3 * 0.5 = 0.733333
    assert.equal(round6(pNone.score), 0.733333);

    // arc: 'steady' -> target = start.energy = 0.6. cand.energy = 0.8. |0.8 - 0.6| = 0.2
    // arcTerm = 0.25 * (1 - min(1, 0.2)) = 0.25 * 0.8 = 0.2
    // score = 0.733333 + 0.2 = 0.933333
    const pSteady = planSet({ candidates: [cand], start, count: 1, arc: 'steady', seed: 1 });
    assert.equal(round6(pSteady.score), 0.933333);

    // arc: 'build-peak-cool' -> count=1, index=0: target = 0.5 + 0.3 * sin(pi * 1 / 2) = 0.8
    // cand.energy = 0.8 matches target exactly! |0.8 - 0.8| = 0.
    // arcTerm = 0.25 * (1 - 0) = 0.25
    // score = 0.733333 + 0.25 = 0.983333
    const pBuild = planSet({ candidates: [cand], start, count: 1, arc: 'build-peak-cool', seed: 1 });
    assert.equal(round6(pBuild.score), 0.983333);

    // Multi-position arc targets: count=3, targets are index 0, 1, 2
    // target(0) = 0.5 + 0.3 * sin(pi/4) = 0.5 + 0.3 * sqrt(0.5) = 0.712132
    // target(1) = 0.5 + 0.3 * sin(2*pi/4) = 0.8
    // target(2) = 0.5 + 0.3 * sin(3*pi/4) = 0.712132
    const c1 = { id: 'c1', artist: 'A2', tempo: 100, camelot: '8A', energy: 0.712132, taste: 0.5 };
    const c2 = { id: 'c2', artist: 'A3', tempo: 100, camelot: '8A', energy: 0.8, taste: 0.5 };
    const c3 = { id: 'c3', artist: 'A4', tempo: 100, camelot: '8A', energy: 0.712132, taste: 0.5 };
    const p3Pos = planSet({ candidates: [c1, c2, c3], start, count: 3, arc: 'build-peak-cool', beamWidth: 4, seed: 1 });
    assert.equal(p3Pos.items.length, 3);
  });

  test('options validation and edge cases', () => {
    const start = { id: 's', artist: 'Artist1', tempo: 100, camelot: '8A', energy: 0.5, taste: 0.5 };
    const cand = { id: 'c', artist: 'Artist2', tempo: 100, camelot: '8A', energy: 0.5, taste: 0.5 };

    // null options returns null (kills L194)
    assert.equal(planSet(null), null);

    // tempo boundary: start tempo 0 is rejected, tempo 0.5 is accepted (kills L47)
    assert.equal(planSet({ candidates: [cand], start: { ...start, tempo: 0 } }), null);
    assert.equal(planSet({ candidates: [cand], start: { ...start, tempo: -5 } }), null);
    const pTempoHalf = planSet({ candidates: [{ id: 'chalf', artist: 'A2', tempo: 0.5, camelot: '8A', energy: 0.5, taste: 0.5 }], start, count: 1 });
    assert.equal(pTempoHalf.items[0].id, 'chalf');

    // fractional count is floored: count = 1.9 -> wanted = 1
    const pFloor = planSet({ candidates: [cand], start, count: 1.9, seed: 1 });
    assert.equal(pFloor.items.length, 1);

    // when count exceeds candidate pool, depth stops at available candidates
    const pShort = planSet({ candidates: [cand], start, count: 5, seed: 1 });
    assert.equal(pShort.items.length, 1);

    // tie-breaking among candidate entries with equal score by key (kills L158, L159)
    const cA = { id: 'candA', artist: 'A2', tempo: 100, camelot: '8A', energy: 0.5, taste: 0.5 };
    const cB = { id: 'candB', artist: 'A3', tempo: 100, camelot: '8A', energy: 0.5, taste: 0.5 };
    const pTie = planSet({ candidates: [cB, cA], start, count: 1, arc: 'none', seed: 8 });
    assert.equal(pTie.items[0].id, 'candA');

    // default beamWidth 8 vs beamWidth 1 (kills L197 and L212)
    const candA = { id: 'cA', artist: 'A', tempo: 100, camelot: '8A', energy: 0.5, taste: 1.0 };
    const candB = { id: 'cB', artist: 'B', tempo: 100, camelot: '8A', energy: 0.5, taste: 0.8 };
    const candC = { id: 'cC', artist: 'C', tempo: 100, camelot: '8A', energy: 0.5, taste: 0.5 };
    const pairScore = (a, b) => {
      if (a.id === 's' && b.id === 'cA') return 1.0;
      if (a.id === 's' && b.id === 'cB') return 0.8;
      if (a.id === 'cA' && b.id === 'cC') return 0.0;
      if (a.id === 'cB' && b.id === 'cC') return 1.0;
      return 0.1;
    };
    const pDefaultBeam = planSet({ candidates: [candA, candB, candC], start, count: 2, pairScore, arc: 'none', seed: 8 });
    const pWidth1 = planSet({ candidates: [candA, candB, candC], start, count: 2, pairScore, beamWidth: 1, arc: 'none', seed: 8 });
    assert.deepEqual(pDefaultBeam.items.map((x) => x.id), ['cB', 'cC']);
    assert.deepEqual(pWidth1.items.map((x) => x.id), ['cA', 'cB']);

    // PRNG candidate selection among top 3 beams (kills L17 weights, L167, L169)
    const c0 = { id: 'c0', artist: 'A0', tempo: 100, camelot: '8A', energy: 0.5, taste: 0.9 };
    const c1 = { id: 'c1', artist: 'A1', tempo: 100, camelot: '8A', energy: 0.5, taste: 0.8 };
    const c2 = { id: 'c2', artist: 'A2', tempo: 100, camelot: '8A', energy: 0.5, taste: 0.7 };
    const pPick0 = planSet({ candidates: [c0, c1, c2], start, count: 1, arc: 'none', seed: 8 });
    const pPick1 = planSet({ candidates: [c0, c1, c2], start, count: 1, arc: 'none', seed: 2 });
    const pPick2 = planSet({ candidates: [c0, c1, c2], start, count: 1, arc: 'none', seed: 4 });
    assert.equal(pPick0.items[0].id, 'c0');
    assert.equal(pPick1.items[0].id, 'c1');
    assert.equal(pPick2.items[0].id, 'c2');

    // build-peak-cool multi-position arc formula (kills L112)
    const t0 = 0.5 + 0.3 * Math.sin(Math.PI / 3);
    const t1 = 0.5 + 0.3 * Math.sin((2 * Math.PI) / 3);
    const cArc0 = { id: 'ca0', artist: 'A0', tempo: 100, camelot: '8A', energy: t0, taste: 0.5 };
    const cArc1 = { id: 'ca1', artist: 'A1', tempo: 100, camelot: '8A', energy: t1, taste: 0.5 };
    const pArc2 = planSet({ candidates: [cArc0, cArc1], start, count: 2, arc: 'build-peak-cool', seed: 8 });
    assert.equal(round6(pArc2.score), 2.048446);
  });
});

