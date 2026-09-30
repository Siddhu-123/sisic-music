import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TASTE_PASSPORT_SCHEMA,
  blendTastePassports,
  buildTastePassport,
  parseTastePassport,
  scoreLibraryWithPassport,
  validateTastePassport,
} from './tastePassportService.js';
import { dot } from './tasteInterests.js';

const DIMS = 200;
const MODEL = 'msd-musicnn-1';
const GENRES = ['Rock', 'Jazz', 'Classical'];
const NOW = Date.parse('2026-09-30T20:00:00Z');

function audioVector(group, seed) {
  const vector = new Array(DIMS).fill(0);
  vector[group * 8] = 1;
  for (let d = 0; d < DIMS; d++) vector[d] += Math.sin((d + 1) * (seed + 1.3)) * 0.03;
  const norm = Math.hypot(...vector);
  return vector.map(value => value / norm);
}

const makeSong = (group, i, prefix = 'g') => ({
  songKey: `artist ${group}::${prefix}${group}-${i}`,
  track: `${prefix}${group}-${i}`,
  artist: `Artist ${group}`,
  album: `Album ${group}`,
  genre: GENRES[group],
  driveFileId: 'secret-drive-id',
  vector: audioVector(group, i),
  vectorType: 'learned-audio',
  model: MODEL,
  dimensions: DIMS,
});

const library = [
  ...Array.from({ length: 12 }, (_, i) => makeSong(0, i)),
  ...Array.from({ length: 10 }, (_, i) => makeSong(1, i)),
  ...Array.from({ length: 8 }, (_, i) => makeSong(2, i)),
];

function listen(songs) {
  const events = [];
  let time = NOW - (24 * 3600 * 1000);
  songs.forEach((song, index) => {
    const context = { timeBucket: 'evening', hour: 20 };
    const base = { songKey: song.songKey, sessionId: `s${Math.floor(index / 5)}`, context, durationSeconds: 180 };
    events.push({ ...base, eventType: 'playback-start', createdAt: new Date(time).toISOString(), positionSeconds: 0 });
    events.push({ ...base, eventType: 'playback-complete', createdAt: new Date(time + 180000).toISOString(), positionSeconds: 180 });
    time += 240000;
  });
  return events;
}

const passportFor = groups => buildTastePassport({
  songs: library,
  playbackEvents: listen(library.filter(song => groups.some(group => song.songKey.startsWith(`artist ${group}::`)))),
  now: NOW,
});
const audioSpace = passport => passport.spaces.find(space => space.vectorType === 'learned-audio');

test('a passport carries an interoperable audio space, a labelled private metadata space, interests and anchors', () => {
  const passport = passportFor([0, 1]);
  assert.equal(passport.schema, TASTE_PASSPORT_SCHEMA);
  const audio = audioSpace(passport);
  const metadata = passport.spaces.find(space => space.vectorType === 'metadata');
  assert.equal(audio.id, `learned-audio:${MODEL}:${DIMS}`);
  assert.equal(audio.interoperable, true);
  assert.equal(metadata.interoperable, false);
  assert.equal(audio.interests.length, 2);
  assert.ok(audio.interests.every(interest => interest.label && interest.weight > 0));
  assert.ok(Math.abs(audio.interests.reduce((sum, interest) => sum + interest.weight, 0) - 1) < 1e-3);
  assert.ok(audio.contexts.evening && audio.contexts.evening.sessions >= 1);

  assert.equal(passport.anchors.liked[0].weight, 1);
  assert.ok(passport.anchors.liked.every(anchor => anchor.weight > 0 && anchor.weight <= 1 && anchor.key && anchor.title));
  assert.ok(passport.anchors.liked.every(anchor => !anchor.key.includes('::g2-')), 'never-played songs are not anchors');
  assert.ok(passport.descriptors.genres.some(item => item.label === 'Rock'));
  assert.ok(!passport.descriptors.genres.some(item => item.label === 'Classical'));
});

test('a passport never leaks file ids, timestamps of plays or raw play logs', () => {
  const json = JSON.stringify(passportFor([0, 1]));
  assert.ok(!json.includes('secret-drive-id'));
  assert.ok(!json.includes('driveFileId'));
  assert.ok(!json.includes('playback-start'));
  assert.ok(!json.includes('sessionId'));
  assert.ok(!/2026-09-29/.test(json), 'no play-time timestamps');
});

test('passports survive a JSON round trip unchanged', () => {
  const passport = passportFor([0, 1]);
  const parsed = parseTastePassport(JSON.stringify(passport));
  assert.equal(parsed.ok, true, parsed.errors.join('; '));
  assert.deepEqual(audioSpace(parsed.passport).interests.map(i => i.label), audioSpace(passport).interests.map(i => i.label));
  assert.ok(dot(audioSpace(parsed.passport).longTerm, audioSpace(passport).longTerm) > 0.9999);
  assert.deepEqual(parsed.passport.anchors.liked.map(a => a.key), passport.anchors.liked.map(a => a.key));
});

test('hostile or damaged files are rejected or cleaned, never trusted', () => {
  const good = passportFor([0, 1]);
  assert.equal(validateTastePassport(null).ok, false);
  assert.equal(validateTastePassport([]).ok, false);
  assert.equal(validateTastePassport({ ...good, schema: 'spotify.export' }).ok, false);
  assert.equal(validateTastePassport({ ...good, version: 99 }).ok, false);
  assert.match(validateTastePassport({ ...good, version: 99 }).errors[0], /version 99/);
  assert.equal(parseTastePassport('{not json').ok, false);
  assert.equal(parseTastePassport('x'.repeat(3 * 1024 * 1024)).ok, false);

  // A vector of the wrong length is dropped, not padded or truncated.
  const wrong = structuredClone(good);
  audioSpace(wrong).longTerm = audioSpace(wrong).longTerm.slice(0, 50);
  const cleaned = validateTastePassport(wrong);
  assert.equal(cleaned.ok, true);
  assert.ok(!cleaned.passport.spaces.some(space => space.vectorType === 'learned-audio'));
  assert.ok(cleaned.errors.length >= 1);

  // Non-finite numbers (JSON null) and huge lists are cleaned; unknown keys are not copied.
  const dirty = structuredClone(good);
  audioSpace(dirty).interests[0].vector[3] = null;
  dirty.anchors.liked = Array.from({ length: 5000 }, (_, i) => ({ key: `k${i}`, title: 'x'.repeat(5000), weight: 0.5 }));
  dirty.extra = { payload: '<script>alert(1)</script>' };
  // A literal "__proto__" key, as an attacker would write it in the file.
  const hostileText = JSON.stringify(dirty).replace('{', '{"__proto__":{"isAdmin":true},"constructor":{"prototype":{"polluted":true}},');
  assert.equal(parseTastePassport(hostileText).ok, false, 'a 25 MB file is refused before parsing');
  // JSON.parse keeps "__proto__" as a plain own key, exactly what the validator must not copy.
  const result = validateTastePassport(JSON.parse(hostileText));
  assert.equal(result.ok, true);
  assert.equal(Object.getPrototypeOf(result.passport), Object.prototype);
  assert.equal(result.passport.isAdmin, undefined);
  assert.ok(!Object.keys(result.passport).includes('__proto__') && !Object.keys(result.passport).includes('constructor'));
  assert.equal(({}).polluted, undefined);
  assert.equal(audioSpace(result.passport).interests.length, audioSpace(good).interests.length - 1);
  assert.equal(result.passport.anchors.liked.length, 200);
  assert.equal(result.passport.anchors.liked[0].title.length, 160);
  assert.equal(result.passport.extra, undefined);
  assert.equal(({}).isAdmin, undefined);

  assert.equal(validateTastePassport({ schema: TASTE_PASSPORT_SCHEMA, version: 1, spaces: [], anchors: {}, descriptors: {} }).ok, false);
});

test('blending mixes shared spaces, drops unshared ones and keeps anchors from both people', () => {
  const rock = passportFor([0]);
  const jazz = passportFor([1]);
  const blended = blendTastePassports(rock, jazz);
  const space = audioSpace(blended);
  assert.equal(space.interests.length, 2, 'both people\'s tastes survive as separate interests');
  assert.ok(dot(space.longTerm, audioSpace(rock).longTerm) > 0.5);
  assert.ok(dot(space.longTerm, audioSpace(jazz).longTerm) > 0.5);
  assert.ok(blended.anchors.liked.some(a => a.key.includes('::g0-')) && blended.anchors.liked.some(a => a.key.includes('::g1-')));
  assert.ok(blended.descriptors.genres.some(g => g.label === 'Rock') && blended.descriptors.genres.some(g => g.label === 'Jazz'));

  // A different embedding model is a different space: never blended, anchors still are.
  const foreign = structuredClone(jazz);
  audioSpace(foreign).model = 'other-model-9';
  audioSpace(foreign).id = `learned-audio:other-model-9:${DIMS}`;
  const partial = blendTastePassports(rock, foreign);
  assert.ok(!partial.spaces.some(s => s.vectorType === 'learned-audio'));
  assert.ok(partial.anchors.liked.some(a => a.key.includes('::g1-')));
  assert.equal(partial.spaces.filter(s => s.vectorType === 'metadata').length, 1);

  // What one person avoids is dropped when the other actively likes it.
  const withAvoid = structuredClone(rock);
  withAvoid.anchors.avoided = [{ ...jazz.anchors.liked[0], weight: 1 }];
  assert.ok(!blendTastePassports(withAvoid, jazz).anchors.avoided.some(a => a.key === jazz.anchors.liked[0].key));
});

const unplayed = [
  ...Array.from({ length: 6 }, (_, i) => makeSong(0, 100 + i, 'new')),
  ...Array.from({ length: 6 }, (_, i) => makeSong(1, 100 + i, 'new')),
  ...Array.from({ length: 6 }, (_, i) => makeSong(2, 100 + i, 'new')),
].map((song, i) => ({ ...song, artist: `Fresh Artist ${i}` }));

test('ranking with a passport uses the shared audio space and finds the owner\'s taste', () => {
  const ranked = scoreLibraryWithPassport(passportFor([0]), [...library, ...unplayed], { limit: 6, excludeSongKeys: library.map(s => s.songKey) });
  assert.equal(ranked.mode, 'audio-space');
  assert.equal(ranked.songs.length, 6);
  assert.ok(ranked.songs.every(song => song.songKey.includes('new0-')), 'only rock-like songs in the top six');
});

test('a two-interest passport surfaces both tastes and skips the third', () => {
  const ranked = scoreLibraryWithPassport(passportFor([0, 1]), unplayed, { limit: 12 });
  const groups = new Set(ranked.songs.slice(0, 10).map(song => song.songKey.match(/new(\d)-/)[1]));
  assert.ok(groups.has('0') && groups.has('1'));
  assert.ok(!ranked.songs.slice(0, 8).some(song => song.songKey.includes('new2-')));
});

test('with no shared sound space, anchor tracks carry the taste across', () => {
  const passport = passportFor([0]);
  const foreign = structuredClone(passport);
  foreign.spaces = [];
  const ranked = scoreLibraryWithPassport(foreign, [...library, ...unplayed], { limit: 5, excludeSongKeys: library.map(s => s.songKey) });
  assert.equal(ranked.mode, 'anchors');
  assert.match(ranked.explanation, /anchor tracks found/);
  assert.equal(ranked.songs.length, 5);
});

test('with only descriptors, ranking still works and says so; with nothing it declines honestly', () => {
  const onlyGenres = { ...passportFor([0]), spaces: [], anchors: { liked: [], avoided: [] } };
  const ranked = scoreLibraryWithPassport(onlyGenres, unplayed, { limit: 6 });
  assert.equal(ranked.mode, 'descriptors');
  assert.ok(ranked.songs.slice(0, 3).every(song => song.genre === 'Rock'));

  const empty = { ...onlyGenres, descriptors: { genres: [], moods: [], artists: [] } };
  assert.equal(scoreLibraryWithPassport(empty, unplayed).mode, 'none');
  assert.deepEqual(scoreLibraryWithPassport(null, unplayed).songs, []);
});

test('a blend shares mix slots between both people instead of front-loading the bigger taste', () => {
  const mine = passportFor([0, 1]);
  const friend = passportFor([2]);
  const blended = blendTastePassports(mine, friend);
  // 12 rock vs 10 jazz songs make my own split 55/45, so the blend is ~27/23 plus 50 from the friend.
  const weights = audioSpace(blended).interests.map(i => i.weight).sort((x, y) => x - y);
  assert.equal(weights.length, 3);
  assert.ok(Math.abs(weights[2] - 0.5) < 0.01 && Math.abs(weights[0] + weights[1] - 0.5) < 0.01);

  const genreOfKey = song => ['Rock', 'Jazz', 'Classical'][Number(song.songKey.match(/new(\d)-/)[1])];
  const mix = scoreLibraryWithPassport(blended, unplayed, { limit: 8 });
  const first6 = mix.songs.slice(0, 6).map(genreOfKey);
  assert.ok(['Rock', 'Jazz', 'Classical'].every(genre => first6.includes(genre)), `first six should include everyone's taste, got ${first6}`);
  const classical = mix.songs.map(genreOfKey).filter(genre => genre === 'Classical').length;
  assert.equal(classical, 4, 'the 50% interest gets half of the eight slots');
});

test('the two-songs-per-artist cap holds when a mix is interleaved across interests', () => {
  const ranked = scoreLibraryWithPassport(passportFor([0, 1]), library, { limit: 6 });
  assert.equal(ranked.songs.length, 6);
  const counts = new Map();
  ranked.songs.forEach(song => counts.set(song.artist, (counts.get(song.artist) || 0) + 1));
  assert.ok([...counts.values()].every(count => count <= 2), `artist counts: ${JSON.stringify([...counts])}`);
});
