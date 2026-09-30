// Taste Passport: a portable, user-owned summary of musical taste.
//
// Design (see docs/TASTE_PASSPORT.md):
//  * User and track embeddings are decoupled (Hansen et al., RecSys 2020), so the
//    passport carries the user side and any platform brings its own tracks.
//  * Taste is several interests, not one blurred centroid (PinnerSage, MIND), plus
//    per-time-of-day vectors that start from long-term taste (CoSeRNN).
//  * Vectors only mean something inside one embedding space, so the passport has
//    three layers, from strictest to most portable:
//      1. spaces      vectors in a named model space (usable when the model matches)
//      2. anchors     weighted exemplar tracks, identified by artist/title, which any
//                     platform can re-embed with its own model
//      3. descriptors genre / mood / artist affinities, a coarse fallback
//  * Nothing here is a play log: no timestamps, no Drive ids, no file names.

import { getSongKey } from '../songIdentity.js';
import {
  areVectorSpacesCompatible,
  buildContextualTasteProfile,
  resolveEmbeddingMetadata,
  validateAndNormalizeVector,
} from './contextualRecommendationService.js';
import { chooseGalaxySpace, labelCluster } from './galaxyService.js';
import { getSongGenres, getSongMoods } from './exploreService.js';
import { EMBEDDING_DIMENSIONS, METADATA_EMBEDDING_MODEL, getSongEmbedding } from './tasteEmbeddingService.js';
import { buildInterests, dot, interestAffinity, unit } from './tasteInterests.js';

export const TASTE_PASSPORT_SCHEMA = 'sisic.taste-passport';
export const TASTE_PASSPORT_VERSION = 1;
export const TASTE_PASSPORT_MAX_BYTES = 2 * 1024 * 1024;

const TIME_BUCKETS = ['morning', 'afternoon', 'evening', 'night'];
const VECTOR_TYPES = ['learned-audio', 'metadata'];
const GENERIC_LABELS = new Set(['Open format', 'Discovery']);
const LIMITS = { spaces: 6, interests: 8, contexts: 4, likedAnchors: 200, avoidedAnchors: 100, descriptors: 30, dimensions: 4096 };

const round = value => Number(value.toFixed(5));
const roundVector = vector => vector.map(round);
const text = (value, max = 160) => String(value ?? '').replace(/\p{Cc}/gu, ' ').trim().slice(0, max);
const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);

export function passportSpaceId({ vectorType, model, dimensions }) {
  return `${vectorType}:${model}:${dimensions}`;
}

// The learned-audio model is only interoperable when it is a named, public one.
// The metadata space is a hashing scheme private to this app, so it is labelled as such.
function isInteroperable({ vectorType, model }) {
  return vectorType === 'learned-audio' && Boolean(model) && model !== 'unknown-audio-model';
}

function normaliseWeights(entries, max) {
  const top = entries.filter(entry => entry.weight > 0).sort((a, b) => b.weight - a.weight).slice(0, max);
  const total = top.reduce((sum, entry) => sum + entry.weight, 0);
  return total ? top.map(entry => ({ ...entry, weight: round(entry.weight / total) })) : [];
}

function tally(map, label, weight) {
  if (!label || GENERIC_LABELS.has(label)) return;
  map.set(label, (map.get(label) || 0) + weight);
}

function buildDescriptors(entries) {
  const genres = new Map();
  const moods = new Map();
  const artists = new Map();
  for (const { song, net } of entries) {
    for (const label of getSongGenres(song)) tally(genres, label, net);
    for (const label of getSongMoods(song)) tally(moods, label, net);
    tally(artists, text(String(song.artist || '').split(/\s*(?:,|&|\bfeat\.?|\bft\.?)\s*/i)[0], 80), net);
  }
  const listOf = (map, max) => normaliseWeights([...map.entries()].map(([label, weight]) => ({ label, weight })), max);
  return { genres: listOf(genres, 8), moods: listOf(moods, 8), artists: listOf(artists, 15) };
}

function anchorRecord(song, weight) {
  return {
    key: getSongKey(song),
    artist: text(song.artist),
    title: text(song.track || song.title),
    album: text(song.album),
    weight: round(weight),
  };
}

function scaleToMax(entries, max) {
  const top = entries.sort((a, b) => b.weight - a.weight).slice(0, max);
  const heaviest = top[0]?.weight || 1;
  return top.map(entry => ({ ...entry, weight: entry.weight / heaviest }));
}

function labelInterests(interests, songSignal) {
  const seen = new Map();
  return interests.map(interest => {
    const songs = interest.songKeys.map(key => songSignal.get(key)?.song).filter(Boolean);
    const base = labelCluster(songs);
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    return { weight: round(interest.weight), label: count > 1 ? `${base} ${count}` : base, vector: roundVector(interest.vector) };
  });
}

/** Builds a passport from the local library and listening history. */
export function buildTastePassport({
  songs = [],
  playbackEvents = [],
  likedSongKeys = [],
  now = Date.now(),
  userAgent = '',
  halfLifeDays = 30,
  maxAnchors = 40,
} = {}) {
  const local = chooseGalaxySpace(songs);
  const targets = [];
  if (local.audio) targets.push({ vectorType: 'learned-audio', model: local.audio.model, dimensions: local.audio.dimensions });
  targets.push({ vectorType: 'metadata', model: METADATA_EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS });

  const spaces = [];
  let signalProfile = null;
  for (const target of targets) {
    const profile = buildContextualTasteProfile(songs, playbackEvents, {
      targetSpace: target.vectorType,
      targetModel: target.model,
      targetDimensions: target.dimensions,
      likedSongKeys,
      now,
      userAgent,
      recencyHalfLifeDays: halfLifeDays,
    });
    signalProfile = signalProfile || profile;
    if (!profile.vector) continue;
    const contexts = {};
    for (const bucket of TIME_BUCKETS) {
      const entry = profile.contextVectors[bucket];
      if (entry) contexts[bucket] = { sessions: entry.sessions, vector: roundVector(entry.vector) };
    }
    spaces.push({
      id: passportSpaceId(target),
      ...target,
      interoperable: isInteroperable(target),
      longTerm: roundVector(profile.vector),
      negative: profile.negativeVector ? roundVector(profile.negativeVector) : null,
      interests: labelInterests(profile.interests, profile.songSignal),
      contexts,
    });
  }

  const signal = signalProfile?.songSignal || new Map();
  const positive = [];
  const negative = [];
  const weighted = [];
  signal.forEach((entry, key) => {
    const net = entry.positive - (0.5 * entry.negative);
    if (net > 0) {
      positive.push({ song: entry.song, weight: net });
      weighted.push({ song: entry.song, net });
    } else if (entry.negative > entry.positive) {
      negative.push({ song: entry.song, weight: entry.negative - entry.positive, key });
    }
  });

  return {
    schema: TASTE_PASSPORT_SCHEMA,
    version: TASTE_PASSPORT_VERSION,
    createdAt: new Date(now).toISOString(),
    generator: { name: 'Sisic Music' },
    halfLifeDays,
    stats: {
      sessions: signalProfile?.sessionCount || 0,
      positiveSignals: signalProfile?.positiveSignalCount || 0,
      negativeSignals: signalProfile?.negativeSignalCount || 0,
      explicitSignals: signalProfile?.explicitSignalCount || 0,
      librarySongs: songs.length,
    },
    spaces,
    anchors: {
      liked: scaleToMax(positive, maxAnchors).map(entry => anchorRecord(entry.song, entry.weight)),
      avoided: scaleToMax(negative, Math.ceil(maxAnchors / 3)).map(entry => anchorRecord(entry.song, entry.weight)),
    },
    descriptors: buildDescriptors(weighted),
  };
}

function cleanVector(value, dimensions) {
  if (!Array.isArray(value) || value.length !== dimensions) return null;
  if (!value.every(isFiniteNumber)) return null;
  const normalised = validateAndNormalizeVector(value, dimensions);
  return normalised ? roundVector(normalised) : null;
}

function cleanAnchors(list, max) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, max).flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const key = text(item.key, 240);
    const weight = Number(item.weight);
    if (!key || !(weight > 0) || !Number.isFinite(weight)) return [];
    return [{ key, artist: text(item.artist), title: text(item.title), album: text(item.album), weight: round(Math.min(1, weight)) }];
  });
}

function cleanDescriptors(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, LIMITS.descriptors).flatMap(item => {
    const label = text(item?.label, 80);
    const weight = Number(item?.weight);
    return label && weight > 0 && Number.isFinite(weight) ? [{ label, weight: round(Math.min(1, weight)) }] : [];
  });
}

/**
 * Validates untrusted JSON (a file from another device or person) and returns a
 * sanitised copy. Only known fields are copied, sizes are capped, and every
 * vector must be finite and match its declared dimension.
 */
export function validateTastePassport(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['Not a taste passport file.'], passport: null };
  if (input.schema !== TASTE_PASSPORT_SCHEMA) return { ok: false, errors: ['This file is not a Sisic taste passport.'], passport: null };
  if (!Number.isInteger(input.version) || input.version < 1) return { ok: false, errors: ['Missing passport version.'], passport: null };
  if (input.version > TASTE_PASSPORT_VERSION) return { ok: false, errors: [`This passport is version ${input.version}; this app understands version ${TASTE_PASSPORT_VERSION}. Update the app to read it.`], passport: null };

  const spaces = [];
  for (const raw of Array.isArray(input.spaces) ? input.spaces.slice(0, LIMITS.spaces) : []) {
    const vectorType = VECTOR_TYPES.includes(raw?.vectorType) ? raw.vectorType : null;
    const model = text(raw?.model, 80);
    const dimensions = Number(raw?.dimensions);
    if (!vectorType || !model || !Number.isInteger(dimensions) || dimensions < 1 || dimensions > LIMITS.dimensions) {
      errors.push('Skipped a space with an unknown type, model or size.');
      continue;
    }
    const longTerm = cleanVector(raw.longTerm, dimensions);
    if (!longTerm) { errors.push(`Skipped ${model}: its taste vector is missing or damaged.`); continue; }
    const interests = (Array.isArray(raw.interests) ? raw.interests.slice(0, LIMITS.interests) : []).flatMap(interest => {
      const vector = cleanVector(interest?.vector, dimensions);
      const weight = Number(interest?.weight);
      return vector && weight > 0 && Number.isFinite(weight) ? [{ weight: round(Math.min(1, weight)), label: text(interest.label, 80) || 'Interest', vector }] : [];
    });
    const contexts = {};
    for (const bucket of TIME_BUCKETS) {
      const entry = raw.contexts?.[bucket];
      const vector = cleanVector(entry?.vector, dimensions);
      if (vector) contexts[bucket] = { sessions: Math.max(0, Math.min(100000, Math.floor(Number(entry.sessions) || 0))), vector };
    }
    const target = { vectorType, model, dimensions };
    spaces.push({
      id: passportSpaceId(target),
      ...target,
      interoperable: isInteroperable(target),
      longTerm,
      negative: raw.negative ? cleanVector(raw.negative, dimensions) : null,
      interests,
      contexts,
    });
  }

  const anchors = { liked: cleanAnchors(input.anchors?.liked, LIMITS.likedAnchors), avoided: cleanAnchors(input.anchors?.avoided, LIMITS.avoidedAnchors) };
  const descriptors = {
    genres: cleanDescriptors(input.descriptors?.genres),
    moods: cleanDescriptors(input.descriptors?.moods),
    artists: cleanDescriptors(input.descriptors?.artists),
  };
  if (!spaces.length && !anchors.liked.length && !descriptors.genres.length && !descriptors.artists.length) {
    return { ok: false, errors: [...errors, 'This passport has no usable taste data.'], passport: null };
  }

  const createdAt = Number.isFinite(Date.parse(input.createdAt)) ? new Date(input.createdAt).toISOString() : null;
  const stats = input.stats && typeof input.stats === 'object' ? input.stats : {};
  const count = value => Math.max(0, Math.min(1e9, Math.floor(Number(value) || 0)));
  return {
    ok: true,
    errors,
    passport: {
      schema: TASTE_PASSPORT_SCHEMA,
      version: input.version,
      createdAt,
      generator: { name: text(input.generator?.name, 60) || 'Unknown' },
      halfLifeDays: Math.max(1, Math.min(3650, Number(input.halfLifeDays) || 30)),
      stats: { sessions: count(stats.sessions), positiveSignals: count(stats.positiveSignals), negativeSignals: count(stats.negativeSignals), explicitSignals: count(stats.explicitSignals), librarySongs: count(stats.librarySongs) },
      spaces,
      anchors,
      descriptors,
    },
  };
}

/** Parses passport JSON text safely (size-capped, never throws). */
export function parseTastePassport(jsonText) {
  if (typeof jsonText !== 'string' || jsonText.length > TASTE_PASSPORT_MAX_BYTES) {
    return { ok: false, errors: ['That file is too large to be a taste passport.'], passport: null };
  }
  try {
    return validateTastePassport(JSON.parse(jsonText));
  } catch {
    return { ok: false, errors: ['That file is not valid JSON.'], passport: null };
  }
}

function mergeInterests(a, b, weightA, weightB) {
  const pool = [
    ...a.map(interest => ({ ...interest, weight: interest.weight * weightA })),
    ...b.map(interest => ({ ...interest, weight: interest.weight * weightB })),
  ].sort((x, y) => y.weight - x.weight);
  const merged = [];
  for (const interest of pool) {
    const near = merged.find(existing => dot(existing.vector, interest.vector) > 0.92);
    if (!near) { merged.push({ ...interest, vector: [...interest.vector] }); continue; }
    const total = near.weight + interest.weight;
    near.vector = unit(near.vector.map((value, i) => ((value * near.weight) + (interest.vector[i] * interest.weight)) / total)) || near.vector;
    near.weight = total;
  }
  const kept = merged.sort((x, y) => y.weight - x.weight).slice(0, 5);
  const total = kept.reduce((sum, interest) => sum + interest.weight, 0) || 1;
  return kept.map(interest => ({ weight: round(interest.weight / total), label: interest.label, vector: roundVector(interest.vector) }));
}

function mixVectors(a, b, weightA, weightB) {
  return unit(a.map((value, i) => (value * weightA) + (b[i] * weightB)));
}

function mixWeighted(listA, listB, weightA, weightB, max) {
  const map = new Map();
  const add = (list, factor) => list.forEach(item => map.set(item.label ?? item.key, { ...(map.get(item.label ?? item.key) || item), weight: (map.get(item.label ?? item.key)?.weight || 0) + (item.weight * factor) }));
  add(listA, weightA);
  add(listB, weightB);
  return [...map.values()].sort((x, y) => y.weight - x.weight).slice(0, max);
}

/**
 * Blends two passports (e.g. a shared playlist for two people). Vectors are only
 * mixed inside spaces both passports share; anchors and descriptors always blend.
 */
export function blendTastePassports(a, b, { weightA = 0.5 } = {}) {
  const wA = Math.max(0, Math.min(1, weightA));
  const wB = 1 - wA;
  const spaces = [];
  for (const spaceA of a.spaces) {
    const spaceB = b.spaces.find(space => space.id === spaceA.id);
    if (!spaceB) continue;
    const longTerm = mixVectors(spaceA.longTerm, spaceB.longTerm, wA, wB);
    if (!longTerm) continue;
    const contexts = {};
    for (const bucket of TIME_BUCKETS) {
      const ctxA = spaceA.contexts[bucket];
      const ctxB = spaceB.contexts[bucket];
      const vector = ctxA && ctxB ? mixVectors(ctxA.vector, ctxB.vector, wA, wB) : null;
      if (vector) contexts[bucket] = { sessions: ctxA.sessions + ctxB.sessions, vector: roundVector(vector) };
    }
    const negative = spaceA.negative && spaceB.negative
      ? mixVectors(spaceA.negative, spaceB.negative, wA, wB)
      : (spaceA.negative || spaceB.negative);
    spaces.push({
      ...spaceA,
      longTerm: roundVector(longTerm),
      negative: negative ? roundVector(negative) : null,
      interests: mergeInterests(spaceA.interests, spaceB.interests, wA, wB),
      contexts,
    });
  }

  const liked = mixWeighted(a.anchors.liked, b.anchors.liked, wA, wB, 40);
  const likedKeys = new Set(liked.map(anchor => anchor.key));
  const heaviest = liked[0]?.weight || 1;
  const descriptors = {};
  for (const kind of ['genres', 'moods', 'artists']) {
    const mixed = mixWeighted(a.descriptors[kind], b.descriptors[kind], wA, wB, kind === 'artists' ? 15 : 8);
    const total = mixed.reduce((sum, item) => sum + item.weight, 0) || 1;
    descriptors[kind] = mixed.map(item => ({ ...item, weight: round(item.weight / total) }));
  }
  return {
    schema: TASTE_PASSPORT_SCHEMA,
    version: TASTE_PASSPORT_VERSION,
    createdAt: new Date().toISOString(),
    generator: { name: 'Sisic Music (blend)' },
    halfLifeDays: Math.round((a.halfLifeDays * wA) + (b.halfLifeDays * wB)),
    stats: {
      sessions: a.stats.sessions + b.stats.sessions,
      positiveSignals: a.stats.positiveSignals + b.stats.positiveSignals,
      negativeSignals: a.stats.negativeSignals + b.stats.negativeSignals,
      explicitSignals: a.stats.explicitSignals + b.stats.explicitSignals,
      librarySongs: a.stats.librarySongs + b.stats.librarySongs,
    },
    spaces,
    anchors: {
      liked: liked.map(anchor => ({ ...anchor, weight: round(anchor.weight / heaviest) })),
      // What either person avoids stays avoided unless the other actively likes it.
      avoided: mixWeighted(a.anchors.avoided, b.anchors.avoided, 1, 1, 15).filter(anchor => !likedKeys.has(anchor.key)),
    },
    descriptors,
  };
}

function makeDescriptorScorer(descriptors) {
  const lookup = list => new Map(list.map(item => [item.label, item.weight]));
  const genres = lookup(descriptors.genres);
  const moods = lookup(descriptors.moods);
  const artists = lookup(descriptors.artists);
  const peak = map => Math.max(0, ...map.values()) || 1;
  const peaks = { genres: peak(genres), moods: peak(moods), artists: peak(artists) };
  const best = (map, labels) => Math.max(0, ...labels.map(label => map.get(label) || 0));
  return song => {
    const artist = text(String(song.artist || '').split(/\s*(?:,|&|\bfeat\.?|\bft\.?)\s*/i)[0], 80);
    return (0.4 * (best(genres, getSongGenres(song)) / peaks.genres))
      + (0.3 * (best(moods, getSongMoods(song)) / peaks.moods))
      + (0.3 * ((artists.get(artist) || 0) / peaks.artists));
  };
}

function audioVectorFor(song, space) {
  const meta = resolveEmbeddingMetadata(song);
  if (!meta || !areVectorSpacesCompatible(space, meta)) return null;
  return validateAndNormalizeVector(meta.vector, space.dimensions);
}

/**
 * Shares mix slots between interests in proportion to their weight (D'Hondt
 * allocation), taking each interest's best remaining songs first. Without this
 * the single biggest interest fills the top of the mix before anything else appears,
 * which is exactly wrong for a blend of two people. This is how PinnerSage merges
 * candidates retrieved per interest.
 */
function interleaveByInterest(groups, weights, limit, allowArtist, onPick) {
  let count = 0;
  const taken = weights.map(() => 0);
  const cursor = groups.map(() => 0);
  while (count < limit) {
    let best = -1;
    let bestPriority = -1;
    for (let j = 0; j < groups.length; j++) {
      while (cursor[j] < groups[j].length && !allowArtist(groups[j][cursor[j]])) cursor[j] += 1;
      if (cursor[j] >= groups[j].length) continue;
      const priority = weights[j] / (taken[j] + 1);
      if (priority > bestPriority) { best = j; bestPriority = priority; }
    }
    if (best < 0) break;
    onPick(groups[best][cursor[best]]);
    cursor[best] += 1;
    taken[best] += 1;
    count += 1;
  }
}

/**
 * Ranks a local library with a passport (your own, a friend's, or a blend).
 * One space is used for the whole ranking so scores stay comparable, chosen in
 * this order: a shared learned-audio space, the shared metadata space, then the
 * anchor tracks that exist in this library, then descriptors alone.
 */
export function scoreLibraryWithPassport(passport, songs = [], { limit = 50, excludeSongKeys = [] } = {}) {
  if (!passport || !songs.length) return { mode: 'none', explanation: 'Nothing to rank.', songs: [] };
  const excluded = new Set(excludeSongKeys);
  const local = chooseGalaxySpace(songs);
  const audioSpace = local.audio && passport.spaces.find(space => space.vectorType === 'learned-audio'
    && space.model === local.audio.model && space.dimensions === local.audio.dimensions);
  const metadataSpace = passport.spaces.find(space => space.vectorType === 'metadata'
    && space.model === METADATA_EMBEDDING_MODEL && space.dimensions === EMBEDDING_DIMENSIONS);
  const hasDescriptors = passport.descriptors.genres.length + passport.descriptors.artists.length + passport.descriptors.moods.length > 0;

  const anchorWeights = new Map(passport.anchors.liked.map(anchor => [anchor.key, anchor.weight]));
  let mode;
  let explanation;
  let vectorFor = () => null;
  let vectorAffinity = () => null;
  let interestList = null;

  const fromSpace = (space, getVector) => {
    const multi = space.interests.length > 1;
    interestList = multi ? space.interests : null;
    vectorFor = getVector;
    vectorAffinity = vector => {
      const fit = multi ? interestAffinity(vector, space.interests) : dot(vector, space.longTerm);
      const avoid = space.negative ? Math.max(0, dot(vector, space.negative)) : 0;
      return fit - (0.28 * avoid);
    };
  };

  if (audioSpace) {
    mode = 'audio-space';
    explanation = `Matched by sound using ${audioSpace.model}.`;
    fromSpace(audioSpace, song => audioVectorFor(song, audioSpace));
  } else if (metadataSpace) {
    mode = 'metadata-space';
    explanation = 'Matched by title, artist and mood tags.';
    fromSpace(metadataSpace, song => getSongEmbedding(song));
  } else {
    // Space-independent: re-embed the anchor tracks that exist here in this library's own space.
    const matched = songs.flatMap(song => (anchorWeights.has(getSongKey(song)) ? [{ vector: getSongEmbedding(song), weight: anchorWeights.get(getSongKey(song)) }] : []));
    const interests = buildInterests(matched);
    const centre = interests.length ? null : unit(matched.reduce((sum, item) => sum.map((value, i) => value + (item.vector[i] * item.weight)), new Array(EMBEDDING_DIMENSIONS).fill(0)));
    if (interests.length || centre) {
      mode = 'anchors';
      explanation = `Matched by the ${matched.length} of ${passport.anchors.liked.length} anchor tracks found in this library.`;
      vectorFor = song => getSongEmbedding(song);
      interestList = interests.length > 1 ? interests : null;
      vectorAffinity = vector => (interests.length > 1 ? interestAffinity(vector, interests) : dot(vector, interests[0]?.vector || centre));
    } else if (hasDescriptors) {
      mode = 'descriptors';
      explanation = 'Matched by genre, mood and artist only. No shared sound space or anchor tracks.';
    } else {
      return { mode: 'none', explanation: 'This passport shares nothing usable with this library.', songs: [] };
    }
  }

  const scoreDescriptors = hasDescriptors ? makeDescriptorScorer(passport.descriptors) : () => 0;
  const vectorShare = mode === 'audio-space' || mode === 'metadata-space' ? 0.85 : mode === 'anchors' ? 0.6 : 0;
  const scored = [];
  let skipped = 0;
  for (const song of songs) {
    const key = getSongKey(song);
    if (!key || excluded.has(key)) continue;
    let vectorPart = 0;
    let interest = 0;
    if (vectorShare) {
      const vector = vectorFor(song);
      if (!vector) { skipped += 1; continue; }
      vectorPart = vectorAffinity(vector);
      if (interestList) {
        let closest = -Infinity;
        interestList.forEach((candidate, index) => {
          const similarity = dot(vector, candidate.vector);
          if (similarity > closest) { closest = similarity; interest = index; }
        });
      }
    }
    const descriptorPart = scoreDescriptors(song);
    const known = (anchorWeights.get(key) || 0) * 0.1;
    scored.push({ song, interest, score: (vectorPart * vectorShare) + (descriptorPart * (1 - vectorShare)) + known });
  }
  scored.sort((x, y) => y.score - x.score);

  const artistCounts = new Map();
  const capArtists = scored.length > limit;
  const artistOf = item => String(item.song.artist || '').trim().toLowerCase();
  const allowArtist = item => !capArtists || (artistCounts.get(artistOf(item)) || 0) < 2;
  const chosen = [];
  const take = item => {
    artistCounts.set(artistOf(item), (artistCounts.get(artistOf(item)) || 0) + 1);
    chosen.push(item);
  };
  if (interestList) {
    const groups = interestList.map(() => []);
    scored.forEach(item => groups[item.interest].push(item));
    interleaveByInterest(groups, interestList.map(interest => interest.weight), limit, allowArtist, take);
  } else {
    for (const item of scored) {
      if (chosen.length >= limit) break;
      if (allowArtist(item)) take(item);
    }
  }
  const picked = chosen.map(item => ({ ...item.song, passportScore: round(item.score) }));
  return { mode, spaceId: audioSpace?.id || metadataSpace?.id || null, explanation, considered: scored.length, skipped, songs: picked };
}
