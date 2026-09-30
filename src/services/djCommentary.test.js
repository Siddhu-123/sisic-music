import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { commentaryFor, TEMPLATES } from './djCommentary.js';

const KINDS = ['set-intro', 'link', 'callback'];
const WORD_LIMIT = { 'set-intro': 45, link: 30, callback: 30 };
const NAME = 'Alpha Bravo Charlie Delta';
const OTHER_NAME = 'Echo Foxtrot Golf Hotel';

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{2B00}-\u{2BFF}]|\uFE0F|\u200D/u;

const words = (s) => String(s).trim().split(/\s+/).filter(Boolean);
const wordCount = (s) => words(s).length;

function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 0x100000000;
  };
}

const values = {
  theme: 'Deep Funky Groove',
  count: 7,
  artist: NAME,
  title: 'Midnight Signals',
  prevArtist: OTHER_NAME,
  prevTitle: 'Morning Echoes',
  tempoRelation: 'a touch faster',
  keyRelation: 'a shade darker',
  mood: 'warm and hazy',
  playCount: 3,
  lastPlayedDaysAgo: 12,
  timeOfDay: 'late evening',
  firstTime: true,
};

function factsFor(needs) {
  const facts = {};
  for (const need of needs) {
    assert.ok(Object.hasOwn(values, need), `unknown fact key in needs: ${need}`);
    facts[need] = values[need];
  }
  return facts;
}

function assertTextOk(text, kind) {
  assert.equal(typeof text, 'string');
  assert.ok(text.length > 0, 'empty text');
  assert.ok(!text.includes('{') && !text.includes('}'), `leftover braces: ${text}`);
  assert.ok(!EMOJI.test(text), `emoji in text: ${text}`);
  assert.ok((text.match(/!/g) || []).length <= 1, `too many exclamation marks: ${text}`);
  assert.ok(
    wordCount(text) <= WORD_LIMIT[kind],
    `too long for ${kind}: ${wordCount(text)} > ${WORD_LIMIT[kind]}: ${text}`,
  );
  return text;
}

const eligibleOrNull = (args) => commentaryFor(args);

test('TEMPLATES is a non-empty array of well-formed templates', () => {
  assert.ok(Array.isArray(TEMPLATES));
  assert.ok(TEMPLATES.length > 0);
  const ids = new Set();
  for (const tpl of TEMPLATES) {
    assert.equal(typeof tpl.id, 'string');
    assert.ok(tpl.id.length > 0);
    assert.ok(!ids.has(tpl.id), `duplicate id ${tpl.id}`);
    ids.add(tpl.id);
    assert.ok(KINDS.includes(tpl.kind), `bad kind ${tpl.kind}`);
    assert.ok(Array.isArray(tpl.needs));
    for (const need of tpl.needs) assert.equal(typeof need, 'string');
    assert.equal(typeof tpl.text, 'string');
    assert.ok(tpl.text.length > 0);
  }
});

test('TEMPLATES covers the documented kinds at scale', () => {
  const byKind = (kind) => TEMPLATES.filter((t) => t.kind === kind);
  assert.ok(byKind('set-intro').length >= 40);
  assert.ok(byKind('link').length >= 40);
  assert.ok(byKind('callback').length >= 30);
});

test('property: every template honours limits with 4-word names', () => {
  let checked = 0;
  for (const tpl of TEMPLATES) {
    const result = commentaryFor({ kind: tpl.kind, facts: factsFor(tpl.needs), templates: [tpl] });
    assert.ok(result, `null for template ${tpl.id} with its own needs satisfied`);
    assert.equal(result.id, tpl.id, `only ${tpl.id} eligible but got ${result.id}`);
    assertTextOk(result.text, tpl.kind);
    checked += 1;
  }
  assert.ok(checked > 0);
});

test('only templates with all needs present and non-empty are used', () => {
  for (const tpl of TEMPLATES) {
    if (tpl.needs.length === 0) continue;
    const missing = {};
    const blank = {};
    for (const need of tpl.needs) {
      missing[need] = undefined;
      blank[need] = '';
    }
    const facts = factsFor(tpl.needs);
    Object.assign(facts, missing);
    for (const need of tpl.needs) facts[need] = values[need];
    facts[tpl.needs[0]] = undefined;
    const a = commentaryFor({ kind: tpl.kind, facts });
    if (a) assert.notEqual(a.id, tpl.id);
    for (const need of tpl.needs) facts[need] = values[need];
    facts[tpl.needs[0]] = '';
    const b = commentaryFor({ kind: tpl.kind, facts });
    if (b) assert.notEqual(b.id, tpl.id);
  }
});

test('long artist and title are shortened at a word boundary', () => {
  const longName = 'Bartholomew Archibald Winterbottom Smitherton';
  const longTitle = 'Extraordinarily Overwhelmingly Supercalifragilistic';
  assert.ok(longName.length > 28);
  for (const kind of KINDS) {
    const result = commentaryFor({
      kind,
      facts: { artist: longName, title: longTitle, theme: 'Deep Funky Groove' },
    });
    if (!result) continue;
    assertTextOk(result.text, kind);
    assert.ok(!result.text.includes(longName), `full artist kept: ${result.text}`);
    assert.ok(!result.text.includes(longTitle), `full title kept: ${result.text}`);
    assert.ok(!result.text.includes('Winterbottom'));
    assert.ok(!result.text.includes('Smitherton'));
    assert.ok(!result.text.includes('Overwhelmingly'));
    assert.ok(!result.text.includes('Supercalifragilistic'));
    assert.ok(!/\bWinter\b/.test(result.text), `word broken mid-way: ${result.text}`);
    assert.ok(!/\bOverwhelmin\b/.test(result.text), `word broken mid-way: ${result.text}`);
  }
});

const LOCAL_TEMPLATES = [];
{
  const bodies = [
    'Fresh {theme} from {artist}, coming up next.',
    '{artist} returns, and the room leans in.',
    'Back to {title}, the one that never gets old.',
    'Ease in with {artist} and let the tempo settle.',
    'Last time {artist} played, the floor was packed.',
    '{title} once more, stitched into tonight.',
    'Hold that thought: {artist} is next up.',
    'Same {theme}, deeper cut, courtesy of {artist}.',
    'From {title} to something a little braver.',
    '{artist} closes the chapter we opened.',
  ];
  const needsList = [
    ['theme', 'artist'],
    ['artist'],
    ['title'],
    ['artist', 'tempoRelation'],
    ['artist', 'lastPlayedDaysAgo'],
    ['title', 'mood'],
    ['artist'],
    ['theme', 'artist'],
    ['title', 'keyRelation'],
    ['artist', 'playCount'],
  ];
  bodies.forEach((text, i) => {
    LOCAL_TEMPLATES.push({ id: `local-${i}`, kind: 'set-intro', needs: needsList[i], text });
    LOCAL_TEMPLATES.push({ id: `local-${i + 10}`, kind: 'set-intro', needs: needsList[i], text });
  });
}

test('local templates option is used and validated', () => {
  assert.equal(LOCAL_TEMPLATES.length, 20);
  for (const kind of KINDS) {
    const result = commentaryFor({
      kind,
      facts: values,
      templates: LOCAL_TEMPLATES.filter((t) => t.kind === kind),
    });
    if (!result) continue;
    assert.ok(LOCAL_TEMPLATES.some((t) => t.id === result.id));
    assertTextOk(result.text, kind);
  }
});

test('500 seeded sequences of 30 calls never repeat within a window of 12', () => {
  for (let seed = 1; seed <= 500; seed += 1) {
    const rng = makeRng(seed);
    const seen = [];
    let memory;
    for (let i = 0; i < 30; i += 1) {
      const result = commentaryFor({
        kind: 'set-intro',
        facts: values,
        templates: LOCAL_TEMPLATES,
        memory,
        rng,
      });
      assert.ok(result, `null for eligible local templates (seed ${seed}, call ${i})`);
      assert.ok(LOCAL_TEMPLATES.some((t) => t.id === result.id));
      assertTextOk(result.text, 'set-intro');
      for (let back = 1; back < 12 && i - back >= 0; back += 1) {
        assert.notEqual(result.id, seen[seen.length - back], `repeat within 12 (seed ${seed})`);
      }
      seen.push(result.id);
      memory = result.memory;
      assert.ok(seen.length <= 12 || i >= 12);
    }
  }
});

test('memory: chosen id first, capped at 12, input untouched', () => {
  const rng = makeRng(99);
  const input = { recent: Array.from({ length: 30 }, (_, i) => `old-${i}`) };
  const snapshot = { recent: input.recent.slice() };
  const result = commentaryFor({ kind: 'set-intro', facts: values, templates: LOCAL_TEMPLATES, memory: input, rng });
  assert.ok(result);
  assert.deepEqual(input, snapshot, 'input memory mutated');
  assert.notEqual(result.memory, input);
  assert.equal(result.memory.recent[0], result.id);
  assert.ok(result.memory.recent.length <= 12);
  for (const id of result.memory.recent) {
    assert.equal(typeof id, 'string');
  }
  for (let seed = 1; seed <= 200; seed += 1) {
    const r = commentaryFor({
      kind: 'set-intro',
      facts: values,
      templates: LOCAL_TEMPLATES,
      memory: { recent: LOCAL_TEMPLATES.slice(0, 12).map((t) => t.id) },
      rng: makeRng(seed),
    });
    if (!r) continue;
    assert.ok(r.memory.recent.length <= 12);
    assert.equal(r.memory.recent[0], r.id);
    // the 12 oldest eligible ids are only used when nothing else is left
    const eligible = LOCAL_TEMPLATES.filter((t) => t.kind === 'set-intro').map((t) => t.id);
    if (eligible.length > 12) assert.ok(!eligible.slice(0, 12).includes(r.id));
  }
});

test('with only the artist known the text mentions it and nothing else leaks', () => {
  const names = [NAME, OTHER_NAME];
  for (const kind of KINDS) {
    for (let seed = 1; seed <= 50; seed += 1) {
      const artist = names[seed % 2];
      const other = names[(seed + 1) % 2];
      const result = commentaryFor({ kind, facts: { artist }, rng: makeRng(seed) });
      if (!result) continue;
      const text = assertTextOk(result.text, kind);
      assert.ok(text.includes(artist), `artist missing: ${text}`);
      assert.ok(!text.includes(other), `other name leaked: ${text}`);
      for (const key of ['theme', 'title', 'mood', 'timeOfDay', 'tempoRelation', 'keyRelation']) {
        assert.ok(!text.includes(String(values[key])), `unknown fact ${key} printed: ${text}`);
      }
    }
  }
});

test('deterministic for a fixed rng', () => {
  const once = (rng) => commentaryFor({ kind: 'link', facts: values, rng });
  for (const r of [() => 0.5, () => 0, () => 0.99]) {
    const a = once(r);
    const b = once(r);
    assert.deepEqual(a, b);
  }
  assert.deepEqual(once(makeRng(5)), once(makeRng(5)));
  const run = (seed) => {
    const rng = makeRng(seed);
    const out = [];
    for (let i = 0; i < 25; i += 1) out.push(commentaryFor({ kind: 'callback', facts: values, rng }));
    return out;
  };
  assert.deepEqual(run(11), run(11));
});

test('null for unknown kind, bad facts, and nothing eligible', () => {
  assert.equal(commentaryFor({ kind: 'nope', facts: values }), null);
  assert.equal(commentaryFor({ facts: values }), null);
  for (const bad of [null, undefined, 'x', 42, true, Symbol('s')]) {
    const out = eligibleOrNull({ kind: 'link', facts: bad });
    assert.ok(out === null || out instanceof TypeError, `facts ${String(bad)} gave ${out}`);
  }
  assert.equal(commentaryFor({ kind: 'link', facts: { unknownKey: 'x' } }), null);
  assert.equal(commentaryFor({ kind: 'link', facts: { artist: '', title: '' } }), null);
});

test('fact-free call returns null or brace-free text', () => {
  for (const kind of KINDS) {
    const result = commentaryFor({ kind, facts: {} });
    if (result === null) continue;
    assertTextOk(result.text, kind);
    assert.equal(result.memory.recent[0], result.id);
    assert.ok(result.memory.recent.length <= 12);
  }
});

test('malformed input never hangs', () => {
  const bad = [
    { kind: 'link', facts: values, templates: 'nope' },
    { kind: 'link', facts: values, templates: [null] },
    { kind: 'link', facts: values, memory: { recent: 'nope' } },
    { kind: 'link', facts: values, rng: 0.5 },
    { kind: [], facts: values },
    null,
    undefined,
    {},
    [],
  ];
  for (const args of bad) {
    const out = commentaryFor(args);
    assert.ok(out === null || out instanceof TypeError || (out && typeof out.text === 'string'));
  }
});

describe('commentary hardening unit tests', () => {
  test('shortenName exact boundaries', () => {
    // 28 chars exact with a space: if <= 28, full string kept; if < 28, it would cut at space
    const s28WithSpace = 'A'.repeat(20) + ' ' + 'B'.repeat(7);
    assert.equal(s28WithSpace.length, 28);
    const res28WithSpace = commentaryFor({
      kind: 'link',
      facts: { artist: s28WithSpace },
      templates: [{ id: 't1s', kind: 'link', needs: ['artist'], text: '{artist}' }],
    });
    assert.equal(res28WithSpace.text, s28WithSpace);

    // 28 chars exact no space
    const s28 = 'A'.repeat(28);
    const res28 = commentaryFor({
      kind: 'link',
      facts: { artist: s28 },
      templates: [{ id: 't1', kind: 'link', needs: ['artist'], text: '{artist}' }],
    });
    assert.equal(res28.text, s28);

    // 29 chars with space at index 1
    const s29SpaceAt1 = 'A ' + 'B'.repeat(27);
    assert.equal(s29SpaceAt1.length, 29);
    const resSpace1 = commentaryFor({
      kind: 'link',
      facts: { artist: s29SpaceAt1 },
      templates: [{ id: 't1b', kind: 'link', needs: ['artist'], text: '{artist}' }],
    });
    assert.equal(resSpace1.text, 'A');

    // 29 chars with space at 20
    const s29 = 'A'.repeat(20) + ' ' + 'B'.repeat(8);
    assert.equal(s29.length, 29);
    const res29 = commentaryFor({
      kind: 'link',
      facts: { artist: s29 },
      templates: [{ id: 't2', kind: 'link', needs: ['artist'], text: '{artist}' }],
    });
    assert.equal(res29.text, 'A'.repeat(20));

    // 29 chars with space at 0 (first char)
    const sSpace0 = ' ' + 'A'.repeat(28);
    const resSpace0 = commentaryFor({
      kind: 'link',
      facts: { artist: sSpace0 },
      templates: [{ id: 't2b', kind: 'link', needs: ['artist'], text: '{artist}' }],
    });
    assert.equal(resSpace0.text, sSpace0.slice(0, 28));

    // 30 chars with no space
    const sNoSpace = 'C'.repeat(30);
    const resNoSpace = commentaryFor({
      kind: 'link',
      facts: { artist: sNoSpace },
      templates: [{ id: 't3', kind: 'link', needs: ['artist'], text: '{artist}' }],
    });
    assert.equal(resNoSpace.text, 'C'.repeat(28));
  });

  test('slot replacement for all facts', () => {
    const tpl = {
      id: 'full',
      kind: 'set-intro',
      needs: [
        'theme', 'count', 'artist', 'title', 'prevArtist', 'prevTitle',
        'tempoRelation', 'keyRelation', 'mood', 'playCount', 'lastPlayedDaysAgo',
        'timeOfDay', 'firstTime',
      ],
      text: '{theme}|{count}|{artist}|{title}|{prevArtist}|{prevTitle}|{tempoRelation}|{keyRelation}|{mood}|{playCount}|{lastPlayedDaysAgo}|{timeOfDay}|{firstTime}',
    };
    const facts = {
      theme: 'Th',
      count: 5,
      artist: 'Ar',
      title: 'Ti',
      prevArtist: 'PAr',
      prevTitle: 'PTi',
      tempoRelation: 'faster',
      keyRelation: 'neighbour',
      mood: 'upbeat',
      playCount: 10,
      lastPlayedDaysAgo: 4,
      timeOfDay: 'morning',
      firstTime: true,
    };
    const r = commentaryFor({ kind: 'set-intro', facts, templates: [tpl] });
    assert.equal(r.text, 'Th|5|Ar|Ti|PAr|PTi|faster|neighbour|upbeat|10|4|morning|first time');

    // firstTime false replaces with ''
    const r2 = commentaryFor({ kind: 'set-intro', facts: { ...facts, firstTime: false }, templates: [tpl] });
    assert.equal(r2.text, 'Th|5|Ar|Ti|PAr|PTi|faster|neighbour|upbeat|10|4|morning|');

    // count 0 and playCount 0 are preserved
    const r3 = commentaryFor({ kind: 'set-intro', facts: { ...facts, count: 0, playCount: 0, lastPlayedDaysAgo: 0 }, templates: [tpl] });
    assert.equal(r3.text, 'Th|0|Ar|Ti|PAr|PTi|faster|neighbour|upbeat|0|0|morning|first time');
  });

  test('options and parameter validations', () => {
    assert.equal(commentaryFor([]), null);
    assert.equal(commentaryFor('string'), null);
    assert.equal(commentaryFor(123), null);
    assert.equal(commentaryFor({ kind: 123, facts: values }), null);
    assert.equal(commentaryFor({ kind: 'set-intro', facts: [] }), null);
    assert.equal(commentaryFor({ kind: 'set-intro', facts: null }), null);
    assert.equal(commentaryFor({ kind: 'set-intro', facts: 'facts' }), null);
    assert.equal(commentaryFor({ kind: 'set-intro', facts: values, memory: [] }), null);
    assert.equal(commentaryFor({ kind: 'set-intro', facts: values, memory: null }), null);
    assert.equal(commentaryFor({ kind: 'set-intro', facts: values, memory: 'mem' }), null);
    assert.equal(commentaryFor({ kind: 'set-intro', facts: values, rng: null }), null);
    assert.equal(commentaryFor({ kind: 'set-intro', facts: values, rng: 'rng' }), null);
    assert.equal(commentaryFor({ kind: 'set-intro', facts: values, templates: 'not-array' }), null);
    assert.equal(commentaryFor({ kind: 'set-intro', facts: values, templates: {} }), null);
  });

  test('template needs filtering and template structure validations', () => {
    const badTemplates = [
      null,
      undefined,
      123,
      'string',
      { id: 'b1' }, // missing kind
      { id: 'b2', kind: 'set-intro' }, // missing needs array
      { id: 'b3', kind: 'set-intro', needs: 'not-array' },
      { id: 'b4', kind: 'other-kind', needs: [] },
      { id: 'b5', kind: 'set-intro', needs: ['missingFact'], text: 'hi' },
      { id: 'b6', kind: 'set-intro', needs: ['emptyFact'], text: 'hi' },
      { id: 'b7', kind: 'set-intro', needs: ['nullFact'], text: 'hi' },
      { id: 'b8', kind: 'set-intro', needs: ['undefinedFact'], text: 'hi' },
    ];
    const facts = { emptyFact: '', nullFact: null, undefinedFact: undefined };
    assert.equal(commentaryFor({ kind: 'set-intro', facts, templates: badTemplates }), null);
  });

  test('memory recent capping at 12 and prepending', () => {
    const tpl = { id: 'x', kind: 'link', needs: [], text: 'hi' };
    const initialRecent = Array.from({ length: 15 }, (_, i) => `id-${i}`);
    const r = commentaryFor({
      kind: 'link',
      facts: {},
      memory: { recent: initialRecent, extraField: 'ok' },
      templates: [tpl],
    });
    assert.equal(r.memory.extraField, 'ok');
    assert.equal(r.memory.recent.length, 12);
    assert.equal(r.memory.recent[0], 'x');
    assert.equal(r.memory.recent[1], 'id-0');
    assert.equal(r.memory.recent[11], 'id-10');

    // Test exact 12-item boundary for memory.recent input filtering:
    // With 13 items in memory.recent, item 13 is dropped from recent filter.
    // If template t13 is eligible, it must be considered nonRecent and picked over recent items.
    const recent13 = Array.from({ length: 13 }, (_, i) => `rec-${i}`);
    const tRecent0 = { id: 'rec-0', kind: 'link', needs: [], text: 'recent0' };
    const tRecent12 = { id: 'rec-12', kind: 'link', needs: [], text: 'recent12' }; // 13th item (index 12)
    const resSlice = commentaryFor({
      kind: 'link',
      facts: {},
      memory: { recent: recent13 },
      templates: [tRecent0, tRecent12],
    });
    // rec-12 was beyond the 12-item slice, so it's non-recent and selected!
    assert.equal(resSlice.id, 'rec-12');
  });

  test('nonRecent pool selection and fallback when all are recent', () => {
    const t1 = { id: 't1', kind: 'link', needs: [], text: 'one' };
    const t2 = { id: 't2', kind: 'link', needs: [], text: 'two' };
    // t1 is recent, t2 is not: must pick t2
    const r = commentaryFor({
      kind: 'link',
      facts: {},
      memory: { recent: ['t1'] },
      templates: [t1, t2],
      rng: () => 0,
    });
    assert.equal(r.id, 't2');

    // both are recent: must fall back to eligible pool
    const r2 = commentaryFor({
      kind: 'link',
      facts: {},
      memory: { recent: ['t1', 't2'] },
      templates: [t1, t2],
      rng: () => 0.99,
    });
    assert.equal(r2.id, 't2');

    const r3 = commentaryFor({
      kind: 'link',
      facts: {},
      memory: { recent: ['t1', 't2'] },
      templates: [t1, t2],
      rng: () => 0,
    });
    assert.equal(r3.id, 't1');
  });

  test('ternary template expressions in fillTemplate', () => {
    const tpl1 = {
      id: 'ternary1',
      kind: 'callback',
      needs: ['firstTime', 'playCount', 'artist', 'title'],
      text: '{firstTime ? "First spin" : "Spin " + playCount} for {title} by {artist}.',
    };
    const rTrue = commentaryFor({
      kind: 'callback',
      facts: { firstTime: true, playCount: 5, artist: 'Artist', title: 'Title' },
      templates: [tpl1],
    });
    assert.equal(rTrue.text, 'First spin for Title by Artist.');

    const rFalse = commentaryFor({
      kind: 'callback',
      facts: { firstTime: false, playCount: 5, artist: 'Artist', title: 'Title' },
      templates: [tpl1],
    });
    assert.equal(rFalse.text, 'Spin 5 for Title by Artist.');
  });
});
