#!/usr/bin/env node
/**
 * Statistical DJ Simulation: v1 (greedy candidate choice) vs v3 (set planner).
 * Measures DJ transition quality, diversity, and voice commentary metrics.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  mulberry32,
  makeLibrary,
  tasteVector,
  tasteOf,
} from './djSimLibrary.mjs';
import {
  scoreDjTransition,
  chooseDjCandidate,
  planDjMix,
  pickMixBars,
  rememberDjTransition,
} from '../src/services/djModeService.js';
import { planSet } from '../src/services/djSetPlanner.js';
import {
  planNextSet,
  nextFromSet,
  camelotOf,
  shouldSpeak,
  factsFor,
} from '../src/services/djSetDirector.js';
import { commentaryFor } from '../src/services/djCommentary.js';

// Preserve unused imports referenced in spec contract
export { planSet, camelotOf, pickMixBars };

export function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function buildRankedCandidates(source, songs, taste) {
  const outro = source.djRhythm?.outroStart ?? (source.duration - 20);
  const pos = Math.max(0, outro - 10);
  const candidates = songs.filter((s) => s.songKey !== source.songKey);
  const byTaste = candidates
    .map((song) => ({ song, taste: tasteOf(song, taste) }))
    .sort((a, b) => b.taste - a.taste);

  return byTaste.slice(0, 60).map(({ song, taste: songTaste }, index) => {
    const transition = scoreDjTransition(source, song, pos);
    const score = songTaste + transition.score * 0.34;
    return {
      song,
      contextualRank: index,
      contextualScore: songTaste,
      transition,
      score,
    };
  }).sort((a, b) => b.score - a.score || a.contextualRank - b.contextualRank);
}

export function runStrategySimulation({
  strategy = 'v3',
  songs = [],
  genres = [],
  sessionCount = 200,
  transitionsPerSession = 30,
  seed = 1,
} = {}) {
  const stats = {
    strategy,
    totalTransitions: 0,
    beatSyncCount: 0,
    tempoStretches: [],
    keyCompatibleCount: 0,
    energyJumps: [],
    sameArtistCount: 0,
    styles: {},
    mixBars: [],
    spokenLines: 0,
    repeatedTemplates12: 0,
    words: [],
    wordViolations: 0,
  };

  const songMap = new Map(songs.map((s) => [s.songKey, s]));

  for (let sIdx = 0; sIdx < sessionCount; sIdx++) {
    const sessionRng = mulberry32(seed * 100000 + sIdx * 997 + 13);
    const taste = tasteVector(sessionRng, genres);
    const startSong = songs[Math.floor(sessionRng() * songs.length)];

    let currentSong = startSong;
    let djHistory = {};
    let songHistoryMap = new Map([
      [currentSong.songKey, { playCount: 1, lastPlayedAt: 1000 }],
    ]);
    let recentArtists = [currentSong.artist];
    let djSet = null;
    let commentaryMemory = { recent: [] };
    let sessionTime = 1000;

    for (let t = 0; t < transitionsPerSession; t++) {
      const outro = currentSong.djRhythm?.outroStart ?? (currentSong.duration - 20);
      const pos = Math.max(0, outro - 10);
      const prediction = { positionSeconds: pos, predictedSkipAtSeconds: currentSong.duration };

      const ranked = buildRankedCandidates(currentSong, songs, taste);

      let candidate = null;
      let kind = null;
      let choice = null;

      if (strategy === 'v3') {
        const nextKey = nextFromSet(djSet, currentSong.songKey);
        if (nextKey && songMap.has(nextKey)) {
          candidate = songMap.get(nextKey);
          kind = 'link';
        }
        if (!candidate) {
          const count = 3 + Math.floor(sessionRng() * 3);
          djSet = planNextSet({ source: currentSong, ranked, count, rng: sessionRng });
          if (djSet?.keys?.length) {
            const firstKey = nextFromSet(djSet, currentSong.songKey);
            if (firstKey && songMap.has(firstKey)) {
              candidate = songMap.get(firstKey);
              kind = 'set-intro';
            }
          }
        }
      }

      if (!candidate) {
        choice = chooseDjCandidate(ranked, { history: djHistory, random: sessionRng });
        if (choice) {
          candidate = choice.song;
          djSet = null;
          kind = null;
        }
      }

      if (!candidate) break;

      const rankedItem = ranked.find((item) => item.song.songKey === candidate.songKey);
      const transition = choice?.transition || rankedItem?.transition || scoreDjTransition(currentSong, candidate, pos);
      const plan = planDjMix({
        source: currentSong,
        candidate,
        positionSeconds: pos,
        duration: currentSong.duration,
        prediction,
        transition,
        history: djHistory,
        fadeSeconds: 4,
        random: sessionRng,
      });

      stats.totalTransitions++;
      if (transition.beatSync) stats.beatSyncCount++;
      const stretchPct = Math.abs((transition.tempoRatio ?? 1) - 1) * 100;
      stats.tempoStretches.push(stretchPct);
      if (transition.harmonicCompatible !== false) stats.keyCompatibleCount++;
      const energyJump = Math.abs(candidate.energy - currentSong.energy);
      stats.energyJumps.push(energyJump);

      const last4 = recentArtists.slice(-4);
      if (last4.includes(candidate.artist)) {
        stats.sameArtistCount++;
      }

      if (plan?.style) {
        stats.styles[plan.style] = (stats.styles[plan.style] || 0) + 1;
      }
      if (plan?.mixBars != null) {
        stats.mixBars.push(plan.mixBars);
      }

      if (strategy === 'v3' && kind) {
        const speakAllowed = shouldSpeak({
          kind,
          mix: plan,
          outgoing: currentSong,
          incoming: candidate,
          rng: sessionRng,
        });

        if (speakAllowed) {
          sessionTime += currentSong.duration * 1000;
          const facts = factsFor({
            outgoing: currentSong,
            incoming: candidate,
            set: djSet,
            mix: plan,
            history: songHistoryMap,
            now: sessionTime,
          });

          const comm = commentaryFor({
            kind,
            facts,
            memory: commentaryMemory,
            rng: sessionRng,
          });

          if (comm) {
            stats.spokenLines++;
            if (commentaryMemory.recent?.includes(comm.id)) {
              stats.repeatedTemplates12++;
            }
            commentaryMemory = comm.memory;
            const wordCount = comm.text.trim().split(/\s+/).length;
            stats.words.push(wordCount);
            const limit = kind === 'link' ? 30 : 45;
            if (wordCount > limit) stats.wordViolations++;
          }
        }
      }

      djHistory = rememberDjTransition(djHistory, candidate.songKey, plan.transitionAtSeconds, plan.mixBars, plan.style);
      recentArtists.push(candidate.artist);
      const prevHist = songHistoryMap.get(candidate.songKey) || { playCount: 0, lastPlayedAt: null };
      songHistoryMap.set(candidate.songKey, { playCount: prevHist.playCount + 1, lastPlayedAt: sessionTime });
      currentSong = candidate;
    }
  }

  const total = stats.totalTransitions || 1;
  const spoken = stats.spokenLines || 1;

  return {
    strategy,
    totalTransitions: stats.totalTransitions,
    beatSyncShare: stats.beatSyncCount / total,
    meanTempoStretch: stats.tempoStretches.reduce((a, b) => a + b, 0) / total,
    keyCompatibleShare: stats.keyCompatibleCount / total,
    p90EnergyJump: percentile(stats.energyJumps, 0.90),
    sameArtistShare: stats.sameArtistCount / total,
    styles: stats.styles,
    meanMixBars: stats.mixBars.length ? stats.mixBars.reduce((a, b) => a + b, 0) / stats.mixBars.length : 0,
    spokenLines: stats.spokenLines,
    spokenShare: stats.spokenLines / total,
    repeatedTemplates12: stats.repeatedTemplates12,
    templateRepeatRate12: stats.repeatedTemplates12 / spoken,
    meanWords: stats.words.length ? stats.words.reduce((a, b) => a + b, 0) / stats.words.length : 0,
    wordViolations: stats.wordViolations,
  };
}

export function measurePredictability(strategy, songs, genres, { repeats = 40, seed = 1 } = {}) {
  const startSong = songs[0];
  const taste = tasteVector(seed, genres);
  const songMap = new Map(songs.map((s) => [s.songKey, s]));
  const counts = new Map();

  for (let i = 0; i < repeats; i++) {
    const rng = mulberry32(seed * 10000 + i);
    const ranked = buildRankedCandidates(startSong, songs, taste);
    let chosenKey = null;

    if (strategy === 'v3') {
      const count = 3 + Math.floor(rng() * 3);
      const djSet = planNextSet({ source: startSong, ranked, count, rng });
      chosenKey = nextFromSet(djSet, startSong.songKey);
    }
    if (!chosenKey) {
      const choice = chooseDjCandidate(ranked, { history: {}, random: rng });
      chosenKey = choice?.song?.songKey;
    }
    if (chosenKey) {
      counts.set(chosenKey, (counts.get(chosenKey) || 0) + 1);
    }
  }

  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / repeats;
    if (p > 0) entropy -= p * Math.log(p);
  }
  const maxEntropy = Math.log(repeats);
  const normEntropy = maxEntropy > 0 ? entropy / maxEntropy : 0;
  const predictability = 1 - normEntropy;

  return {
    predictability,
    entropy,
    normEntropy,
    distinctChoices: counts.size,
  };
}

export function evaluateThresholds(v1, v3) {
  const checks = [
    {
      id: 'beatSyncShare',
      label: 'Beat-syncable share',
      v1: v1.beatSyncShare,
      v3: v3.beatSyncShare,
      v1Formatted: `${(v1.beatSyncShare * 100).toFixed(1)}%`,
      v3Formatted: `${(v3.beatSyncShare * 100).toFixed(1)}%`,
      thresholdDesc: `>= v1 - 2.0% (${((v1.beatSyncShare - 0.02) * 100).toFixed(1)}%)`,
      passed: v3.beatSyncShare >= v1.beatSyncShare - 0.02 - 1e-9,
    },
    {
      id: 'meanTempoStretch',
      label: 'Mean tempo stretch',
      v1: v1.meanTempoStretch,
      v3: v3.meanTempoStretch,
      v1Formatted: `${v1.meanTempoStretch.toFixed(2)}%`,
      v3Formatted: `${v3.meanTempoStretch.toFixed(2)}%`,
      thresholdDesc: `<= v1 + 0.30% (${(v1.meanTempoStretch + 0.30).toFixed(2)}%)`,
      passed: v3.meanTempoStretch <= v1.meanTempoStretch + 0.30 + 1e-9,
    },
    {
      id: 'keyCompatibleShare',
      label: 'Key-compatible share',
      v1: v1.keyCompatibleShare,
      v3: v3.keyCompatibleShare,
      v1Formatted: `${(v1.keyCompatibleShare * 100).toFixed(1)}%`,
      v3Formatted: `${(v3.keyCompatibleShare * 100).toFixed(1)}%`,
      thresholdDesc: `>= v1 - 2.0% (${((v1.keyCompatibleShare - 0.02) * 100).toFixed(1)}%)`,
      passed: v3.keyCompatibleShare >= v1.keyCompatibleShare - 0.02 - 1e-9,
    },
    {
      id: 'p90EnergyJump',
      label: 'P90 energy jump',
      v1: v1.p90EnergyJump,
      v3: v3.p90EnergyJump,
      v1Formatted: v1.p90EnergyJump.toFixed(3),
      v3Formatted: v3.p90EnergyJump.toFixed(3),
      thresholdDesc: `<= v1 (${v1.p90EnergyJump.toFixed(3)})`,
      passed: v3.p90EnergyJump <= v1.p90EnergyJump + 1e-9,
    },
    {
      id: 'sameArtistShare',
      label: 'Same artist within 4 share',
      v1: v1.sameArtistShare,
      v3: v3.sameArtistShare,
      v1Formatted: `${(v1.sameArtistShare * 100).toFixed(1)}%`,
      v3Formatted: `${(v3.sameArtistShare * 100).toFixed(1)}%`,
      thresholdDesc: `<= v1 * 0.5 (${((v1.sameArtistShare * 0.5) * 100).toFixed(1)}%)`,
      passed: v3.sameArtistShare <= v1.sameArtistShare * 0.5 + 1e-9,
    },
    {
      id: 'predictability',
      label: 'Predictability (1 - norm entropy)',
      v1: v1.predictability,
      v3: v3.predictability,
      v1Formatted: v1.predictability.toFixed(3),
      v3Formatted: v3.predictability.toFixed(3),
      thresholdDesc: '>= 0.500 (taste-driven, not random)',
      passed: v3.predictability >= 0.5,
    },
    {
      id: 'templateRepeatWithin12',
      label: 'Template repeats within 12',
      v1: null,
      v3: v3.repeatedTemplates12,
      v1Formatted: 'N/A',
      v3Formatted: String(v3.repeatedTemplates12),
      thresholdDesc: '== 0',
      passed: v3.repeatedTemplates12 === 0,
    },
    {
      id: 'wordsWithinLimits',
      label: 'Words within limits',
      v1: null,
      v3: v3.wordViolations === 0 ? 1 : 0,
      v1Formatted: 'N/A',
      v3Formatted: v3.wordViolations === 0 ? '100%' : `${v3.wordViolations} errors`,
      thresholdDesc: 'link <= 30, intro <= 45',
      passed: v3.wordViolations === 0,
    },
  ];

  const allPassed = checks.every((c) => c.passed);
  const failed = checks.filter((c) => !c.passed).map((c) => c.label);

  return { checks, allPassed, failed };
}

export function formatTable({ checks, v1, v3, config }) {
  const lines = [];
  lines.push(`DJ Quality Simulation (${config.sessions} sessions, ${config.librarySize} songs, ${config.transitionsPerSession} transitions/session)`);
  lines.push('');
  lines.push('| Metric                            |       v1 |       v3 | Threshold (v3)            | Status |');
  lines.push('|:----------------------------------|---------:|---------:|:--------------------------|:------:|');

  for (const c of checks) {
    const label = c.label.padEnd(34, ' ');
    const v1Str = c.v1Formatted.padStart(8, ' ');
    const v3Str = c.v3Formatted.padStart(8, ' ');
    const thresh = c.thresholdDesc.padEnd(25, ' ');
    const status = c.passed ? ' PASS ' : ' FAIL ';
    lines.push(`| ${label} | ${v1Str} | ${v3Str} | ${thresh} | ${status} |`);
  }

  lines.push('');
  lines.push(`v3 Voice: ${v3.spokenLines} spoken lines (${(v3.spokenShare * 100).toFixed(1)}% of transitions), mean ${v3.meanWords.toFixed(1)} words/line, ${v3.repeatedTemplates12} template repeats within 12.`);
  lines.push(`v1 Mix styles: ${JSON.stringify(v1.styles)}, mean mix bars: ${v1.meanMixBars.toFixed(1)}`);
  lines.push(`v3 Mix styles: ${JSON.stringify(v3.styles)}, mean mix bars: ${v3.meanMixBars.toFixed(1)}`);

  return lines.join('\n');
}

export function runSimulation(options = {}) {
  const size = options.size ?? 400;
  const sessions = options.sessions ?? 200;
  const transitions = options.transitions ?? 30;
  const repeats = options.repeats ?? 40;
  const seed = options.seed ?? 1;

  const { songs, genres } = makeLibrary({ size, seed });

  const v1 = runStrategySimulation({
    strategy: 'v1',
    songs,
    genres,
    sessionCount: sessions,
    transitionsPerSession: transitions,
    seed,
  });

  const v3 = runStrategySimulation({
    strategy: 'v3',
    songs,
    genres,
    sessionCount: sessions,
    transitionsPerSession: transitions,
    seed,
  });

  const predV1 = measurePredictability('v1', songs, genres, { repeats, seed });
  const predV3 = measurePredictability('v3', songs, genres, { repeats, seed });

  v1.predictability = predV1.predictability;
  v1.predictabilityDetails = predV1;
  v3.predictability = predV3.predictability;
  v3.predictabilityDetails = predV3;

  const evaluation = evaluateThresholds(v1, v3);
  const config = { librarySize: size, sessions, transitionsPerSession: transitions, repeats, seed };
  const table = formatTable({ checks: evaluation.checks, v1, v3, config });

  return {
    config,
    v1,
    v3,
    evaluation,
    table,
  };
}

// CLI entry point
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { values } = parseArgs({
    options: {
      size: { type: 'string' },
      sessions: { type: 'string' },
      repeats: { type: 'string' },
      seed: { type: 'string' },
      json: { type: 'string' },
    },
    allowPositionals: true,
  });

  const size = values.size ? parseInt(values.size, 10) : 400;
  const sessions = values.sessions ? parseInt(values.sessions, 10) : 200;
  const repeats = values.repeats ? parseInt(values.repeats, 10) : 40;
  const seed = values.seed ? parseInt(values.seed, 10) : 1;

  const result = runSimulation({ size, sessions, repeats, seed });

  console.log(result.table);
  console.log('');
  if (result.evaluation.allPassed) {
    console.log('Simulation RESULT: ALL THRESHOLDS PASSED (exit code 0)');
  } else {
    console.log(`Simulation RESULT: FAILED THRESHOLDS: ${result.evaluation.failed.join(', ')} (exit code 1)`);
  }

  if (values.json) {
    fs.writeFileSync(values.json, JSON.stringify(result, null, 2), 'utf-8');
    console.log(`Wrote JSON results to ${values.json}`);
  }

  process.exit(result.evaluation.allPassed ? 0 : 1);
}
