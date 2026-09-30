import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 5193;
const CDP_PORT = 9228;
const SCREENSHOT_DIR = '/Users/sidslaptop/dev/sisic music/screenshots';

await mkdir(SCREENSHOT_DIR, { recursive: true });

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

let wsUrl;
for (let i = 0; i < 20; i++) {
  try {
    const versionRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    const versionData = await versionRes.json();
    wsUrl = versionData.webSocketDebuggerUrl;
    if (wsUrl) break;
  } catch {
    await sleep(200);
  }
}
assert.ok(wsUrl, 'Failed to connect to headless Chrome CDP');

try {
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

  const setViewport = async (width, height) => {
    await sendPage('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: width <= 768,
    });
    await sleep(200);
  };

  const captureScreenshot = async filename => {
    const { data } = await sendPage('Page.captureScreenshot', { format: 'png' });
    const buffer = Buffer.from(data, 'base64');
    await writeFile(`${SCREENSHOT_DIR}/${filename}`, buffer);
    console.log(`  Saved screenshot: ${SCREENSHOT_DIR}/${filename}`);
  };

  // Navigate to fixture
  await sendPage('Page.navigate', { url: `http://127.0.0.1:${PORT}/tests/browser/fixture.html` });
  await sleep(2000);

  // Play a song so player bar has content
  await evalInPage(`
    (() => {
      const playBtn = Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label')?.includes('Play Amber Coast'));
      if (playBtn) playBtn.click();
    })()
  `);
  await sleep(500);

  const viewports = [
    { name: 'mobile-320-568', width: 320, height: 568 },
    { name: 'mobile-390', width: 390, height: 844 },
    { name: 'tablet-768', width: 768, height: 1024 },
    { name: 'tablet-1024', width: 1024, height: 768 },
    { name: 'desktop-1440', width: 1440, height: 900 },
  ];

  for (const vp of viewports) {
    console.log(`\nTesting viewport: ${vp.name} (${vp.width}x${vp.height})...`);
    await setViewport(vp.width, vp.height);

    // 1. Check no unintended horizontal overflow
    const overflowInfo = await evalInPage(`
      (() => {
        const scrollW = document.documentElement.scrollWidth;
        const innerW = window.innerWidth;
        return { scrollW, innerW, hasOverflow: scrollW > innerW };
      })()
    `);
    console.log(`  Horizontal bounds: scrollWidth=${overflowInfo.scrollW}px, innerWidth=${overflowInfo.innerW}px`);
    assert.equal(overflowInfo.hasOverflow, false, `No horizontal overflow at ${vp.name}`);

    // 2. Check essential touch targets
    const touchTargets = await evalInPage(`
      (() => {
        const selectors = [
          '.play-btn',
          '.player-buttons .icon-btn',
          '.playback-settings summary',
          '.mobile-nav__btn',
        ];
        const issues = [];
        for (const sel of selectors) {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            // only check visible elements
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              if (r.width < 43.5 || r.height < 43.5) {
                issues.push({
                  selector: sel,
                  text: el.textContent?.trim().slice(0, 15),
                  w: Math.round(r.width),
                  h: Math.round(r.height),
                });
              }
            }
          }
        }
        return issues;
      })()
    `);
    console.log(`  Touch target issues: ${touchTargets.length}`);
    if (touchTargets.length > 0) {
      console.warn('  Touch targets under 44px:', touchTargets);
    }
    assert.equal(touchTargets.length, 0, `All essential touch targets must be >= 44x44px at ${vp.name}`);

    await captureScreenshot(`${vp.name}-home.png`);

    // 3. Test Expanded Player at this viewport
    await evalInPage(`
      (() => {
        const openBtn = document.querySelector('.player-song-info__open');
        if (openBtn) openBtn.click();
      })()
    `);
    await sleep(400);

    const expandedCheck = await evalInPage(`
      (() => {
        const ep = document.querySelector('.expanded-player');
        if (!ep) return { mounted: false };
        const bodyOverflow = document.body.style.overflow;
        const art = document.querySelector('.expanded-player__art-container')?.getBoundingClientRect();
        const details = document.querySelector('.expanded-player__details-column')?.getBoundingClientRect();
        const platter = document.querySelector('.turntable')?.getBoundingClientRect();
        const content = document.querySelector('.expanded-player__content');

        const initialScrollTop = content ? content.scrollTop : 0;
        const scrollHeight = content ? content.scrollHeight : 0;
        const clientHeight = content ? content.clientHeight : 0;
        const isScrollable = scrollHeight > clientHeight;

        if (content && isScrollable) {
          content.scrollTo({ top: content.scrollHeight, behavior: 'instant' });
        }

        const actionBtns = Array.from(document.querySelectorAll('.expanded-player__actions button, .expanded-player__actions a'));
        const actionSizesOk = actionBtns.every(btn => {
          const r = btn.getBoundingClientRect();
          return r.width >= 43.5 && r.height >= 43.5;
        });
        const lastBtn = actionBtns[actionBtns.length - 1];
        const lastRect = lastBtn?.getBoundingClientRect();
        const bottomButtonVisible = Boolean(lastRect && lastRect.top >= 0 && lastRect.bottom <= window.innerHeight);
        const bottomControlsReachable = actionBtns.length === 0 || (actionSizesOk && bottomButtonVisible);

        if (content) content.scrollTo({ top: initialScrollTop, behavior: 'instant' });

        return {
          mounted: true,
          bodyOverflow,
          artWidth: art ? Math.round(art.width) : 0,
          detailsTop: details ? Math.round(details.top) : 0,
          platterWidth: platter ? Math.round(platter.width) : 0,
          isScrollable,
          scrollHeight,
          clientHeight,
          bottomControlsReachable,
        };
      })()
    `);
    assert.equal(expandedCheck.mounted, true, 'Expanded player must mount');
    assert.equal(expandedCheck.bodyOverflow, 'hidden', 'Background scroll must be locked when expanded player is active');
    console.log(`  Expanded player mounted, scrollable=${expandedCheck.isScrollable} (${expandedCheck.scrollHeight}px/${expandedCheck.clientHeight}px), bottomControlsReachable=${expandedCheck.bottomControlsReachable}`);

    if (vp.name === 'mobile-320-568') {
      const scrollPerf = await evalInPage(`
        (async () => {
          const content = document.querySelector('.expanded-player__content') || document.documentElement;
          const durations = [];
          for (let step = 0; step < 10; step++) {
            const start = performance.now();
            content.scrollTop = step * 25;
            await new Promise(r => requestAnimationFrame(r));
            durations.push(performance.now() - start);
          }
          const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
          const max = Math.max(...durations);
          return { avg, max };
        })()
      `);
      console.log(`  320x568 scroll callback execution duration: avg=${scrollPerf.avg.toFixed(2)}ms, max=${scrollPerf.max.toFixed(2)}ms`);
    }

    await captureScreenshot(`${vp.name}-expanded.png`);

    // Close expanded player
    await evalInPage(`
      (() => {
        const closeBtn = document.querySelector('button[aria-label="Minimize player"]');
        if (closeBtn) closeBtn.click();
      })()
    `);
    await sleep(300);

    // Verify background scroll unlocked after close
    const restoredOverflow = await evalInPage(`document.body.style.overflow`);
    assert.equal(restoredOverflow, '', 'Background scroll must restore after closing dialog');
  }

  console.log('\n========================================');
  console.log('ALL TASK 4 RESPONSIVE CHECKS PASSED');
  console.log('========================================\n');
} catch (err) {
  console.error('Task 4 test failed:', err);
  throw err;
} finally {
  if (ws) ws.close();
  chrome.kill('SIGTERM');
  vite.kill('SIGTERM');
}
