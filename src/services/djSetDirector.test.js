import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAMELOT_TABLE,
  camelotOf,
  factsFor,
  nextFromSet,
  planNextSet,
  shouldSpeak,
  toPlannerSong,
} from './djSetDirector.js';

test('Camelot table covers all 24 keys and standard names', () => {
  assert.equal(typeof CAMELOT_TABLE, 'object');
  // All 12 minor keys (A)
  assert.equal(CAMELOT_TABLE['Ab minor'], '1A');
  assert.equal(CAMELOT_TABLE['G# minor'], '1A');
  assert.equal(CAMELOT_TABLE['Eb minor'], '2A');
  assert.equal(CAMELOT_TABLE['D# minor'], '2A');
  assert.equal(CAMELOT_TABLE['Bb minor'], '3A');
  assert.equal(CAMELOT_TABLE['A# minor'], '3A');
  assert.equal(CAMELOT_TABLE['F minor'], '4A');
  assert.equal(CAMELOT_TABLE['C minor'], '5A');
  assert.equal(CAMELOT_TABLE['G minor'], '6A');
  assert.equal(CAMELOT_TABLE['D minor'], '7A');
  assert.equal(CAMELOT_TABLE['A minor'], '8A');
  assert.equal(CAMELOT_TABLE['E minor'], '9A');
  assert.equal(CAMELOT_TABLE['B minor'], '10A');
  assert.equal(CAMELOT_TABLE['F# minor'], '11A');
  assert.equal(CAMELOT_TABLE['Gb minor'], '11A');
  assert.equal(CAMELOT_TABLE['C# minor'], '12A');
  assert.equal(CAMELOT_TABLE['Db minor'], '12A');

  // All 12 major keys (B)
  assert.equal(CAMELOT_TABLE['B major'], '1B');
  assert.equal(CAMELOT_TABLE['F# major'], '2B');
  assert.equal(CAMELOT_TABLE['Gb major'], '2B');
  assert.equal(CAMELOT_TABLE['Db major'], '3B');
  assert.equal(CAMELOT_TABLE['C# major'], '3B');
  assert.equal(CAMELOT_TABLE['Ab major'], '4B');
  assert.equal(CAMELOT_TABLE['G# major'], '4B');
  assert.equal(CAMELOT_TABLE['Eb major'], '5B');
  assert.equal(CAMELOT_TABLE['D# major'], '5B');
  assert.equal(CAMELOT_TABLE['Bb major'], '6B');
  assert.equal(CAMELOT_TABLE['A# major'], '6B');
  assert.equal(CAMELOT_TABLE['F major'], '7B');
  assert.equal(CAMELOT_TABLE['C major'], '8B');
  assert.equal(CAMELOT_TABLE['G major'], '9B');
  assert.equal(CAMELOT_TABLE['D major'], '10B');
  assert.equal(CAMELOT_TABLE['A major'], '11B');
  assert.equal(CAMELOT_TABLE['E major'], '12B');
});

test('camelotOf parses all 24 keys, enharmonics, abbreviations, and returns null for unknown', () => {
  // Minor keys
  assert.equal(camelotOf('Ab minor'), '1A');
  assert.equal(camelotOf('G# minor'), '1A');
  assert.equal(camelotOf('Eb minor'), '2A');
  assert.equal(camelotOf('D# minor'), '2A');
  assert.equal(camelotOf('Bb minor'), '3A');
  assert.equal(camelotOf('A# minor'), '3A');
  assert.equal(camelotOf('F minor'), '4A');
  assert.equal(camelotOf('C minor'), '5A');
  assert.equal(camelotOf('G minor'), '6A');
  assert.equal(camelotOf('D minor'), '7A');
  assert.equal(camelotOf('A minor'), '8A');
  assert.equal(camelotOf('E minor'), '9A');
  assert.equal(camelotOf('B minor'), '10A');
  assert.equal(camelotOf('F# minor'), '11A');
  assert.equal(camelotOf('Gb minor'), '11A');
  assert.equal(camelotOf('C# minor'), '12A');
  assert.equal(camelotOf('Db minor'), '12A');

  // Major keys
  assert.equal(camelotOf('B major'), '1B');
  assert.equal(camelotOf('F# major'), '2B');
  assert.equal(camelotOf('Gb major'), '2B');
  assert.equal(camelotOf('Db major'), '3B');
  assert.equal(camelotOf('C# major'), '3B');
  assert.equal(camelotOf('Ab major'), '4B');
  assert.equal(camelotOf('G# major'), '4B');
  assert.equal(camelotOf('Eb major'), '5B');
  assert.equal(camelotOf('D# major'), '5B');
  assert.equal(camelotOf('Bb major'), '6B');
  assert.equal(camelotOf('A# major'), '6B');
  assert.equal(camelotOf('F major'), '7B');
  assert.equal(camelotOf('C major'), '8B');
  assert.equal(camelotOf('G major'), '9B');
  assert.equal(camelotOf('D major'), '10B');
  assert.equal(camelotOf('A major'), '11B');
  assert.equal(camelotOf('E major'), '12B');

  // Enharmonic edge names
  assert.equal(camelotOf('Cb major'), '1B');
  assert.equal(camelotOf('Cb minor'), '10A');
  assert.equal(camelotOf('Fb major'), '12B');
  assert.equal(camelotOf('Fb minor'), '9A');
  assert.equal(camelotOf('E# major'), '7B');
  assert.equal(camelotOf('E# minor'), '4A');
  assert.equal(camelotOf('B# major'), '8B');
  assert.equal(camelotOf('B# minor'), '5A');

  // Short forms and casing
  assert.equal(camelotOf('Am'), '8A');
  assert.equal(camelotOf('Amin'), '8A');
  assert.equal(camelotOf('C maj'), '8B');
  assert.equal(camelotOf('C'), '8B');
  assert.equal(camelotOf('f# minor'), '11A');
  assert.equal(camelotOf('BB MAJOR'), '6B');
  assert.equal(camelotOf('C♯ minor'), '12A');
  assert.equal(camelotOf('B♭ major'), '6B');

  // Direct Camelot input
  assert.equal(camelotOf('8A'), '8A');
  assert.equal(camelotOf('8a'), '8A');
  assert.equal(camelotOf('12B'), '12B');
  assert.equal(camelotOf(' 1b '), '1B');

  // Unknown / invalid
  assert.equal(camelotOf(''), null);
  assert.equal(camelotOf('   '), null);
  assert.equal(camelotOf('unknown'), null);
  assert.equal(camelotOf('H major'), null);
  assert.equal(camelotOf('13A'), null);
  assert.equal(camelotOf('0A'), null);
  assert.equal(camelotOf('0B'), null);
  assert.equal(camelotOf(null), null);
  assert.equal(camelotOf(undefined), null);
  assert.equal(camelotOf(123), null);
  assert.equal(camelotOf({}), null);
});

test('toPlannerSong extracts song fields with fallbacks and clamps taste', () => {
  assert.equal(toPlannerSong(null), null);
  assert.equal(toPlannerSong(undefined), null);
  assert.equal(toPlannerSong('not an object'), null);

  // bpm = 0 boundary tests (must be strictly > 0)
  assert.equal(toPlannerSong({ songKey: 'z1', djRhythm: { startBpm: 0 } }).tempo, null);
  assert.equal(toPlannerSong({ songKey: 'z2', djRhythm: { bpm: 0 } }).tempo, null);
  assert.equal(toPlannerSong({ songKey: 'z3', bpm: 0 }).tempo, null);

  // bpm = 1 boundary tests
  assert.equal(toPlannerSong({ songKey: 'b1', djRhythm: { startBpm: 1 } }).tempo, 1);
  assert.equal(toPlannerSong({ songKey: 'b2', djRhythm: { bpm: 1 } }).tempo, 1);
  assert.equal(toPlannerSong({ songKey: 'b3', bpm: 1 }).tempo, 1);

  const fullSong = {
    songKey: 'song-1',
    artist: 'Daft Punk',
    bpm: 120,
    musicalKey: 'C major',
    energy: 0.8,
    taste: 0.9,
    djRhythm: { startBpm: 123, bpm: 125 },
  };

  const p1 = toPlannerSong(fullSong);
  assert.equal(p1.id, 'song-1');
  assert.equal(p1.artist, 'Daft Punk');
  assert.equal(p1.tempo, 123);
  assert.equal(p1.camelot, '8B');
  assert.equal(p1.energy, 0.8);
  assert.equal(p1.taste, 0.9);

  // bpm fallback when startBpm is missing
  const songBpmFallback = {
    id: 'song-2',
    artist: 'Justice',
    bpm: 110,
    djRhythm: { bpm: 115 },
  };
  const p2 = toPlannerSong(songBpmFallback);
  assert.equal(p2.id, 'song-2');
  assert.equal(p2.tempo, 115);
  assert.equal(p2.taste, 0.5);

  // song.bpm fallback when djRhythm is missing
  const songPlainBpm = {
    songKey: 'song-3',
    bpm: 128,
  };
  assert.equal(toPlannerSong(songPlainBpm).tempo, 128);

  // overrides via options and taste clamping
  const p3 = toPlannerSong(fullSong, { energy: 0.3, taste: 1.5 });
  assert.equal(p3.energy, 0.3);
  assert.equal(p3.taste, 1.0);

  const p4 = toPlannerSong(fullSong, { taste: -0.2 });
  assert.equal(p4.taste, 0.0);

  const songWithTasteScore = { songKey: 'song-4', tasteScore: 0.75 };
  assert.equal(toPlannerSong(songWithTasteScore).taste, 0.75);

  // song key from getSongKey fallback
  const songWithArtistTrack = { artist: 'Artist X', track: 'Track Y' };
  assert.ok(toPlannerSong(songWithArtistTrack).id.length > 0);
});

test('planNextSet determinism, key extraction, and themes', () => {
  assert.equal(planNextSet(null), null);
  assert.equal(planNextSet({ source: null, ranked: [] }), null);
  assert.equal(planNextSet({ source: { songKey: 'src' }, ranked: [] }), null);
  assert.equal(planNextSet({ source: { songKey: 'src' }, ranked: null }), null);

  const source = {
    songKey: 'src',
    track: 'Intro Track',
    artist: 'Daft Punk',
    bpm: 120,
    musicalKey: 'C major',
    energy: 0.5,
  };

  const candidates = [
    { song: { songKey: 'c1', track: 'T1', artist: 'Daft Punk', bpm: 120, musicalKey: 'C major', energy: 0.52 }, contextualScore: 0.8 },
    { song: { songKey: 'c2', track: 'T2', artist: 'Daft Punk', bpm: 121, musicalKey: 'G major', energy: 0.55 }, contextualScore: 0.75 },
    { song: { songKey: 'c3', track: 'T3', artist: 'Daft Punk', bpm: 120, musicalKey: 'A minor', energy: 0.58 }, contextualScore: 0.7 },
    { song: { songKey: 'c4', track: 'T4', artist: 'Kavinsky', bpm: 122, musicalKey: 'F major', energy: 0.5 }, contextualScore: 0.65 },
  ];

  // Determinism with identical seed
  const planA = planNextSet({ source, ranked: candidates, count: 3, seed: 42 });
  const planB = planNextSet({ source, ranked: candidates, count: 3, seed: 42 });
  assert.ok(planA);
  assert.ok(planB);
  assert.deepEqual(planA.keys, planB.keys);
  assert.equal(planA.theme, planB.theme);
  assert.equal(planA.arc, planB.arc);

  // Artist theme: when >= 2 songs share artist Daft Punk
  assert.equal(planA.theme, 'Daft Punk');

  // Exclusion of candidate having same ID as source
  const sourceInRanked = [
    { song: source, contextualScore: 0.99 },
    ...candidates,
  ];
  const planExcludesSource = planNextSet({ source, ranked: sourceInRanked, count: 3, seed: 42 });
  assert.ok(!planExcludesSource.keys.includes('src'));

  // If all candidates are source, returns null
  assert.equal(planNextSet({ source, ranked: [{ song: source }] }), null);

  // Mood themes when artists are unique:
  const calmCandidates = [
    { song: { songKey: 'k1', artist: 'Artist 1', bpm: 120, musicalKey: 'C major', energy: 0.1 }, contextualScore: 0.8 },
    { song: { songKey: 'k2', artist: 'Artist 2', bpm: 120, musicalKey: 'C major', energy: 0.2 }, contextualScore: 0.8 },
    { song: { songKey: 'k3', artist: 'Artist 3', bpm: 120, musicalKey: 'C major', energy: 0.15 }, contextualScore: 0.8 },
  ];
  const calmSet = planNextSet({ source, ranked: calmCandidates, count: 3, seed: 10 });
  assert.equal(calmSet.theme, 'calm');

  const warmCandidates = [
    { song: { songKey: 'w1', artist: 'Artist 1', bpm: 120, musicalKey: 'C major', energy: 0.3 }, contextualScore: 0.8 },
    { song: { songKey: 'w2', artist: 'Artist 2', bpm: 120, musicalKey: 'C major', energy: 0.35 }, contextualScore: 0.8 },
    { song: { songKey: 'w3', artist: 'Artist 3', bpm: 120, musicalKey: 'C major', energy: 0.4 }, contextualScore: 0.8 },
  ];
  const warmSet = planNextSet({ source, ranked: warmCandidates, count: 3, seed: 10 });
  assert.equal(warmSet.theme, 'warm');

  const upbeatCandidates = [
    { song: { songKey: 'u1', artist: 'Artist 1', bpm: 120, musicalKey: 'C major', energy: 0.5 }, contextualScore: 0.8 },
    { song: { songKey: 'u2', artist: 'Artist 2', bpm: 120, musicalKey: 'C major', energy: 0.55 }, contextualScore: 0.8 },
    { song: { songKey: 'u3', artist: 'Artist 3', bpm: 120, musicalKey: 'C major', energy: 0.6 }, contextualScore: 0.8 },
  ];
  const upbeatSet = planNextSet({ source, ranked: upbeatCandidates, count: 3, seed: 10 });
  assert.equal(upbeatSet.theme, 'upbeat');

  const intenseCandidates = [
    { song: { songKey: 'i1', artist: 'Artist 1', bpm: 120, musicalKey: 'C major', energy: 0.7 }, contextualScore: 0.8 },
    { song: { songKey: 'i2', artist: 'Artist 2', bpm: 120, musicalKey: 'C major', energy: 0.8 }, contextualScore: 0.8 },
    { song: { songKey: 'i3', artist: 'Artist 3', bpm: 120, musicalKey: 'C major', energy: 0.9 }, contextualScore: 0.8 },
  ];
  const intenseSet = planNextSet({ source, ranked: intenseCandidates, count: 3, seed: 10 });
  assert.equal(intenseSet.theme, 'intense');

  // Boundaries for mean energy: 0.25 (warm, not calm), 0.45 (upbeat, not warm), 0.65 (intense, not upbeat)
  const b025Candidates = [
    { song: { songKey: 'b1', artist: 'A1', bpm: 120, musicalKey: 'C major', energy: 0.25 }, contextualScore: 0.8 },
    { song: { songKey: 'b2', artist: 'A2', bpm: 120, musicalKey: 'C major', energy: 0.25 }, contextualScore: 0.8 },
  ];
  assert.equal(planNextSet({ source, ranked: b025Candidates, count: 2, seed: 1 }).theme, 'warm');

  const b024Candidates = [
    { song: { songKey: 'b1', artist: 'A1', bpm: 120, musicalKey: 'C major', energy: 0.24 }, contextualScore: 0.8 },
    { song: { songKey: 'b2', artist: 'A2', bpm: 120, musicalKey: 'C major', energy: 0.24 }, contextualScore: 0.8 },
  ];
  assert.equal(planNextSet({ source, ranked: b024Candidates, count: 2, seed: 1 }).theme, 'calm');

  const b045Candidates = [
    { song: { songKey: 'b1', artist: 'A1', bpm: 120, musicalKey: 'C major', energy: 0.45 }, contextualScore: 0.8 },
    { song: { songKey: 'b2', artist: 'A2', bpm: 120, musicalKey: 'C major', energy: 0.45 }, contextualScore: 0.8 },
  ];
  assert.equal(planNextSet({ source, ranked: b045Candidates, count: 2, seed: 1 }).theme, 'upbeat');

  const b044Candidates = [
    { song: { songKey: 'b1', artist: 'A1', bpm: 120, musicalKey: 'C major', energy: 0.44 }, contextualScore: 0.8 },
    { song: { songKey: 'b2', artist: 'A2', bpm: 120, musicalKey: 'C major', energy: 0.44 }, contextualScore: 0.8 },
  ];
  assert.equal(planNextSet({ source, ranked: b044Candidates, count: 2, seed: 1 }).theme, 'warm');

  const b065Candidates = [
    { song: { songKey: 'b1', artist: 'A1', bpm: 120, musicalKey: 'C major', energy: 0.65 }, contextualScore: 0.8 },
    { song: { songKey: 'b2', artist: 'A2', bpm: 120, musicalKey: 'C major', energy: 0.65 }, contextualScore: 0.8 },
  ];
  assert.equal(planNextSet({ source, ranked: b065Candidates, count: 2, seed: 1 }).theme, 'intense');

  const b064Candidates = [
    { song: { songKey: 'b1', artist: 'A1', bpm: 120, musicalKey: 'C major', energy: 0.64 }, contextualScore: 0.8 },
    { song: { songKey: 'b2', artist: 'A2', bpm: 120, musicalKey: 'C major', energy: 0.64 }, contextualScore: 0.8 },
  ];
  assert.equal(planNextSet({ source, ranked: b064Candidates, count: 2, seed: 1 }).theme, 'upbeat');

  // When no songs in candidate list have energy, mean energy defaults to 0.5 -> upbeat
  const noEnergyCandidates = [
    { song: { songKey: 'ne1', artist: 'A1', bpm: 120, musicalKey: 'C major', energy: null }, contextualScore: 0.8 },
    { song: { songKey: 'ne2', artist: 'A2', bpm: 120, musicalKey: 'C major', energy: null }, contextualScore: 0.8 },
  ];
  assert.equal(planNextSet({ source, ranked: noEnergyCandidates, count: 2, seed: 1 }).theme, 'upbeat');

  // count boundary: count = 1 plans a 1-song set
  const count1Set = planNextSet({ source, ranked: candidates, count: 1, seed: 1 });
  assert.ok(count1Set);
  assert.equal(count1Set.keys.length, 1);

  // count boundary: count = 0 falls back to default 4
  const count0Set = planNextSet({ source, ranked: candidates, count: 0, seed: 1 });
  assert.ok(count0Set);
  assert.equal(count0Set.keys.length, 4);

  // Top 60 pool cap: 61st song is never picked
  const manyCandidates = Array.from({ length: 65 }, (_, i) => ({
    song: { songKey: `cand-${i}`, track: `T${i}`, artist: `Artist ${i}`, bpm: 120, musicalKey: 'C major', energy: 0.5 },
    contextualScore: 0.9 - i * 0.01,
  }));
  const setMany = planNextSet({ source, ranked: manyCandidates, count: 4, seed: 1 });
  assert.ok(setMany);
  assert.ok(!setMany.keys.includes('cand-60'));
  assert.ok(!setMany.keys.includes('cand-64'));

  // count from rng when count omitted
  const setRng3 = planNextSet({ source, ranked: candidates, rng: () => 0.0, seed: 1 });
  assert.equal(setRng3.keys.length, 3);
  const setRng5 = planNextSet({ source, ranked: candidates, rng: () => 0.99, seed: 1 });
  assert.equal(setRng5.keys.length, 4); // pool has only 4 candidates

  // seed from rng when seed omitted
  const setSeedRng = planNextSet({ source, ranked: candidates, count: 3, rng: () => 0.42 });
  assert.ok(setSeedRng);

  // plannedAt respects now as function, number, or default
  const fixedNow = 1788854400000;
  assert.equal(planNextSet({ source, ranked: candidates, count: 3, seed: 1, now: () => fixedNow }).plannedAt, fixedNow);
  assert.equal(planNextSet({ source, ranked: candidates, count: 3, seed: 1, now: fixedNow }).plannedAt, fixedNow);
  assert.ok(Number.isFinite(planNextSet({ source, ranked: candidates, count: 3, seed: 1 }).plannedAt));
});

test('nextFromSet returns next planned key or first if not in set, and null when used up', () => {
  assert.equal(nextFromSet(null, 'any'), null);
  assert.equal(nextFromSet({}, 'any'), null);
  assert.equal(nextFromSet({ keys: [] }, 'any'), null);

  const set = { keys: ['song-a', 'song-b', 'song-c'] };

  // When current song is not in the set (e.g. source song before the set starts):
  assert.equal(nextFromSet(set, 'source-song'), 'song-a');
  assert.equal(nextFromSet(set, null), 'song-a');
  assert.equal(nextFromSet(set, undefined), 'song-a');
  assert.equal(nextFromSet(set, ''), 'song-a');

  // Following the set:
  assert.equal(nextFromSet(set, 'song-a'), 'song-b');
  assert.equal(nextFromSet(set, 'song-b'), 'song-c');

  // Set is used up after the last track:
  assert.equal(nextFromSet(set, 'song-c'), null);
});

test('factsFor populates all fields correctly including all boundary conditions', () => {
  assert.deepEqual(factsFor(null), {});

  const outgoing = {
    songKey: 'out-1',
    artist: 'Outgoing Artist',
    track: 'Outgoing Track',
    bpm: 120,
    musicalKey: '8A', // A minor
    energy: 0.4,
  };

  const incoming = {
    songKey: 'in-1',
    artist: 'Incoming Artist',
    track: 'Incoming Track',
    bpm: 120,
    musicalKey: '8B', // C major (relative!)
    energy: 0.6,
  };

  const set = {
    theme: 'Summer Run',
    count: 4,
    keys: ['in-1', 'in-2', 'in-3', 'in-4'],
  };

  const nowMs = new Date('2026-10-01T10:00:00Z').getTime();
  const history = new Map([
    ['in-1', { playCount: 5, lastPlayedAt: nowMs - 3 * 86400000 }],
  ]);

  const facts = factsFor({
    outgoing,
    incoming,
    set,
    mix: { tempoRatio: 1.01 },
    history,
    now: new Date(nowMs),
  });

  assert.equal(facts.artist, 'Incoming Artist');
  assert.equal(facts.title, 'Incoming Track');
  assert.equal(facts.prevArtist, 'Outgoing Artist');
  assert.equal(facts.prevTitle, 'Outgoing Track');
  assert.equal(facts.theme, 'Summer Run');
  assert.equal(facts.count, 4);
  assert.equal(facts.playCount, 5);
  assert.equal(facts.firstTime, false);
  assert.equal(facts.lastPlayedDaysAgo, 3);
  assert.equal(facts.tempoRelation, 'same'); // 1.01 is within 1.5%
  assert.equal(facts.keyRelation, 'relative'); // 8A vs 8B is relative
  assert.equal(facts.mood, 'upbeat'); // 0.6 is < 0.65 upbeat

  // First time play (when playCount is 0 or absent)
  const factsFirst = factsFor({
    outgoing,
    incoming: { ...incoming, songKey: 'brand-new' },
    set,
    history,
    now: new Date(nowMs),
  });
  assert.equal(factsFirst.firstTime, true);
  assert.equal(factsFirst.playCount, 0);
  assert.equal(factsFirst.lastPlayedDaysAgo, null);

  // History as plain object and played today (0 days ago)
  const factsObjHist = factsFor({
    outgoing,
    incoming,
    set,
    history: { 'in-1': { playCount: 2, lastPlayedAt: nowMs } },
    now: new Date(nowMs),
  });
  assert.equal(factsObjHist.playCount, 2);
  assert.equal(factsObjHist.firstTime, false);
  assert.equal(factsObjHist.lastPlayedDaysAgo, 0);

  // Incoming with only id or only artist/track
  assert.equal(factsFor({ incoming: { id: 'only-id' }, history: { 'only-id': { playCount: 7 } } }).playCount, 7);
  assert.equal(factsFor({ incoming: { artist: 'Artist Only', track: 'Track Only' } }).firstTime, true);

  // Tempo relation boundaries:
  // Isolate mix.tempoRatio (native tempos are completely different: 100 vs 150)
  const outDistantTempo = { bpm: 100 };
  const inDistantTempo = { bpm: 150 };

  // 1) mix tempo ratio within 1.5% of 1:
  assert.equal(factsFor({ outgoing: outDistantTempo, incoming: inDistantTempo, mix: { tempoRatio: 1.015 } }).tempoRelation, 'same');
  assert.equal(factsFor({ outgoing: outDistantTempo, incoming: inDistantTempo, mix: { tempoRatio: 1.0151 } }).tempoRelation, 'faster');
  assert.equal(factsFor({ outgoing: outDistantTempo, incoming: inDistantTempo, mix: { tempoRatio: 0.985 } }).tempoRelation, 'same');
  assert.equal(factsFor({ outgoing: outDistantTempo, incoming: inDistantTempo, mix: { tempoRatio: 0.9849 } }).tempoRelation, 'faster'); // inTempo 150 > outTempo 100

  const outFaster = { bpm: 150 };
  const inSlower = { bpm: 100 };
  assert.equal(factsFor({ outgoing: outFaster, incoming: inSlower, mix: { tempoRatio: 0.9849 } }).tempoRelation, 'slower');

  // 2) native tempos within 2% (no mix ratio):
  assert.equal(factsFor({ outgoing: { bpm: 100 }, incoming: { bpm: 102 } }).tempoRelation, 'same'); // exactly 2%
  assert.equal(factsFor({ outgoing: { bpm: 100 }, incoming: { bpm: 102.1 } }).tempoRelation, 'faster'); // > 2%
  assert.equal(factsFor({ outgoing: { bpm: 100 }, incoming: { bpm: 98 } }).tempoRelation, 'same'); // exactly 2%
  assert.equal(factsFor({ outgoing: { bpm: 100 }, incoming: { bpm: 97.9 } }).tempoRelation, 'slower'); // > 2%
  assert.equal(factsFor({ outgoing: { bpm: 100 }, incoming: { bpm: 100 } }).tempoRelation, 'same');

  // Partial key: keyRelation undefined when only one track has musicalKey
  assert.equal(factsFor({ outgoing: { musicalKey: '8A' }, incoming: {} }).keyRelation, undefined);
  assert.equal(factsFor({ outgoing: {}, incoming: { musicalKey: '8A' } }).keyRelation, undefined);

  // Partial tempo: tempoRelation undefined when only one track has bpm
  assert.equal(factsFor({ outgoing: { bpm: 120 }, incoming: {} }).tempoRelation, undefined);
  assert.equal(factsFor({ outgoing: {}, incoming: { bpm: 120 } }).tempoRelation, undefined);

  // Key relation cases:
  // same:
  assert.equal(factsFor({ outgoing: { musicalKey: '8A' }, incoming: { musicalKey: '8A' } }).keyRelation, 'same');
  // relative:
  assert.equal(factsFor({ outgoing: { musicalKey: '8A' }, incoming: { musicalKey: '8B' } }).keyRelation, 'relative');
  assert.equal(factsFor({ outgoing: { musicalKey: '12B' }, incoming: { musicalKey: '12A' } }).keyRelation, 'relative');
  // neighbour:
  assert.equal(factsFor({ outgoing: { musicalKey: '8A' }, incoming: { musicalKey: '7A' } }).keyRelation, 'neighbour');
  assert.equal(factsFor({ outgoing: { musicalKey: '8A' }, incoming: { musicalKey: '9A' } }).keyRelation, 'neighbour');
  assert.equal(factsFor({ outgoing: { musicalKey: '12A' }, incoming: { musicalKey: '1A' } }).keyRelation, 'neighbour');
  assert.equal(factsFor({ outgoing: { musicalKey: '1B' }, incoming: { musicalKey: '12B' } }).keyRelation, 'neighbour');
  // clash:
  assert.equal(factsFor({ outgoing: { musicalKey: '8A' }, incoming: { musicalKey: '7B' } }).keyRelation, 'clash');
  assert.equal(factsFor({ outgoing: { musicalKey: '8A' }, incoming: { musicalKey: '10A' } }).keyRelation, 'clash');
  assert.equal(factsFor({ outgoing: { musicalKey: '8A' }, incoming: { musicalKey: '2A' } }).keyRelation, 'clash');

  // Mood from incoming energy boundaries:
  assert.equal(factsFor({ incoming: { energy: 0.24 } }).mood, 'calm');
  assert.equal(factsFor({ incoming: { energy: 0.25 } }).mood, 'warm');
  assert.equal(factsFor({ incoming: { energy: 0.44 } }).mood, 'warm');
  assert.equal(factsFor({ incoming: { energy: 0.45 } }).mood, 'upbeat');
  assert.equal(factsFor({ incoming: { energy: 0.64 } }).mood, 'upbeat');
  assert.equal(factsFor({ incoming: { energy: 0.65 } }).mood, 'intense');
  assert.equal(factsFor({ incoming: { energy: 0.95 } }).mood, 'intense');

  // Time of day boundaries:
  // morning: 5-12 [5, 12)
  // afternoon: 12-17 [12, 17)
  // evening: 17-22 [17, 22)
  // else: late-night [22, 24) and [0, 5)
  const makeDateWithHour = (h) => {
    const d = new Date();
    d.setHours(h, 0, 0, 0);
    return d;
  };
  assert.equal(factsFor({ now: makeDateWithHour(4) }).timeOfDay, 'late-night');
  assert.equal(factsFor({ now: makeDateWithHour(5) }).timeOfDay, 'morning');
  assert.equal(factsFor({ now: makeDateWithHour(11) }).timeOfDay, 'morning');
  assert.equal(factsFor({ now: makeDateWithHour(12) }).timeOfDay, 'afternoon');
  assert.equal(factsFor({ now: makeDateWithHour(16) }).timeOfDay, 'afternoon');
  assert.equal(factsFor({ now: makeDateWithHour(17) }).timeOfDay, 'evening');
  assert.equal(factsFor({ now: makeDateWithHour(21) }).timeOfDay, 'evening');
  assert.equal(factsFor({ now: makeDateWithHour(22) }).timeOfDay, 'late-night');
  assert.equal(factsFor({ now: makeDateWithHour(23) }).timeOfDay, 'late-night');
  assert.equal(factsFor({ now: makeDateWithHour(0) }).timeOfDay, 'late-night');
});

test('shouldSpeak rules with scripted rng and window duration checks', () => {
  assert.equal(shouldSpeak(null), false);

  // Instrumental window from outgoing outroBars:
  // Default 2s per bar: 2 bars = 4.0s (sufficient)
  const outgoing4s = { djRhythm: { outroBars: 2 } };
  // Default 2s per bar: 1.9 bars = 3.8s (< 4s, insufficient)
  const outgoing38s = { djRhythm: { outroBars: 1.9 } };
  // Default 2s per bar: 1 bar = 2.0s (< 4s, insufficient)
  const outgoing2s = { djRhythm: { outroBars: 1 } };

  // Instrumental window from incoming introEnd seconds:
  const incoming4s = { djRhythm: { introEnd: 4.0 } };
  const incoming39s = { djRhythm: { introEnd: 3.99 } };

  // Window from beat grid bar length:
  // 120 bpm, 4 beats/bar -> 2s/bar. 2 bars = 4s.
  const outgoingGrid4s = { djRhythm: { outroBars: 2, bpm: 120, barBeats: 4 } };
  // 150 bpm, 4 beats/bar -> 1.6s/bar. 2 bars = 3.2s (< 4s).
  const outgoingGridShort = { djRhythm: { outroBars: 2, bpm: 150, barBeats: 4 } };
  // 150 bpm, 4 beats/bar -> 1.6s/bar. 3 bars = 4.8s (>= 4s).
  const outgoingGridLong = { djRhythm: { outroBars: 3, bpm: 150, barBeats: 4 } };

  // Never speak when there is no mix window of at least 4s:
  assert.equal(shouldSpeak({ kind: 'set-intro', outgoing: { djRhythm: { outroBars: 0 } }, incoming: { djRhythm: { introEnd: 1 } } }), false);
  assert.equal(shouldSpeak({ kind: 'set-intro', outgoing: { djRhythm: { outroBars: -1 } }, incoming: { djRhythm: { introEnd: 0 } } }), false);
  assert.equal(shouldSpeak({ kind: 'set-intro', outgoing: outgoing38s, incoming: incoming39s }), false);
  assert.equal(shouldSpeak({ kind: 'set-intro', outgoing: outgoing2s, incoming: incoming39s }), false);
  assert.equal(shouldSpeak({ kind: 'set-intro', outgoing: outgoingGridShort, incoming: incoming39s }), false);
  assert.equal(shouldSpeak({ kind: 'link', outgoing: outgoing2s, incoming: incoming39s, rng: () => 0.1 }), false);
  assert.equal(shouldSpeak({ kind: 'set-intro', outgoing: {}, incoming: {} }), false);

  // set-intro is always allowed when window >= 4s:
  assert.equal(shouldSpeak({ kind: 'set-intro', outgoing: { outroBars: 2 }, incoming: {} }), true); // 2 * default 2s = 4s
  assert.equal(shouldSpeak({ kind: 'set-intro', outgoing: outgoing4s, incoming: incoming39s }), true);
  assert.equal(shouldSpeak({ kind: 'set-intro', outgoing: outgoing2s, incoming: incoming4s }), true);
  assert.equal(shouldSpeak({ kind: 'set-intro', outgoing: outgoingGrid4s, incoming: {} }), true);
  assert.equal(shouldSpeak({ kind: 'set-intro', outgoing: outgoingGridLong, incoming: {} }), true);

  // link allows speech with probability 0.35:
  // Scripted rng returning 0.349 (< 0.35) -> true
  assert.equal(shouldSpeak({ kind: 'link', outgoing: outgoing4s, incoming: {}, rng: () => 0.349 }), true);
  assert.equal(shouldSpeak({ kind: 'link', outgoing: outgoing4s, incoming: {}, rng: () => 0.0 }), true);

  // Scripted rng returning 0.35 (not < 0.35) -> false
  assert.equal(shouldSpeak({ kind: 'link', outgoing: outgoing4s, incoming: {}, rng: () => 0.35 }), false);
  // Scripted rng returning 0.351 (> 0.35) -> false
  assert.equal(shouldSpeak({ kind: 'link', outgoing: outgoing4s, incoming: {}, rng: () => 0.351 }), false);
  assert.equal(shouldSpeak({ kind: 'link', outgoing: outgoing4s, incoming: {}, rng: () => 0.99 }), false);

  // Unknown kind returns false even with window
  assert.equal(shouldSpeak({ kind: 'other', outgoing: outgoing4s, incoming: {} }), false);
});
