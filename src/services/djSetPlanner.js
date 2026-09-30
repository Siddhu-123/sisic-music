const MAX_CANDIDATES = 200;
const TEMPO_SCALE_PCT = 8;
const TEMPO_STEP_PENALTY_PCT = 6;
const ENERGY_JUMP_LIMIT = 0.3;
const W_TEMPO = 0.45;
const W_KEY = 0.3;
const W_ENERGY = 0.25;
const W_PAIR = 0.7;
const W_TASTE = 0.3;
const P_SAME_ARTIST = 0.4;
const P_TEMPO_STEP = 0.3;
const P_KEY_DISTANCE = 0.2;
const P_ENERGY_JUMP = 0.2;
const RECENT_ARTISTS = 4;
const W_ARC = 0.25;
const UNKNOWN = 0.5;
const PICK_WEIGHTS = [0.6, 0.25, 0.15];
const ARCS = ['build-peak-cool', 'steady', 'none'];
const CAMELOT_RE = /^(1[0-2]|[1-9])([AB])$/;
const CIRCLE = 12;

function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function mulberry32(seed) {
  let a = seed | 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseCamelot(value) {
  if (typeof value !== 'string') return null;
  const m = CAMELOT_RE.exec(value.trim().toUpperCase());
  return m ? { number: Number(m[1]), letter: m[2] } : null;
}

function normalizeSong(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const { id, artist, tempo, energy, taste } = raw;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof artist !== 'string') return null;
  if (tempo != null && !(isNum(tempo) && tempo > 0)) return null;
  if (energy != null && !isNum(energy)) return null;
  return {
    raw,
    id,
    artist,
    tempo: isNum(tempo) ? tempo : null,
    key: parseCamelot(raw.camelot),
    energy: isNum(energy) ? energy : null,
    taste: isNum(taste) ? taste : 0.5,
  };
}

// Smallest percentage change that brings `to` (or its double / half) onto `from`.
function tempoStepPct(from, to) {
  if (from == null || to == null) return null;
  let best = Infinity;
  for (const scaled of [to, to * 2, to / 2]) {
    const pct = Math.abs(from - scaled) / from * 100;
    if (pct < best) best = pct;
  }
  return best;
}

function circularStep(a, b) {
  const d = Math.abs(a - b) % CIRCLE;
  return Math.min(d, CIRCLE - d);
}

// Piecewise Camelot distance: same number -> 0; +-1 with the same letter -> 1;
// otherwise circular number distance plus one when the letters differ.
function keyDistanceOf(a, b) {
  if (a == null || b == null) return null;
  if (a.number === b.number) return 0;
  const step = circularStep(a.number, b.number);
  if (step === 1 && a.letter === b.letter) return 1;
  return step + (a.letter === b.letter ? 0 : 1);
}

function keyScoreOf(distance) {
  if (distance === 0) return 1;
  if (distance === 1) return 0.85;
  if (distance === 2) return 0.4;
  return 0;
}

function tempoScoreOf(stepPct) {
  return stepPct == null ? UNKNOWN : 1 - Math.min(1, stepPct / TEMPO_SCALE_PCT);
}

function energyScoreOf(delta) {
  return delta == null ? UNKNOWN : 1 - Math.min(1, Math.abs(delta) / ENERGY_JUMP_LIMIT);
}

function defaultPairScore(stepPct, keyDistance, energyDelta) {
  return (
    W_TEMPO * tempoScoreOf(stepPct) +
    W_KEY * keyScoreOf(keyDistance == null ? 3 : keyDistance) +
    W_ENERGY * energyScoreOf(energyDelta)
  );
}

function arcTarget(arc, index, count, startEnergy) {
  if (arc === 'none') return null;
  if (arc === 'steady') return isNum(startEnergy) ? startEnergy : null;
  return 0.5 + 0.3 * Math.sin((Math.PI * (index + 1)) / (count + 1));
}

function arcTerm(energy, target) {
  if (target == null || !isNum(energy)) return 0;
  return W_ARC * (1 - Math.min(1, Math.abs(energy - target)));
}

function evaluateLink(previous, current, recentArtists, customPairScore) {
  const stepPct = tempoStepPct(previous.tempo, current.tempo);
  const keyDistance = keyDistanceOf(previous.key, current.key);
  const energyDelta =
    previous.energy == null || current.energy == null ? null : current.energy - previous.energy;

  let pair;
  if (customPairScore) {
    const value = customPairScore(previous.raw, current.raw);
    pair = isNum(value) ? value : UNKNOWN;
  } else {
    pair = defaultPairScore(stepPct, keyDistance, energyDelta);
  }

  const penalties = [];
  let penaltyTotal = 0;
  if (recentArtists.includes(current.artist)) {
    penalties.push('sameArtist');
    penaltyTotal += P_SAME_ARTIST;
  }
  if (stepPct != null && stepPct > TEMPO_STEP_PENALTY_PCT) {
    penalties.push('tempoStep');
    penaltyTotal += P_TEMPO_STEP;
  }
  if (keyDistance != null && keyDistance > 1) {
    penalties.push('keyDistance');
    penaltyTotal += P_KEY_DISTANCE;
  }
  if (energyDelta != null && Math.abs(energyDelta) > ENERGY_JUMP_LIMIT) {
    penalties.push('energyJump');
    penaltyTotal += P_ENERGY_JUMP;
  }

  return { stepPct, keyDistance, energyDelta, pair, penalties, penaltyTotal };
}

function compareEntries(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.key < b.key) return -1;
  if (a.key > b.key) return 1;
  return 0;
}

function chooseSeeded(top, seed) {
  const rand = mulberry32(seed);
  const roll = rand();
  let acc = 0;
  for (let i = 0; i < top.length; i += 1) {
    acc += PICK_WEIGHTS[i];
    if (roll < acc) return top[i];
  }
  return top[top.length - 1];
}

function selectPool(candidates, startId) {
  const songs = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const song = normalizeSong(candidates[i]);
    if (song && song.id !== startId) songs.push({ song, index: i });
  }
  songs.sort((a, b) => (b.song.taste - a.song.taste) || (a.index - b.index));

  const seen = new Set();
  const pool = [];
  for (const entry of songs) {
    if (seen.has(entry.song.id)) continue;
    seen.add(entry.song.id);
    pool.push(entry.song);
    if (pool.length === MAX_CANDIDATES) break;
  }
  return pool;
}

export function planSet(options) {
  if (options === null || typeof options !== 'object') return null;
  const { candidates, start, pairScore = null } = options;
  const count = options.count === undefined ? 4 : options.count;
  const beamWidth = isNum(options.beamWidth) ? options.beamWidth : 8;
  const seed = isNum(options.seed) ? options.seed : 1;
  const arcRaw = options.arc === undefined ? 'build-peak-cool' : options.arc;
  const arc = ARCS.includes(arcRaw) ? arcRaw : 'none'; // an unknown arc name plans without an arc term

  if (!isNum(count) || count < 1) return null;

  const startSong = normalizeSong(start);
  if (!startSong) return null;
  if (!Array.isArray(candidates)) return null;

  const pool = selectPool(candidates, startSong.id);
  if (pool.length === 0) return null;

  const wanted = Math.max(1, Math.floor(count));
  const width = Math.max(1, Math.floor(beamWidth));
  const custom = typeof pairScore === 'function' ? pairScore : null;

  let beam = [
    {
      score: 0,
      ids: [],
      key: '',
      last: startSong,
      used: new Set(),
      artists: [startSong.artist],
      links: [],
    },
  ];
  let depth = 0;

  for (let i = 0; i < wanted; i += 1) {
    const target = arcTarget(arc, i, wanted, startSong.energy);
    const expanded = [];
    for (const entry of beam) {
      const recentArtists = entry.artists.slice(-RECENT_ARTISTS);
      for (const song of pool) {
        if (entry.used.has(song.id)) continue;
        const link = evaluateLink(entry.last, song, recentArtists, custom);
        const gain =
          W_PAIR * link.pair +
          W_TASTE * song.taste -
          link.penaltyTotal +
          arcTerm(song.energy, target);
        const ids = entry.ids.concat(song.id);
        expanded.push({
          score: entry.score + gain,
          ids,
          key: ids.join('\u0000'),
          last: song,
          used: new Set(entry.used).add(song.id),
          artists: entry.artists.concat(song.artist),
          links: entry.links.concat({
            id: song.id,
            reason: {
              stepPct: link.stepPct,
              keyDistance: link.keyDistance,
              energyDelta: link.energyDelta,
              pair: link.pair,
              penalties: link.penalties,
            },
          }),
        });
      }
    }
    if (expanded.length === 0) break;
    expanded.sort(compareEntries);
    beam = expanded.slice(0, width);
    depth = i + 1;
  }

  const chosen = chooseSeeded(beam.slice(0, 3), seed);
  return {
    items: chosen.links.slice(0, depth),
    arc: typeof arcRaw === "string" ? arcRaw : "none",
    score: chosen.score,
  };
}

export default planSet;
