import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  percentile,
  buildRankedCandidates,
  runSimulation,
  formatTable,
  evaluateThresholds,
  measurePredictability,
} from './simulate-dj.mjs';
import { makeLibrary, tasteVector } from './djSimLibrary.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('percentile computes expected values and interpolates', () => {
  assert.equal(percentile([], 0.9), 0);
  assert.equal(percentile([5], 0.9), 5);
  const arr = [10, 20, 30, 40, 50];
  assert.equal(percentile(arr, 0), 10);
  assert.equal(percentile(arr, 1), 50);
  assert.equal(percentile(arr, 0.5), 30);
  assert.equal(percentile(arr, 0.9), 46);
});

test('buildRankedCandidates returns properly shaped items sorted by score', () => {
  const { songs, genres } = makeLibrary({ size: 120, seed: 42 });
  const taste = tasteVector(42, genres);
  const source = songs[0];

  const ranked = buildRankedCandidates(source, songs, taste);
  assert.ok(Array.isArray(ranked));
  assert.equal(ranked.length, 60);

  for (let i = 0; i < ranked.length; i++) {
    const item = ranked[i];
    assert.ok(item.song && typeof item.song === 'object');
    assert.notEqual(item.song.songKey, source.songKey);
    assert.equal(typeof item.contextualRank, 'number');
    assert.equal(typeof item.contextualScore, 'number');
    assert.ok(item.transition && typeof item.transition === 'object');
    assert.equal(typeof item.score, 'number');

    if (i > 0) {
      assert.ok(
        ranked[i - 1].score >= item.score,
        `Expected score descending: ${ranked[i - 1].score} >= ${item.score}`
      );
    }
  }
});

test('measurePredictability produces valid bounded score', () => {
  const { songs, genres } = makeLibrary({ size: 60, seed: 10 });
  const result = measurePredictability('v1', songs, genres, { repeats: 10, seed: 10 });

  assert.ok(Number.isFinite(result.predictability));
  assert.ok(result.predictability >= 0 && result.predictability <= 1);
  assert.ok(result.distinctChoices >= 1);
});

test('evaluateThresholds verifies all required checks', () => {
  const mockV1 = {
    beatSyncShare: 0.8,
    meanTempoStretch: 1.0,
    keyCompatibleShare: 0.95,
    p90EnergyJump: 0.2,
    sameArtistShare: 0.4,
    predictability: 0.7,
  };

  // Passing v3
  const mockV3Pass = {
    beatSyncShare: 0.79, // >= 0.78
    meanTempoStretch: 1.25, // <= 1.30
    keyCompatibleShare: 0.94, // >= 0.93
    p90EnergyJump: 0.18, // <= 0.20
    sameArtistShare: 0.19, // <= 0.20
    predictability: 0.75, // >= 0.50
    repeatedTemplates12: 0, // == 0
    wordViolations: 0, // 0 errors
  };

  const evalPass = evaluateThresholds(mockV1, mockV3Pass);
  assert.equal(evalPass.allPassed, true);
  assert.equal(evalPass.failed.length, 0);

  // Failing v3
  const mockV3Fail = {
    beatSyncShare: 0.70, // fails (< 0.78)
    meanTempoStretch: 1.50, // fails (> 1.30)
    keyCompatibleShare: 0.80, // fails (< 0.93)
    p90EnergyJump: 0.25, // fails (> 0.20)
    sameArtistShare: 0.30, // fails (> 0.20)
    predictability: 0.40, // fails (< 0.50)
    repeatedTemplates12: 2, // fails (!= 0)
    wordViolations: 1, // fails (!= 0)
  };

  const evalFail = evaluateThresholds(mockV1, mockV3Fail);
  assert.equal(evalFail.allPassed, false);
  assert.equal(evalFail.failed.length, 8);
});

test('smoke test: runSimulation completes fast and returns complete data', () => {
  const start = Date.now();
  const result = runSimulation({ size: 120, sessions: 20, repeats: 20, seed: 1 });
  const duration = Date.now() - start;

  assert.ok(duration < 10000, `Expected run under 10 s, took ${duration} ms`);
  assert.ok(result.table.includes('DJ Quality Simulation'));
  assert.ok(result.table.includes('Beat-syncable share'));
  assert.ok(result.table.includes('Key-compatible share'));
  assert.ok(result.v1.totalTransitions === 20 * 30);
  assert.ok(result.v3.totalTransitions === 20 * 30);
  assert.ok(Number.isFinite(result.v1.beatSyncShare));
  assert.ok(Number.isFinite(result.v3.beatSyncShare));
  assert.ok(Number.isFinite(result.v1.meanTempoStretch));
  assert.ok(Number.isFinite(result.v3.meanTempoStretch));
  assert.ok(Number.isFinite(result.v1.keyCompatibleShare));
  assert.ok(Number.isFinite(result.v3.keyCompatibleShare));
  assert.ok(Number.isFinite(result.v1.p90EnergyJump));
  assert.ok(Number.isFinite(result.v3.p90EnergyJump));
  assert.ok(Number.isFinite(result.v1.sameArtistShare));
  assert.ok(Number.isFinite(result.v3.sameArtistShare));
  assert.ok(Number.isFinite(result.v1.predictability));
  assert.ok(Number.isFinite(result.v3.predictability));
  assert.ok(Number.isFinite(result.v3.spokenLines));
  assert.ok(Number.isFinite(result.v3.repeatedTemplates12));
  assert.ok(Number.isFinite(result.v3.meanWords));
});

test('CLI runs with --size 120 --sessions 20 --json and outputs valid table and JSON', () => {
  const jsonPath = path.join(__dirname, 'smoke-result-temp.json');
  try {
    const scriptPath = path.join(__dirname, 'simulate-dj.mjs');
    const child = spawnSync(
      process.execPath,
      [scriptPath, '--size', '120', '--sessions', '20', '--json', jsonPath],
      { encoding: 'utf-8', timeout: 10000 }
    );

    assert.ok(child.stdout.includes('DJ Quality Simulation'));
    assert.ok(child.stdout.includes('Simulation RESULT:'));
    assert.ok(fs.existsSync(jsonPath), 'Expected JSON result file to be created');

    const json = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    assert.equal(json.config.librarySize, 120);
    assert.equal(json.config.sessions, 20);
    assert.ok(json.v1 && json.v3 && json.evaluation && json.table);
  } finally {
    if (fs.existsSync(jsonPath)) {
      fs.unlinkSync(jsonPath);
    }
  }
});
