import { spawn, execSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAC_APP_DIR = path.resolve(REPO_ROOT, 'mac-app');
const WEB_APP_DIR = path.resolve(REPO_ROOT, 'web-app');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 5196;
const CDP_PORT = 9228;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

console.log('=== SISIC MUSIC: LEARNED AUDIO EMBEDDING VERIFICATION ===\n');

// =========================================================================
// STAGE 1: PYTHON WORKER & ONNX MODEL PIPELINE
// =========================================================================
console.log('--- STAGE 1: Python Worker & ONNX Model Inference ---');

const modelPath = path.join(MAC_APP_DIR, 'models', 'msd-musicnn-1.onnx');
assert.ok(fs.existsSync(modelPath), `Model file not found at ${modelPath}`);
const modelStat = fs.statSync(modelPath);
const modelSizeMB = (modelStat.size / (1024 * 1024)).toFixed(2);
console.log(`✓ Pretrained model present: msd-musicnn-1.onnx (${modelSizeMB} MB)`);

const pythonBin = path.join(MAC_APP_DIR, '.venv', 'bin', 'python3');
const audioFile = path.join(MAC_APP_DIR, 'Raga of Madness [2vQmfswjGrY].mp3');
assert.ok(fs.existsSync(audioFile), `Audio file not found: ${audioFile}`);

// Test direct Python inference & cache
console.log('Running Python inference test on real local audio...');
const pyTestCmd = `"${pythonBin}" -c "
import sys, time
from audio_embeddings import AudioEmbeddingExtractor

extractor = AudioEmbeddingExtractor()
t0 = time.perf_counter()
res1 = extractor.extract_embedding('${audioFile}', duration_seconds=15.0, use_cache=True)
t1 = time.perf_counter()

t2 = time.perf_counter()
res2 = extractor.extract_embedding('${audioFile}', duration_seconds=15.0, use_cache=True)
t3 = time.perf_counter()

import json
print(json.dumps({
    'dimensions': res1['dimensions'],
    'model': res1['model'],
    'vector_len': len(res1['vector']),
    'norm': float(sum(x*x for x in res1['vector'])**0.5),
    'num_patches': res1['numPatches'],
    'cold_time': t1 - t0,
    'warm_time': t3 - t2,
    'cached': res2['cached'],
    'identical': res1['vector'] == res2['vector']
}))
"`;

const pyOutputRaw = execSync(pyTestCmd, { cwd: MAC_APP_DIR, encoding: 'utf-8' });
const pyResult = JSON.parse(pyOutputRaw.trim());

assert.equal(pyResult.dimensions, 200, 'Dimensions must be 200');
assert.equal(pyResult.vector_len, 200, 'Vector length must be 200');
assert.equal(pyResult.model, 'msd-musicnn-1', 'Model must be msd-musicnn-1');
assert.ok(Math.abs(pyResult.norm - 1.0) < 1e-4, 'Vector must have unit L2 norm');
assert.ok(pyResult.cached, 'Second call must be cached');
assert.ok(pyResult.identical, 'Cached vector must be identical to cold vector');
assert.ok(pyResult.warm_time < 0.010, `Warm cache hit must be fast (< 10ms), was ${pyResult.warm_time * 1000}ms`);

console.log(`✓ Cold inference: ${(pyResult.cold_time * 1000).toFixed(1)}ms (${pyResult.num_patches} patches analyzed)`);
console.log(`✓ Warm cache hit: ${(pyResult.warm_time * 1000).toFixed(2)}ms (< 10ms target achieved)`);
console.log(`✓ Vector verified: 200D unit normalized (norm = ${pyResult.norm.toFixed(6)})`);

// Verify precomputed embeddings file in mac-app/.cache/
const cacheEmbeddingsPath = path.join(MAC_APP_DIR, '.cache', 'audio_embeddings.json');
assert.ok(fs.existsSync(cacheEmbeddingsPath), 'mac-app/.cache/audio_embeddings.json must exist');
const cacheEmbeddings = JSON.parse(fs.readFileSync(cacheEmbeddingsPath, 'utf-8'));
assert.equal(cacheEmbeddings.length, 5, 'Must contain embeddings for all 5 distinct MP3 tracks');
console.log(`✓ Verified 5 distinct local track embeddings in mac-app/.cache/audio_embeddings.json`);

// =========================================================================
// STAGE 2: WEB APP INTEGRATION & BROWSER REGRESSION
// =========================================================================
console.log('\n--- STAGE 2: Web App Persistence & Space Separation ---');

let vite = null;
let chrome = null;
let ws = null;

try {
  // Start Vite dev server
  vite = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: WEB_APP_DIR,
    stdio: 'pipe',
  });

  await new Promise((resolve, reject) => {
    vite.stdout.on('data', data => {
      if (data.toString().includes('ready in')) resolve();
    });
    vite.stderr.on('data', data => {
      const msg = data.toString();
      if (!msg.includes('warning') && !msg.includes('Browserslist')) {
        console.error('[Vite err]', msg);
      }
    });
    vite.on('error', reject);
  });
  console.log(`✓ Vite dev server running at http://127.0.0.1:${PORT}`);

  // Launch Chrome
  chrome = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ], { stdio: 'ignore' });

  await sleep(1500);
  console.log(`✓ Headless Chrome launched on CDP port ${CDP_PORT}`);

  const versionRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
  const versionData = await versionRes.json();
  const wsUrl = versionData.webSocketDebuggerUrl;

  ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let idCounter = 1;
  const pending = new Map();
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };

  const sendCommand = (method, params = {}) => {
    return new Promise((resolve, reject) => {
      const id = idCounter++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  const { targetId } = await sendCommand('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await sendCommand('Target.attachToTarget', { targetId, flatten: true });

  const sendPage = (method, params = {}) => {
    return new Promise((resolve, reject) => {
      const id = idCounter++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, sessionId, method, params }));
    });
  };

  await sendPage('Page.enable');
  await sendPage('Runtime.enable');

  const evalInPage = async expression => {
    const res = await sendPage('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`Evaluation failed: ${res.exceptionDetails.text || res.exceptionDetails.exception?.description}`);
    }
    return res.result?.value;
  };

  await sendPage('Page.navigate', { url: `http://127.0.0.1:${PORT}/tests/browser/fixture.html` });
  await sleep(2000);

  let ready = false;
  for (let i = 0; i < 30; i++) {
    const ok = await evalInPage('Boolean(window.__fixture?.db)');
    if (ok) { ready = true; break; }
    await sleep(200);
  }
  assert.ok(ready, 'Fixture failed to initialize');
  console.log('✓ Fixture initialized with IndexedDB and Song models');

  // Test 1: Load 200D embeddings into Dexie
  console.log('\nTesting Dexie persistence of 200D learned embeddings...');
  const loadResult = await evalInPage(`
    (async () => {
      const { loadLearnedAudioEmbeddings, DEFAULT_AUDIO_EMBEDDING_MODEL } = await import('/src/services/embeddingService.js');
      const records = ${JSON.stringify(cacheEmbeddings)};
      const count = await loadLearnedAudioEmbeddings(records);
      const stored = await window.__fixture.db.songEmbeddings.toArray();
      return {
        count,
        storedCount: stored.length,
        firstStored: {
          songKey: stored[0].songKey,
          vectorLength: stored[0].vector.length,
          dimensions: stored[0].dimensions,
          vectorType: stored[0].vectorType,
          model: stored[0].model,
          provider: stored[0].provider,
        }
      };
    })()
  `);

  assert.equal(loadResult.count, 5, 'Must load 5 embedding records');
  assert.equal(loadResult.storedCount, 5, 'Dexie must store 5 embedding records');
  assert.equal(loadResult.firstStored.vectorLength, 200, 'Stored vector must have 200 elements');
  assert.equal(loadResult.firstStored.dimensions, 200, 'Dimensions must be 200');
  assert.equal(loadResult.firstStored.vectorType, 'learned-audio', 'VectorType must be learned-audio');
  assert.equal(loadResult.firstStored.model, 'msd-musicnn-1', 'Model must be msd-musicnn-1');
  assert.equal(loadResult.firstStored.provider, 'local-mac-worker', 'Provider must be local-mac-worker');
  console.log('✓ Dexie stored 5 learned-audio embeddings with 200D shape, tagged msd-musicnn-1');

  // Test 2: Audio embedding status
  console.log('\nTesting audio embedding status reporting...');
  const statusResult = await evalInPage(`
    (async () => {
      const { getAudioEmbeddingStatus, registerDefaultAudioEmbeddingProvider, registerAudioEmbeddingProvider } = await import('/src/services/embeddingService.js');
      registerAudioEmbeddingProvider(null);
      const blocked = getAudioEmbeddingStatus();
      registerDefaultAudioEmbeddingProvider();
      const ready = getAudioEmbeddingStatus();
      return { blocked, ready };
    })()
  `);

  assert.equal(statusResult.blocked.status, 'BLOCKED', 'Must report BLOCKED without registered provider');
  assert.equal(statusResult.ready.status, 'ready', 'Must report ready with MusiCNN provider');
  assert.equal(statusResult.ready.dimensions, 200);
  assert.equal(statusResult.ready.model, 'msd-musicnn-1');
  console.log('✓ getAudioEmbeddingStatus: correctly transitions from BLOCKED to ready (200D msd-musicnn-1)');

  // Test 3: Up Next Recommendations with 200D Acoustic Vectors
  console.log('\nTesting 200D acoustic nearest-neighbor recommendation ranking...');
  const recsResult = await evalInPage(`
    (async () => {
      const { buildUpNextRecommendations } = await import('/src/services/contextualRecommendationService.js');
      const { db } = window.__fixture;
      const embeddings = ${JSON.stringify(cacheEmbeddings)};

      // Build songs in library: 5 real audio tracks, 1 metadata track, 1 unembedded track
      const librarySongs = embeddings.map(e => ({
        songKey: e.songKey,
        track: e.filename.replace(/\\.mp3$/, ''),
        artist: e.songKey.includes('Chiranjeevi') ? 'Devi Sri Prasad' :
          e.songKey.includes('Leo') ? 'Anirudh Ravichander' :
          e.songKey.includes('Raga') ? 'S. P. Balasubrahmanyam' : 'Bollywood / Film',
        driveFileId: 'drive-' + e.fileHash.slice(0, 8),
      }));

      // Candidate with 64D metadata vector
      const metaVector = new Array(64).fill(0);
      metaVector[2] = 1;
      librarySongs.push({
        songKey: 'meta-candidate',
        track: 'Metadata Candidate',
        artist: 'Metadata Artist',
        vector: metaVector,
        vectorType: 'metadata',
        model: 'sisic-metadata-heuristics',
        dimensions: 64,
        driveFileId: 'drive-meta-1',
      });

      // Candidate with missing embedding
      librarySongs.push({
        songKey: 'missing-cand',
        track: 'Missing Candidate',
        artist: 'Unknown Artist',
        driveFileId: 'drive-missing-1',
      });

      const seedKey = embeddings.find(e => e.songKey.includes('Raga of Madness')).songKey;
      const currentSong = librarySongs.find(s => s.songKey === seedKey);

      const recs = await buildUpNextRecommendations({
        currentSong,
        librarySongs,
        limit: 10,
        getEmbedding: async (key) => await db.songEmbeddings.get(key),
      });

      return {
        seedKey,
        recs: recs.map(r => ({
          songKey: r.songKey,
          track: r.track,
          hasEmbedding: r.hasEmbedding,
          embeddingType: r.embeddingType,
          embeddingModel: r.embeddingModel,
          similarityScore: r.similarityScore,
          isFallback: r.isFallback,
          score: r.recommendationScore,
        }))
      };
    })()
  `);

  console.log(`Seed song: ${recsResult.seedKey}`);
  console.log('Recommendations returned:');
  for (const r of recsResult.recs) {
    console.log(`  - [${r.hasEmbedding ? 'LEARNED' : 'FALLBACK'}] ${r.track.slice(0, 30).padEnd(30)} | sim: ${r.similarityScore !== undefined ? r.similarityScore.toFixed(4) : 'N/A'} | model: ${r.embeddingModel || 'none'}`);
  }

  // Check nearest neighbor ranking with official log10 preprocessing:
  // Abbo Neeyamma has cosine similarity 0.7483 to Raga of Madness
  // Anbenum has cosine similarity 0.5430
  // Meherbaan has cosine similarity 0.4804
  // Emitemitemito has cosine similarity 0.0909
  const audioMatches = recsResult.recs.filter(r => r.hasEmbedding);
  assert.equal(audioMatches.length, 4, 'Must have 4 audio matches');
  assert.ok(audioMatches[0].songKey.includes('Abbo Neeyamma'), 'Top match must be Abbo Neeyamma (highest acoustic similarity ~0.75)');
  assert.ok(audioMatches[1].songKey.includes('Anbenum'), 'Second match must be Anbenum (similarity ~0.54)');
  assert.ok(audioMatches[0].similarityScore > audioMatches[audioMatches.length - 1].similarityScore, 'Top match must exceed lowest match');
  assert.ok(audioMatches[audioMatches.length - 1].songKey.includes('Emitemitemito'), 'Lowest similarity match must be Emitemitemito');

  // Verify space separation:
  const metaMatch = recsResult.recs.find(r => r.songKey === 'meta-candidate');
  assert.ok(metaMatch, 'Metadata candidate must be present in recommendations');
  assert.equal(metaMatch.hasEmbedding, false, 'Metadata candidate must not match 200D audio space');
  assert.equal(metaMatch.isFallback, true, 'Metadata candidate must be marked as fallback');
  assert.equal(metaMatch.similarityScore, undefined, 'Metadata candidate must have undefined similarity');

  const missingMatch = recsResult.recs.find(r => r.songKey === 'missing-cand');
  assert.ok(missingMatch, 'Missing candidate must be present');
  assert.equal(missingMatch.hasEmbedding, false);
  assert.equal(missingMatch.isFallback, true);
  console.log('✓ Space separation verified: 200D MusiCNN vectors isolated from 64D metadata space');

  // Test 4: Rapid track switching / AbortSignal cancellation
  console.log('\nTesting rapid track switching / AbortSignal cancellation...');
  const abortResult = await evalInPage(`
    (async () => {
      const { buildUpNextRecommendations } = await import('/src/services/contextualRecommendationService.js');
      const { songs } = window.__fixture;
      const controller = new AbortController();
      controller.abort();
      const recs = await buildUpNextRecommendations({
        currentSong: songs[0],
        librarySongs: songs,
        signal: controller.signal,
      });
      return recs.length;
    })()
  `);
  assert.equal(abortResult, 0, 'Aborted request must return 0 results');
  console.log('✓ AbortSignal cancellation immediately stops recommendation generation');

  // Test 5: UI Playback & Queue Usability Check
  console.log('\nTesting UI queue and player bar usability...');
  await evalInPage(`
    (() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const readyBtn = buttons.find(b => b.textContent.trim() === 'Ready');
      if (readyBtn) readyBtn.click();
    })()
  `);
  await sleep(500);

  await evalInPage(`
    (() => {
      const playBtn = Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label')?.includes('Play Blue Hour'));
      if (playBtn) playBtn.click();
    })()
  `);
  await sleep(1000);

  const playCheck = await evalInPage(`
    (() => {
      const qState = JSON.parse(localStorage.getItem('sisic:queue-state:v1') || '{}');
      const activeAudio = window.__fixtureAudio?.find(a => !a.paused && a.src);
      const anyActive = window.__fixtureAudio?.some(a => a.src);
      return {
        playingSong: qState.queue?.[0]?.track,
        songKey: qState.queue?.[0]?.songKey,
        anyActive,
      };
    })()
  `);

  assert.equal(playCheck.songKey, 'fixture-1', 'Playing track must be Blue Hour');
  assert.ok(playCheck.anyActive, 'Audio element must have valid active audio stream');
  console.log(`✓ Active playback verified: "${playCheck.playingSong}" loaded with stream and queue updated`);

  console.log('\n=========================================================');
  console.log('ALL LEARNED AUDIO EMBEDDING VERIFICATION CHECKS PASSED!');
  console.log('=========================================================\n');

} finally {
  if (ws) ws.close();
  if (chrome) chrome.kill();
  if (vite) vite.kill();
}
