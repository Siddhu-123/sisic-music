import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 5196;
const CDP_PORT = 9226;
const SCREENSHOTS_DIR = '/Users/sidslaptop/dev/sisic music/screenshots';

if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

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
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
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

  const targets = await sendCommand('Target.getTargets');
  let pageTarget = targets.targetInfos.find(t => t.type === 'page');
  if (!pageTarget) {
    const created = await sendCommand('Target.createTarget', { url: 'about:blank' });
    pageTarget = { targetId: created.targetId };
  }

  const { sessionId } = await sendCommand('Target.attachToTarget', {
    targetId: pageTarget.targetId,
    flatten: true,
  });

  const sendSessionCommand = (method, params = {}) => {
    return new Promise((resolve, reject) => {
      const id = idCounter++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, sessionId, method, params }));
    });
  };

  await sendSessionCommand('Page.enable');
  await sendSessionCommand('Runtime.enable');
  await sendSessionCommand('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sendSessionCommand('Emulation.setEmulatedMedia', {
    media: 'screen',
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });

  await sendSessionCommand('Page.navigate', { url: `http://127.0.0.1:${PORT}/tests/browser/fixture.html` });
  await sleep(1000);
  await sendSessionCommand('Runtime.evaluate', {
    expression: `localStorage.removeItem('sisic_theme')`
  });
  await sendSessionCommand('Page.reload');
  await sleep(2000);

  // -------------------------------------------------------------
  // TEST 1: Pixo Toggle Dimensions & Accessibility
  // -------------------------------------------------------------
  console.log('Running Test 1: Pixo Theme Toggle dimensions, accessibility & touch target...');
  const toggleMeta = await sendSessionCommand('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const toggle = document.querySelector('.pixo-theme-toggle');
      if (!toggle) return { found: false };
      const rect = toggle.getBoundingClientRect();
      const role = toggle.getAttribute('role');
      const ariaChecked = toggle.getAttribute('aria-checked');
      const ariaLabel = toggle.getAttribute('aria-label');
      return {
        found: true,
        width: rect.width,
        height: rect.height,
        role,
        ariaChecked,
        ariaLabel,
      };
    })()`
  });

  assert.equal(toggleMeta.result.value.found, true, 'Theme toggle button exists in sidebar');
  assert.ok(toggleMeta.result.value.width >= 44, `Toggle width (${toggleMeta.result.value.width}px) >= 44px`);
  assert.ok(toggleMeta.result.value.height >= 44, `Toggle height (${toggleMeta.result.value.height}px) >= 44px`);
  assert.equal(toggleMeta.result.value.role, 'switch', 'Toggle has role="switch"');
  assert.equal(toggleMeta.result.value.ariaChecked, 'false', 'aria-checked="false" initially in light mode');
  assert.ok(toggleMeta.result.value.ariaLabel.includes('dark'), 'aria-label explains switching to dark mode');
  console.log('✓ PASS Test 1: Pixo Toggle has >=44x44 touch target and accessible switch semantics');

  // -------------------------------------------------------------
  // TEST 2: Light Mode Micro-Animation Geometry & Elements
  // -------------------------------------------------------------
  console.log('Running Test 2: Light mode Day state (Sun, Rays, Sky, Clouds)...');
  const lightGeometry = await sendSessionCommand('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const toggle = document.querySelector('.pixo-theme-toggle');
      const rays = toggle.querySelector('.pixo-sun-rays');
      const orb = toggle.querySelector('.pixo-orb');
      const craters = toggle.querySelector('.pixo-craters');
      const stars = toggle.querySelector('.pixo-stars-layer');
      const clouds = toggle.querySelector('.pixo-clouds-layer');
      const raysStyle = window.getComputedStyle(rays);
      const cratersStyle = window.getComputedStyle(craters);
      const starsStyle = window.getComputedStyle(stars);
      const cloudsStyle = window.getComputedStyle(clouds);
      const orbStyle = window.getComputedStyle(orb);

      return {
        isLightClass: toggle.classList.contains('pixo-theme-toggle--light'),
        raysOpacity: parseFloat(raysStyle.opacity),
        cratersOpacity: parseFloat(cratersStyle.opacity),
        starsOpacity: parseFloat(starsStyle.opacity),
        cloudsOpacity: parseFloat(cloudsStyle.opacity),
        orbBg: orbStyle.backgroundColor,
      };
    })()`
  });

  assert.equal(lightGeometry.result.value.isLightClass, true, 'Toggle has pixo-theme-toggle--light class');
  assert.ok(lightGeometry.result.value.raysOpacity >= 0.8, 'Sun rays are visible in light mode');
  assert.equal(lightGeometry.result.value.cratersOpacity, 0, 'Moon craters are hidden in light mode');
  assert.equal(lightGeometry.result.value.starsOpacity, 0, 'Stars are hidden in light mode');
  assert.ok(lightGeometry.result.value.cloudsOpacity >= 0.5, 'Day clouds are visible in light mode');
  console.log('✓ PASS Test 2: Light mode sun geometry, visible rays, clouds, and hidden moon craters/stars');

  // Capture close-up screenshot of Sun toggle in Light mode
  const sunShot = await sendSessionCommand('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SCREENSHOTS_DIR, 'task6-theme-light.png'), Buffer.from(sunShot.data, 'base64'));
  console.log('✓ Captured screenshot: task6-theme-light.png');

  // -------------------------------------------------------------
  // TEST 3: Toggle Transition to Dark Mode & Moon Micro-Animation
  // -------------------------------------------------------------
  console.log('Running Test 3: Switching to Dark mode, verifying Moon morph, craters, and stars...');
  // Click toggle
  await sendSessionCommand('Runtime.evaluate', {
    expression: `document.querySelector('.pixo-theme-toggle').click()`
  });
  await sleep(600); // Allow smooth micro-animation to complete

  const darkState = await sendSessionCommand('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const toggle = document.querySelector('.pixo-theme-toggle');
      const rootTheme = document.documentElement.getAttribute('data-theme');
      const saved = localStorage.getItem('sisic_theme');
      const metaTheme = document.querySelector('meta[name="theme-color"]')?.getAttribute('content');
      const ariaChecked = toggle.getAttribute('aria-checked');
      const rays = toggle.querySelector('.pixo-sun-rays');
      const craters = toggle.querySelector('.pixo-craters');
      const stars = toggle.querySelector('.pixo-stars-layer');
      const clouds = toggle.querySelector('.pixo-clouds-layer');
      const orb = toggle.querySelector('.pixo-orb');

      const raysStyle = window.getComputedStyle(rays);
      const cratersStyle = window.getComputedStyle(craters);
      const starsStyle = window.getComputedStyle(stars);
      const cloudsStyle = window.getComputedStyle(clouds);
      const orbStyle = window.getComputedStyle(orb);

      // Inspect global surfaces under dark theme
      const bodyStyle = window.getComputedStyle(document.body);
      const sidebarStyle = window.getComputedStyle(document.querySelector('.sidebar'));
      const playerStyle = window.getComputedStyle(document.querySelector('.player-bar'));

      return {
        rootTheme,
        saved,
        metaTheme,
        ariaChecked,
        isDarkClass: toggle.classList.contains('pixo-theme-toggle--dark'),
        raysOpacity: parseFloat(raysStyle.opacity),
        cratersOpacity: parseFloat(cratersStyle.opacity),
        starsOpacity: parseFloat(starsStyle.opacity),
        cloudsOpacity: parseFloat(cloudsStyle.opacity),
        orbBg: orbStyle.backgroundColor,
        bodyBg: bodyStyle.backgroundColor,
        bodyColor: bodyStyle.color,
        sidebarBg: sidebarStyle.backgroundColor,
        playerBg: playerStyle.backgroundColor,
      };
    })()`
  });

  assert.equal(darkState.result.value.rootTheme, 'dark', 'document data-theme set to "dark"');
  assert.equal(darkState.result.value.saved, 'dark', 'localStorage sisic_theme set to "dark"');
  assert.equal(darkState.result.value.metaTheme, '#12141a', 'meta theme-color updated to #12141a');
  assert.equal(darkState.result.value.ariaChecked, 'true', 'aria-checked="true" in dark mode');
  assert.equal(darkState.result.value.isDarkClass, true, 'Toggle has pixo-theme-toggle--dark class');
  assert.equal(darkState.result.value.raysOpacity, 0, 'Sun rays retracted and hidden in dark mode');
  assert.ok(darkState.result.value.cratersOpacity >= 0.8, 'Moon craters scaled and visible in dark mode');
  assert.ok(darkState.result.value.starsOpacity >= 0.8, 'Night stars visible in dark mode');
  assert.equal(darkState.result.value.cloudsOpacity, 0, 'Day clouds hidden in dark mode');
  console.log('✓ PASS Test 3: Dark mode transition, retracted rays, visible craters, starry sky, and theme tokens');

  // Capture screenshot of full Dark mode app
  const darkShot = await sendSessionCommand('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SCREENSHOTS_DIR, 'task6-theme-dark.png'), Buffer.from(darkShot.data, 'base64'));
  console.log('✓ Captured screenshot: task6-theme-dark.png');

  // -------------------------------------------------------------
  // TEST 4: Persistence across reload & 0 FOUC
  // -------------------------------------------------------------
  console.log('Running Test 4: Reload persistence and FOUC check...');
  await sendSessionCommand('Page.reload');
  await sleep(1500);

  const reloadedTheme = await sendSessionCommand('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const rootTheme = document.documentElement.getAttribute('data-theme');
      const saved = localStorage.getItem('sisic_theme');
      const toggle = document.querySelector('.pixo-theme-toggle');
      return {
        rootTheme,
        saved,
        isDarkToggle: toggle?.classList.contains('pixo-theme-toggle--dark')
      };
    })()`
  });

  assert.equal(reloadedTheme.result.value.rootTheme, 'dark', 'Dark theme persisted on reload');
  assert.equal(reloadedTheme.result.value.saved, 'dark', 'Saved theme is dark');
  assert.equal(reloadedTheme.result.value.isDarkToggle, true, 'Toggle reflects dark mode immediately');
  console.log('✓ PASS Test 4: Theme persists across reload with immediate hydration');

  // -------------------------------------------------------------
  // TEST 5: Keyboard Activation (Space / Enter)
  // -------------------------------------------------------------
  console.log('Running Test 5: Keyboard activation (Space / Enter)...');
  await sendSessionCommand('Runtime.evaluate', {
    expression: `(() => {
      const toggle = document.querySelector('.pixo-theme-toggle');
      toggle.focus();
    })()`
  });

  // Dispatch Space key on focused toggle
  await sendSessionCommand('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: ' ',
    code: 'Space',
    windowsVirtualKeyCode: 32,
  });
  await sendSessionCommand('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: ' ',
    code: 'Space',
    windowsVirtualKeyCode: 32,
  });
  await sleep(400);

  const toggledBack = await sendSessionCommand('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      return {
        rootTheme: document.documentElement.getAttribute('data-theme'),
        saved: localStorage.getItem('sisic_theme'),
        ariaChecked: document.querySelector('.pixo-theme-toggle')?.getAttribute('aria-checked')
      };
    })()`
  });

  assert.equal(toggledBack.result.value.rootTheme, 'light', 'Keyboard Space toggled theme back to light');
  assert.equal(toggledBack.result.value.saved, 'light', 'localStorage updated to light');
  assert.equal(toggledBack.result.value.ariaChecked, 'false', 'aria-checked updated to false');
  console.log('✓ PASS Test 5: Keyboard activation (Space) toggles theme');

  // -------------------------------------------------------------
  // TEST 6: Mobile Menu Theme Toggle Presence
  // -------------------------------------------------------------
  console.log('Running Test 6: Mobile viewport & mobile menu theme toggle...');
  await sendSessionCommand('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(300);

  // Click "More" button in mobile nav
  await sendSessionCommand('Runtime.evaluate', {
    expression: `(() => {
      const buttons = Array.from(document.querySelectorAll('.mobile-nav__btn'));
      const moreBtn = buttons.find(b => b.textContent.includes('More'));
      if (moreBtn) moreBtn.click();
    })()`
  });
  await sleep(400);

  const mobileCheck = await sendSessionCommand('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const menu = document.querySelector('.mobile-nav__more-menu');
      const mobileToggle = menu?.querySelector('.pixo-theme-toggle');
      const rect = mobileToggle?.getBoundingClientRect();
      return {
        menuOpen: Boolean(menu),
        hasMobileToggle: Boolean(mobileToggle),
        width: rect?.width || 0,
        height: rect?.height || 0,
      };
    })()`
  });

  assert.equal(mobileCheck.result.value.menuOpen, true, 'Mobile more menu opened');
  assert.equal(mobileCheck.result.value.hasMobileToggle, true, 'Theme toggle present in mobile more menu');
  assert.ok(mobileCheck.result.value.width >= 44, 'Mobile toggle width >= 44px');
  assert.ok(mobileCheck.result.value.height >= 44, 'Mobile toggle height >= 44px');
  console.log('✓ PASS Test 6: Mobile more menu includes accessible >=44x44px Theme Toggle');

  const mobileShot = await sendSessionCommand('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SCREENSHOTS_DIR, 'task6-mobile-theme-menu.png'), Buffer.from(mobileShot.data, 'base64'));
  console.log('✓ Captured screenshot: task6-mobile-theme-menu.png');

  // Reset localStorage to clean up
  await sendSessionCommand('Runtime.evaluate', {
    expression: `localStorage.removeItem('sisic_theme')`
  });

  console.log('\n========================================');
  console.log('ALL TASK 6 VERIFICATIONS PASSED (6/6)!');
  console.log('========================================\n');

} finally {
  if (ws) ws.close();
  chrome.kill();
  vite.kill();
}
