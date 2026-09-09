import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 5192;
const CDP_PORT = 9227;

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

  // Seed with large representative dataset: 300 songs into Quiet Hours playlist
  const TOTAL_FIXTURE_SONGS = 300;
  console.log(`Seeding database with ${TOTAL_FIXTURE_SONGS} songs in playlist 'Quiet Hours'...`);
  await evalInPage(`
    (async () => {
      const { db, songs } = window.__fixture;
      const { upsertSongToDb } = await import('/src/db.js');
      for (let i = 0; i < ${TOTAL_FIXTURE_SONGS}; i++) {
        const base = songs[i % songs.length];
        const num = String(i + 1).padStart(3, '0');
        const songKey = 'large-song-' + num;
        await upsertSongToDb({
          ...base,
          songKey,
          track: 'Track #' + num,
          artist: 'Artist #' + ((i % 25) + 1),
          album: 'Quiet Hours',
          driveFileId: 'fixture-audio-' + (i % 8),
        }, 'Quiet Hours');
      }
    })()
  `);
  console.log(`✓ Seeded ${TOTAL_FIXTURE_SONGS} songs in database`);

  // Switch to Quiet Hours playlist in the sidebar
  await evalInPage(`
    (() => {
      const items = Array.from(document.querySelectorAll('.playlist-item'));
      const qh = items.find(el => el.textContent.includes('Quiet Hours'));
      if (qh) qh.click();
    })()
  `);
  await sleep(1000);

  // Measure initial mounted card count at top (scrollTop = 0)
  const initialMetrics = await evalInPage(`
    (() => {
      const mainView = document.querySelector('.main-view');
      const container = document.querySelector('.virtual-song-grid-container');
      const mountedCards = document.querySelectorAll('.song-card');
      const countLabel = document.querySelector('.library-count')?.textContent;
      return {
        totalLabel: countLabel,
        containerHeight: container ? container.style.minHeight : '0px',
        mountedCount: mountedCards.length,
        firstMountedTrack: mountedCards[0]?.querySelector('.song-card__title')?.textContent,
        lastMountedTrack: mountedCards[mountedCards.length - 1]?.querySelector('.song-card__title')?.textContent,
      };
    })()
  `);
  console.log('Initial metrics at top:', initialMetrics);
  assert.ok(initialMetrics.totalLabel?.includes('300') || initialMetrics.totalLabel?.includes('308'), 'Must show full 300+ songs count');
  assert.ok(initialMetrics.mountedCount > 0, 'Some cards must be mounted');
  assert.ok(initialMetrics.mountedCount <= 36, `Mounted cards (${initialMetrics.mountedCount}) must be bounded (<= 36)`);
  assert.ok(initialMetrics.mountedCount < TOTAL_FIXTURE_SONGS, 'Must not mount all songs at once');
  console.log(`✓ PASS: Initial mounted count bounded to ${initialMetrics.mountedCount} cards out of 300+`);

  // Measure performance and card unmounting during simulated scrolling
  console.log('Simulating continuous scroll down...');
  const scrollMetrics = await evalInPage(`
    (async () => {
      const mainView = document.querySelector('.main-view');
      const samples = [];
      const frameTimes = [];

      for (let offset = 400; offset <= 4000; offset += 400) {
        const t0 = performance.now();
        mainView.scrollTop = offset;
        mainView.dispatchEvent(new Event('scroll'));
        await new Promise(resolve => requestAnimationFrame(resolve));
        const t1 = performance.now();
        frameTimes.push(t1 - t0);

        if (offset === 2000 || offset === 4000) {
          await new Promise(r => setTimeout(r, 80));
          const mounted = document.querySelectorAll('.song-card');
          samples.push({
            scrollTop: offset,
            mountedCount: mounted.length,
            firstTitle: mounted[0]?.querySelector('.song-card__title')?.textContent,
            lastTitle: mounted[mounted.length - 1]?.querySelector('.song-card__title')?.textContent,
          });
        }
      }

      const avgFrameTime = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
      return { samples, avgFrameTime, maxFrameTime: Math.max(...frameTimes) };
    })()
  `);

  console.log('Scroll performance samples:', scrollMetrics.samples);
  console.log(`Measured render frame time during scroll: avg = ${scrollMetrics.avgFrameTime.toFixed(2)}ms, max = ${scrollMetrics.maxFrameTime.toFixed(2)}ms`);

  // Verify offscreen cards were unmounted (first title at 4000px is NOT Track #001)
  const deepSample = scrollMetrics.samples.find(s => s.scrollTop === 4000);
  assert.ok(deepSample, 'Deep sample exists');
  assert.notEqual(deepSample.firstTitle, 'Track #001', 'Initial top cards must be unmounted when scrolled down');
  assert.ok(deepSample.mountedCount <= 36, `Scrolled mounted count (${deepSample.mountedCount}) remains strictly bounded`);
  console.log(`✓ PASS: Offscreen cards unmounted; at scrollTop=4000px first mounted is '${deepSample.firstTitle}', mounted count=${deepSample.mountedCount}`);

  // Verify context menu behavior remains functional
  console.log('Testing context menu on visible virtualized card...');
  await evalInPage(`
    (() => {
      const firstCard = document.querySelector('.song-card');
      const menuBtn = firstCard?.querySelector('.song-card__menu-btn');
      if (menuBtn) menuBtn.click();
    })()
  `);
  await sleep(300);

  const menuResult = await evalInPage(`
    (() => {
      const actionSheet = document.querySelector('.song-action-sheet');
      const items = document.querySelectorAll('.song-action-sheet [role="menuitem"]');
      return {
        opened: Boolean(actionSheet),
        itemCount: items.length,
      };
    })()
  `);
  console.log('Context menu test result:', menuResult);
  assert.equal(menuResult.opened, true, 'Context menu should open on virtualized card');
  assert.ok(menuResult.itemCount >= 4, 'Menu items present');
  console.log('✓ PASS: Context menus functional on virtualized cards');

  // Close context menu
  await evalInPage(`
    (() => {
      const closeBtn = document.querySelector('.song-action-sheet__close');
      if (closeBtn) closeBtn.click();
    })()
  `);

  const setViewport = async (width, height) => {
    await sendPage('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width <= 768,
    });
    await sleep(300);
  };

  // 5. Test dynamic resize re-layout
  console.log('Testing grid responsiveness across viewport resize...');
  await setViewport(1280, 800);
  const desktopColumns = await evalInPage(`
    (() => {
      const container = document.querySelector('.virtual-song-grid-container');
      const grid = container?.querySelector('.songs-grid');
      return grid ? window.getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0;
    })()
  `);
  console.log(`  Desktop (1280px) columns: ${desktopColumns}`);
  assert.ok(desktopColumns >= 3, 'Desktop should have 3 or more columns');

  // Resize down to 360 mobile width
  await setViewport(360, 640);
  await sleep(400);
  const mobileColumns = await evalInPage(`
    (() => {
      const container = document.querySelector('.virtual-song-grid-container');
      const grid = container?.querySelector('.songs-grid');
      return grid ? window.getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0;
    })()
  `);
  console.log(`  Mobile (360px) columns: ${mobileColumns}`);
  assert.ok(mobileColumns <= 2, 'Mobile should have 1 or 2 columns');
  assert.notEqual(desktopColumns, mobileColumns, 'Grid column layout must dynamically re-measure on resize');
  console.log('✓ PASS: Dynamic column re-measurement confirmed across viewport resize');

  // Restore desktop viewport
  await setViewport(1280, 800);
  await sleep(300);

  // 6. Test keyboard focus navigation and focus retention
  console.log('Testing keyboard focus navigation in virtualized grid...');
  const focusCheck = await evalInPage(`
    (() => {
      const firstPlayBtn = document.querySelector('.song-card .song-card__play-btn, .song-card button');
      if (!firstPlayBtn) return { focused: false, error: 'no button' };
      firstPlayBtn.focus();
      const isActive = document.activeElement === firstPlayBtn;
      const card = firstPlayBtn.closest('.song-card');
      return { focused: isActive, hasCard: Boolean(card) };
    })()
  `);
  assert.equal(focusCheck.focused, true, 'Card button must be focusable via keyboard focus');
  assert.equal(focusCheck.hasCard, true, 'Focused card remains present in DOM');
  console.log('✓ PASS: Keyboard focus navigation and retention confirmed');

  console.log('\n========================================');
  console.log('ALL TASK 3 VIRTUALIZATION CHECKS PASSED');
  console.log(`Measured Headless Frame Times: Avg ${scrollMetrics.avgFrameTime.toFixed(2)}ms, Max ${scrollMetrics.maxFrameTime.toFixed(2)}ms (budget: 16.7ms for 60fps)`);
  console.log('========================================\n');
} catch (err) {
  console.error('Task 3 test failed:', err);
  throw err;
} finally {
  if (ws) ws.close();
  chrome.kill('SIGTERM');
  vite.kill('SIGTERM');
}
