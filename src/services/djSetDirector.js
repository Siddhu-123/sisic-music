import { getSongKey } from '../songIdentity.js';
import { barBeatsOf, beatSeconds } from './djBeatMath.js';
import { scoreDjTransition } from './djModeService.js';
import { planSet } from './djSetPlanner.js';

export const CAMELOT_TABLE = {
  // Minor keys (A)
  'Ab minor': '1A', 'G# minor': '1A',
  'Eb minor': '2A', 'D# minor': '2A',
  'Bb minor': '3A', 'A# minor': '3A',
  'F minor': '4A', 'E# minor': '4A',
  'C minor': '5A', 'B# minor': '5A',
  'G minor': '6A',
  'D minor': '7A',
  'A minor': '8A',
  'E minor': '9A', 'Fb minor': '9A',
  'B minor': '10A', 'Cb minor': '10A',
  'F# minor': '11A', 'Gb minor': '11A',
  'C# minor': '12A', 'Db minor': '12A',

  // Major keys (B)
  'B major': '1B', 'Cb major': '1B',
  'F# major': '2B', 'Gb major': '2B',
  'Db major': '3B', 'C# major': '3B',
  'Ab major': '4B', 'G# major': '4B',
  'Eb major': '5B', 'D# major': '5B',
  'Bb major': '6B', 'A# major': '6B',
  'F major': '7B', 'E# major': '7B',
  'C major': '8B', 'B# major': '8B',
  'G major': '9B',
  'D major': '10B',
  'A major': '11B',
  'E major': '12B', 'Fb major': '12B',
};

const CAMELOT_RE = /^(1[0-2]|[1-9])\s*([AB])$/i;
const KEY_NAME_RE = /^([A-G])([#b]?)\s*(maj(?:or)?|min(?:or)?|m)?$/i;

export function camelotOf(musicalKey) {
  if (typeof musicalKey !== 'string') return null;
  const trimmed = musicalKey.trim();
  if (!trimmed) return null;

  const directCamelot = CAMELOT_RE.exec(trimmed);
  if (directCamelot) {
    return `${directCamelot[1]}${directCamelot[2].toUpperCase()}`;
  }

  const cleaned = trimmed.replace(/♯/g, '#').replace(/♭/g, 'b');
  const match = KEY_NAME_RE.exec(cleaned);
  if (!match) return null;

  const letter = match[1].toUpperCase();
  const accidental = match[2] ? (match[2] === '#' ? '#' : 'b') : '';
  const root = `${letter}${accidental}`;
  const isMinor = match[3] ? /^m(in(or)?)?$/i.test(match[3]) : false;
  const mode = isMinor ? 'minor' : 'major';

  const lookupKey = `${root} ${mode}`;
  return CAMELOT_TABLE[lookupKey] || null;
}

export function toPlannerSong(song, options) {
  if (!song || typeof song !== 'object') return null;
  const opts = options || {};

  const id = song.songKey || song.id || (getSongKey(song) || '');
  const artist = typeof song.artist === 'string' ? song.artist : '';

  let tempo = null;
  const rhythm = song.djRhythm;
  if (rhythm?.startBpm > 0) {
    tempo = rhythm.startBpm;
  } else if (rhythm?.bpm > 0) {
    tempo = rhythm.bpm;
  } else if (song.bpm > 0) {
    tempo = song.bpm;
  }

  const camelot = camelotOf(song.musicalKey || song.camelot);

  let energy = null;
  if (Number.isFinite(opts.energy)) {
    energy = opts.energy;
  } else if (Number.isFinite(song.energy)) {
    energy = song.energy;
  }

  let rawTaste = 0.5;
  if (Number.isFinite(opts.taste)) {
    rawTaste = opts.taste;
  } else if (Number.isFinite(song.taste)) {
    rawTaste = song.taste;
  } else if (Number.isFinite(song.tasteScore)) {
    rawTaste = song.tasteScore;
  }
  const taste = Math.max(0, Math.min(1, rawTaste));

  return {
    id,
    artist,
    tempo,
    camelot,
    energy,
    taste,
  };
}

// Planner link score from the real mix scorer: what `planDjMix` will later execute, so a link the planner likes is one
// the mixer can beat-match and key-match. Non-beat-syncable and key-clashing links lose 0.5 each (clamped to 0..1).
export function transitionPairScore(songA, songB, scorer = scoreDjTransition) {
  const outro = songA?.djRhythm?.outroStart ?? (Number.isFinite(songA?.duration) ? songA.duration - 20 : 0);
  const transition = scorer(songA, songB, Math.max(0, outro - 10));
  let score = transition?.score ?? 0.5;
  if (!transition?.beatSync) score -= 0.5;
  if (transition?.harmonicCompatible === false) score -= 0.5;
  return Math.max(0, Math.min(1, score));
}

export function planNextSet(options) {
  if (!options?.source || !options?.ranked?.length) return null;
  const { source, ranked, count, seed, rng, now = Date.now, pairScore = null, recentArtists: explicitRecentArtists = null, transitionScorer: scorer = scoreDjTransition } = options;

  const startSong = toPlannerSong(source, { energy: source.energy, taste: source.taste });
  if (!startSong) return null;

  const candidatePool = ranked.slice(0, 60);
  const candidateSongs = [];
  const candidateMap = new Map();
  const rawSongById = new Map();

  rawSongById.set(startSong.id, source);

  for (const item of candidatePool) {
    const rawSong = item?.song || item;
    const itemTaste = item?.contextualScore ?? item?.score ?? rawSong?.tasteScore ?? rawSong?.taste;
    const plannerSong = toPlannerSong(rawSong, { energy: rawSong?.energy, taste: itemTaste });
    if (plannerSong && plannerSong.id !== startSong.id) {
      candidateSongs.push(plannerSong);
      candidateMap.set(plannerSong.id, { item, plannerSong });
      rawSongById.set(plannerSong.id, rawSong);
    }
  }

  if (candidateSongs.length === 0) return null;

  let setCount = 4;
  if (count >= 1) {
    setCount = Math.floor(count);
  } else if (typeof rng === 'function') {
    setCount = 3 + Math.floor(rng() * 3);
  }

  let setSeed = 1;
  if (Number.isFinite(seed)) {
    setSeed = seed;
  } else if (typeof rng === 'function') {
    setSeed = Math.floor(rng() * 1000000);
  }

  let effectivePairScore = pairScore;
  if (typeof effectivePairScore !== 'function') {
    const pairCache = new Map();
    effectivePairScore = (plannerA, plannerB) => {
      const cacheKey = `${plannerA.id}->${plannerB.id}`;
      if (!pairCache.has(cacheKey)) {
        pairCache.set(cacheKey, transitionPairScore(rawSongById.get(plannerA.id), rawSongById.get(plannerB.id), scorer));
      }
      return pairCache.get(cacheKey);
    };
  }

  const recentArtists = Array.isArray(explicitRecentArtists) ? explicitRecentArtists : [];

  const planResult = planSet({
    start: startSong,
    candidates: candidateSongs,
    count: setCount,
    seed: setSeed,
    pairScore: effectivePairScore,
    recentArtists,
  });

  if (!planResult?.items?.length) {
    return null;
  }

  const keys = planResult.items.map(item => item.id);
  const setSongs = keys.map(k => candidateMap.get(k)?.plannerSong).filter(Boolean);

  const artistCounts = new Map();
  let sharedArtist = null;
  for (const s of setSongs) {
    const a = s.artist;
    if (a) {
      const c = (artistCounts.get(a) || 0) + 1;
      artistCounts.set(a, c);
      if (c >= 2 && !sharedArtist) {
        sharedArtist = a;
      }
    }
  }

  let theme;
  if (sharedArtist) {
    theme = sharedArtist;
  } else {
    let energySum = 0;
    let energyCount = 0;
    for (const s of setSongs) {
      if (Number.isFinite(s.energy)) {
        energySum += s.energy;
        energyCount += 1;
      }
    }
    const meanEnergy = energyCount > 0 ? (energySum / energyCount) : 0.5;
    if (meanEnergy < 0.25) {
      theme = 'calm';
    } else if (meanEnergy < 0.45) {
      theme = 'warm';
    } else if (meanEnergy < 0.65) {
      theme = 'upbeat';
    } else {
      theme = 'intense';
    }
  }

  const arc = typeof planResult.arc === 'string' ? planResult.arc : 'none';
  const plannedAt = typeof now === 'function' ? now() : (Number.isFinite(now) ? now : Date.now());

  return {
    keys,
    theme,
    arc,
    plannedAt,
  };
}

export function nextFromSet(set, currentKey) {
  if (!set?.keys?.length) return null;
  if (!currentKey) return set.keys[0];
  const index = set.keys.indexOf(currentKey);
  if (index >= 0) {
    return index + 1 < set.keys.length ? set.keys[index + 1] : null;
  }
  return set.keys[0];
}

export function factsFor(options) {
  if (!options) return {};
  const { outgoing, incoming, set, mix, history, now = Date.now } = options;
  const artist = incoming?.artist ? String(incoming.artist) : '';
  const title = incoming?.track ? String(incoming.track) : (incoming?.title ? String(incoming.title) : '');
  const prevArtist = outgoing?.artist ? String(outgoing.artist) : '';
  const prevTitle = outgoing?.track ? String(outgoing.track) : (outgoing?.title ? String(outgoing.title) : '');

  let tempoRelation;
  const mixRatio = Number.isFinite(mix?.tempoRatio) ? mix.tempoRatio : null;
  const outTempo = outgoing?.djRhythm?.startBpm || outgoing?.djRhythm?.bpm || outgoing?.bpm || null;
  const inTempo = incoming?.djRhythm?.startBpm || incoming?.djRhythm?.bpm || incoming?.bpm || null;

  const ratioSame = mixRatio !== null && Math.abs(mixRatio - 1) <= 0.015 + 1e-9;
  const nativeSame = outTempo !== null && inTempo !== null && ((Math.abs(inTempo - outTempo) / outTempo) <= 0.02 + 1e-9);

  if (ratioSame || nativeSame) {
    tempoRelation = 'same';
  } else if (inTempo !== null && outTempo !== null) {
    tempoRelation = inTempo > outTempo ? 'faster' : 'slower';
  }

  let keyRelation;
  const outCamelot = camelotOf(outgoing?.musicalKey || outgoing?.camelot);
  const inCamelot = camelotOf(incoming?.musicalKey || incoming?.camelot);
  if (outCamelot && inCamelot) {
    const aNum = Number(outCamelot.slice(0, -1));
    const aLet = outCamelot.slice(-1);
    const bNum = Number(inCamelot.slice(0, -1));
    const bLet = inCamelot.slice(-1);
    const diff = Math.abs(aNum - bNum);
    const circDist = Math.min(diff, 12 - diff);

    if (circDist === 0 && aLet === bLet) {
      keyRelation = 'same';
    } else if (circDist === 0 && aLet !== bLet) {
      keyRelation = 'relative';
    } else if (circDist === 1 && aLet === bLet) {
      keyRelation = 'neighbour';
    } else {
      keyRelation = 'clash';
    }
  }

  let mood;
  if (Number.isFinite(incoming?.energy)) {
    const e = incoming.energy;
    if (e < 0.25) {
      mood = 'calm';
    } else if (e < 0.45) {
      mood = 'warm';
    } else if (e < 0.65) {
      mood = 'upbeat';
    } else {
      mood = 'intense';
    }
  }

  const dateObj = Number.isFinite(now) ? new Date(now) : (now instanceof Date ? now : (typeof now === 'function' ? new Date(now()) : new Date()));
  const hour = dateObj.getHours();
  let timeOfDay;
  if (hour >= 5 && hour < 12) {
    timeOfDay = 'morning';
  } else if (hour >= 12 && hour < 17) {
    timeOfDay = 'afternoon';
  } else if (hour >= 17 && hour < 22) {
    timeOfDay = 'evening';
  } else {
    timeOfDay = 'late-night';
  }

  const theme = set?.theme || undefined;
  const count = set?.count !== undefined ? set.count : (Array.isArray(set?.keys) ? set.keys.length : undefined);

  const inKey = incoming?.songKey || incoming?.id || (incoming ? getSongKey(incoming) : null);
  const hist = inKey && history ? (history instanceof Map ? history.get(inKey) : history[inKey]) : null;

  const playCount = Number.isFinite(hist?.playCount) ? hist.playCount : 0;
  const firstTime = playCount === 0;

  let lastPlayedDaysAgo = null;
  if (hist?.lastPlayedAt != null) {
    const lastPlayedMs = Number.isFinite(hist.lastPlayedAt) ? hist.lastPlayedAt : Date.parse(hist.lastPlayedAt);
    if (Number.isFinite(lastPlayedMs)) {
      lastPlayedDaysAgo = Math.max(0, Math.floor((dateObj.getTime() - lastPlayedMs) / 86400000));
    }
  }

  return {
    artist,
    title,
    prevArtist,
    prevTitle,
    tempoRelation,
    keyRelation,
    mood,
    timeOfDay,
    theme,
    count,
    playCount,
    lastPlayedDaysAgo,
    firstTime,
  };
}

export function shouldSpeak(options) {
  if (!options) return false;
  const { kind, mix: _mix, outgoing, incoming, rng = Math.random } = options;

  const outroBars = Number(outgoing?.djRhythm?.outroBars ?? outgoing?.outroBars);
  const rhythm = outgoing?.djRhythm;
  const barSec = rhythm ? (beatSeconds(rhythm, rhythm.outroBpm) || 0.5) * barBeatsOf(rhythm) : 2;
  const outroSeconds = outroBars > 0 ? outroBars * barSec : 0;

  const introEnd = Number(incoming?.djRhythm?.introEnd ?? incoming?.introEnd);
  const introSeconds = introEnd > 0 ? introEnd : 0;

  if (outroSeconds < 4 && introSeconds < 4) {
    return false;
  }

  if (kind === 'set-intro') {
    return true;
  }
  if (kind === 'link') {
    return rng() < 0.35;
  }
  return false;
}
