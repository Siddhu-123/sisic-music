import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 5191;
const CDP_PORT = 9226;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 1. Start Vite dev server
const vite = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
  cwd: '/Users/sidslaptop/dev/sisic music/web-app',
  stdio: 'pipe',
});

await new Promise((resolve, reject) => {
  vite.stdout.on('data', data => {
    if (data.toString().includes('ready in')) resolve();
  });
  vite.stderr.on('data', data => console.error('[Vite err]', data.toString()));
  vite.on('error', reject);
});
console.log('✓ Vite dev server running on port', PORT);

// 2. Start headless Chrome
const chrome = spawn(CHROME_PATH, [
  '--headless=new',
  `--remote-debugging-port=${CDP_PORT}`,
  '--autoplay-policy=no-user-gesture-required',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  'about:blank',
], { stdio: 'ignore' });

await sleep(1500);
console.log('✓ Headless Chrome launched on debug port', CDP_PORT);

let ws;
let sendCommand;

try {
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

  sendCommand = (method, params = {}) => {
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

  // Navigate to fixture
  await sendPage('Page.navigate', { url: `http://127.0.0.1:${PORT}/tests/browser/fixture.html` });
  await sleep(2000);

  let ready = false;
  for (let i = 0; i < 30; i++) {
    const ok = await evalInPage('Boolean(window.__fixture?.db)');
    if (ok) { ready = true; break; }
    await sleep(200);
  }
  assert.ok(ready, 'Fixture failed to initialize');
  console.log('✓ Fixture initialized with DB and Songs');

  // Insert real 64D unit embeddings for fixture songs
  await evalInPage(`
    (async () => {
      const { db, songs } = window.__fixture;
      // create 64D unit vectors for all songs
      for (let i = 0; i < songs.length; i++) {
        const v = new Array(64).fill(0);
        v[i % 64] = 1;
        await db.songEmbeddings.put({
          songKey: songs[i].songKey,
          vector: v,
          updatedAt: new Date().toISOString(),
        });
      }
    })()
  `);
  console.log('✓ Seeded fixture song embeddings in IndexedDB');

  // Click Ready navigation button to go to Library view
  await evalInPage(`
    (() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const readyBtn = buttons.find(b => b.textContent.trim() === 'Ready');
      if (readyBtn) readyBtn.click();
    })()
  `);
  await sleep(500);

  // =========================================================================
  // TEST 1: Search selection queues ONLY selected track (batch excluded)
  // =========================================================================
  console.log('Testing Test 1: Search selection queues ONLY selected track...');
  // Type search term matching multiple tracks: "e" matches Blue Hour, Cedar Light, Evening Tide, etc.
  await evalInPage(`
    (() => {
      const searchInput = document.querySelector('input[type="search"]') || document.querySelector('input[placeholder*="Search"]');
      if (searchInput) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(searchInput, 'Hour');
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()
  `);
  await sleep(600);

  // Click Play Blue Hour
  await evalInPage(`
    (() => {
      const playBtn = Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label')?.includes('Play Blue Hour'));
      if (playBtn) playBtn.click();
    })()
  `);
  await sleep(1000);

  let qState = await evalInPage(`JSON.parse(localStorage.getItem('sisic:queue-state:v1'))`);
  assert.ok(qState, 'Queue state must exist in localStorage');
  assert.equal(qState.queue[0]?.songKey, 'fixture-1', 'Playing song must be Blue Hour (fixture-1)');
  
  // Verify that subsequent items in the queue are NOT the rest of the search query batch
  // but are recommendation tracks (which have hasEmbedding or recommendationScore)
  console.log('Queue tracks after search play:', qState.queue.map(s => `${s.track} (isRec: ${s.hasEmbedding ?? false})`));
  const nonRecUpcoming = qState.queue.slice(1).filter(s => !s.hasEmbedding && !s.isFallback && s.recommendationScore === undefined);
  assert.equal(nonRecUpcoming.length, 0, 'No other search batch tracks entered the queue');
  console.log('✓ PASS Test 1: Search selection queues ONLY the selected track');

  // =========================================================================
  // TEST 2: Add to queue / Manual queue priority ahead of recommendations
  // =========================================================================
  console.log('Testing Test 2: Manual queue priority and preservation...');
  // Clear search input
  await evalInPage(`
    (() => {
      const searchInput = document.querySelector('input[type="search"]') || document.querySelector('input[placeholder*="Search"]');
      if (searchInput) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(searchInput, '');
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()
  `);
  await sleep(500);

  // Open menu for Cedar Light and click "Queue"
  await evalInPage(`
    (() => {
      const menuBtn = document.querySelector('button[aria-label="More actions for Cedar Light"]');
      if (menuBtn) menuBtn.click();
    })()
  `);
  await sleep(300);

  await evalInPage(`
    (() => {
      const queueAction = Array.from(document.querySelectorAll('[role="menuitem"]')).find(el => el.textContent.includes('Queue'));
      if (queueAction) queueAction.click();
    })()
  `);
  await sleep(500);

  qState = await evalInPage(`JSON.parse(localStorage.getItem('sisic:queue-state:v1'))`);
  console.log('Manual queue in localStorage:', (qState.manualQueue || []).map(s => s.track));
  assert.equal(qState.manualQueue?.length, 1, 'Manual queue must have 1 track');
  assert.equal(qState.manualQueue[0]?.songKey, 'fixture-2', 'Manual queue must be Cedar Light');
  // In the active queue, Cedar Light must be placed immediately after the current playing track (index 0)
  assert.equal(qState.queue[1]?.songKey, 'fixture-2', 'Manual queue track must be ahead of auto-recommendations');
  console.log('✓ PASS Test 2: Manual queue track takes priority over auto-recommendations');

  // =========================================================================
  // TEST 3: Switching track preserves unplayed manual queue
  // =========================================================================
  console.log('Testing Test 3: Track change preserves manual queue priority...');
  // Now click Play Harbour (fixture-7)
  await evalInPage(`
    (() => {
      const playBtn = Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label')?.includes('Play Harbour'));
      if (playBtn) playBtn.click();
    })()
  `);
  await sleep(1000);

  qState = await evalInPage(`JSON.parse(localStorage.getItem('sisic:queue-state:v1'))`);
  console.log('Queue tracks after playing Harbour:', qState.queue.map(s => s.track));
  assert.equal(qState.queue[0]?.songKey, 'fixture-7', 'Playing track must be Harbour');
  assert.equal(qState.queue[1]?.songKey, 'fixture-2', 'Manual queue track Cedar Light must be preserved at index 1');
  console.log('✓ PASS Test 3: Unplayed manual queue preserved and prioritized across track changes');

  // =========================================================================
  // TEST 4: Real embedding nearest-neighbor scoring & candidate exclusion
  // =========================================================================
  console.log('Testing Test 4: Real embedding cosine similarity and candidate exclusion...');
  const recTest = await evalInPage(`
    (async () => {
      const { buildUpNextRecommendations } = await import('/src/services/contextualRecommendationService.js');
      const { db, songs } = window.__fixture;

      // Current song is songs[0] (Amber Coast, vector basis 0)
      // Let's create an explicit near-neighbor (basis 0 with 0.95 similarity)
      const nearVector = new Array(64).fill(0);
      nearVector[0] = 0.95;
      nearVector[1] = 0.31; // unit normalized

      await db.songEmbeddings.put({
        songKey: songs[3].songKey,
        vector: nearVector,
        updatedAt: new Date().toISOString(),
      });

      const recs = await buildUpNextRecommendations({
        currentSong: songs[0],
        librarySongs: songs,
        recentlyPlayedKeys: [songs[1].songKey], // Blue Hour excluded
        manualQueue: [songs[2]], // Cedar Light excluded
        limit: 3,
        getEmbedding: async (key) => await db.songEmbeddings.get(key),
      });

      return {
        keys: recs.map(s => s.songKey),
        topKey: recs[0]?.songKey,
        hasEmbedding: recs[0]?.hasEmbedding,
        similarityScore: recs[0]?.similarityScore,
        isFallback: recs[0]?.isFallback,
      };
    })()
  `);

  console.log('Recommendation engine test result:', recTest);
  assert.ok(!recTest.keys.includes('fixture-0'), 'Must exclude current song');
  assert.ok(!recTest.keys.includes('fixture-1'), 'Must exclude recently played song');
  assert.ok(!recTest.keys.includes('fixture-2'), 'Must exclude manual queue song');
  assert.equal(recTest.topKey, 'fixture-3', 'Nearest neighbor by cosine similarity must rank highest');
  assert.equal(recTest.hasEmbedding, true, 'hasEmbedding must be true for real vector match');
  assert.equal(recTest.isFallback, false, 'isFallback must be false for real vector match');
  assert.ok(recTest.similarityScore > 0.9, 'Cosine similarity must match calculated dot product');
  console.log('✓ PASS Test 4: Real embedding nearest-neighbor similarity and honest scoring');

  // =========================================================================
  // TEST 5: Honest fallback when embeddings are absent
  // =========================================================================
  console.log('Testing Test 5: Honest fallback when embeddings are missing...');
  const fallbackTest = await evalInPage(`
    (async () => {
      const { buildUpNextRecommendations } = await import('/src/services/contextualRecommendationService.js');
      const { songs } = window.__fixture;

      // Call without getEmbedding and with songs lacking vector
      const noVectorSongs = songs.map(({ vector, ...rest }) => rest);
      const recs = await buildUpNextRecommendations({
        currentSong: noVectorSongs[0],
        librarySongs: noVectorSongs,
        limit: 3,
        getEmbedding: async () => null,
      });

      return {
        keys: recs.map(s => s.songKey),
        allFallback: recs.every(s => s.isFallback === true && s.hasEmbedding === false && s.similarityScore === undefined),
      };
    })()
  `);
  console.log('Fallback test result:', fallbackTest);
  assert.ok(fallbackTest.keys.length > 0, 'Fallback recommendations should return contextual songs');
  assert.equal(fallbackTest.allFallback, true, 'Fallback songs must honestly state isFallback: true and no fake embedding');
  console.log('✓ PASS Test 5: Honest fallback behavior without fake vectors');

  console.log('\n========================================');
  console.log('ALL TASK 2 INTEGRATION TESTS PASSED (5/5)');
  console.log('========================================\n');
} catch (err) {
  console.error('Test failure:', err);
  throw err;
} finally {
  if (ws) ws.close();
  chrome.kill('SIGTERM');
  vite.kill('SIGTERM');
}
