import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const output = process.env.PLAYER_TEST_OUTPUT || '/tmp/sisic-player-checks';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const player = page.locator('.player-bar');
const playButton = player.locator('.play-btn');
const songButton = name => page.getByRole('button', { name: `Play ${name}`, exact: false }).first();
const queueState = () => page.evaluate(() => JSON.parse(localStorage.getItem('sisic:queue-state:v1')));
const audioState = () => page.evaluate(() => window.__fixtureAudio.filter(a => a.src).map(a => ({ time: a.currentTime, paused: a.paused, ready: a.readyState })));
const playing = () => page.waitForFunction(() => window.__fixtureAudio.some(a => a.src && !a.paused && a.currentTime > .1));
const pause = async () => { if (await playButton.getAttribute('aria-label') === 'Pause') await playButton.click(); };
const settings = async () => { if (!await page.locator('.playback-settings').evaluate(el => el.open)) await page.getByLabel('Playback settings', { exact: true }).click(); };
const closeSettings = async () => { if (await page.locator('.playback-settings').evaluate(el => el.open)) await page.getByLabel('Playback settings', { exact: true }).click(); };
const setRange = async (locator, value) => { await locator.focus(); await locator.press('Home'); for (let i = 0; i < value; i++) await locator.press('ArrowRight'); };
try {
  await page.goto(`${process.env.PLAYER_TEST_URL || 'http://127.0.0.1:5178'}/tests/browser/fixture.html`);
  await page.getByRole('button', { name: 'Ready', exact: true }).click();
  await songButton('Amber Coast').click(); await playing();
  await page.waitForFunction(() => window.__fixtureAudio.filter(a => a.src && a.readyState >= 3).length === 2);
  assert.equal((await audioState()).filter(a => !a.paused).length, 1);
  console.log('PASS: native playback and next-track preloading');

  await pause(); assert.ok((await audioState()).every(a => a.paused));
  await player.getByRole('button', { name: 'Mute', exact: true }).click(); assert.equal((await queueState()).muted, true);
  await player.getByRole('button', { name: 'Unmute', exact: true }).click();
  await page.evaluate(() => { for (let i = 0; i < 3; i++) document.querySelector('.player-bar [aria-label="Next"]').click(); });
  await page.waitForFunction(() => document.querySelector('.player-track')?.textContent === 'Driftwood'); await playing();
  assert.equal((await queueState()).queueIndex, 3);
  console.log('PASS: immediate pause, mute and rapid skipping');
  await page.evaluate(() => window.__mediaActions.pause());
  assert.ok((await audioState()).every(a => a.paused));
  await page.evaluate(() => window.__mediaActions.seekto({ seekTime: 5 }));
  assert.ok((await audioState()).some(a => Math.abs(a.time - 5) < .1));
  await page.evaluate(() => window.__mediaActions.play()); await playing();
  assert.equal(await page.evaluate(() => navigator.mediaSession.metadata.title), 'Driftwood');
  console.log('PASS: media-session play, pause, seek and metadata');

  await pause();
  const slider = player.getByLabel('Playback position');
  const bounds = await slider.boundingBox();
  await page.evaluate(() => { window.__seeks = 0; window.__fixtureAudio.forEach(a => a.addEventListener('seeking', () => window.__seeks++)); });
  await page.mouse.move(bounds.x + 10, bounds.y + bounds.height / 2); await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * .7, bounds.y + bounds.height / 2, { steps: 12 });
  assert.equal(await page.evaluate(() => window.__seeks), 0);
  await page.mouse.up(); await page.waitForFunction(() => window.__seeks > 0);
  assert.equal(await page.evaluate(() => window.__seeks), 1, JSON.stringify(await audioState()));
  assert.ok((await audioState()).every(a => a.paused));
  console.log('PASS: seek drag commits once and preserves paused state');

  await page.mouse.move(bounds.x + bounds.width * .3, bounds.y + bounds.height / 2); await page.mouse.down();
  await slider.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.__seeks), 1);
  await page.getByRole('button', { name: /Open player for Driftwood/ }).click();
  const expanded = page.locator('.expanded-player');
  await expanded.locator('.play-btn').click(); await playing();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const angles = await expanded.locator('.turntable__vinyl').evaluate(async el => {
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    await frame(); await frame();
    const before = getComputedStyle(el).transform;
    for (let i = 0; i < 8; i++) await frame();
    return [before, getComputedStyle(el).transform];
  });
  assert.equal(angles[0], angles[1]);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  console.log('PASS: reduced motion freezes the platter during playback');
  const arm = expanded.locator('.turntable__tonearm');
  const armBox = await arm.boundingBox();
  await page.mouse.move(armBox.x + armBox.width / 2, armBox.y + armBox.height / 2); await page.mouse.down();
  await page.mouse.move(armBox.x + armBox.width / 2 + 8, armBox.y + armBox.height / 2 + 10, { steps: 5 }); await page.mouse.up();
  assert.equal(await expanded.locator('.play-btn').getAttribute('aria-label'), 'Pause');
  await expanded.getByRole('button', { name: 'Info', exact: true }).click(); await page.keyboard.press('Escape');
  assert.equal(await expanded.count(), 1);
  await expanded.screenshot({ path: `${output}/desktop-expanded.png` });
  await page.getByRole('button', { name: 'Minimize player' }).click();
  console.log('PASS: tonearm seeking preserves playback; nested Escape keeps expanded player open');

  await songButton('Amber Coast').click(); await playing();
  await settings(); await setRange(page.getByLabel('Crossfade seconds'), 6); await closeSettings();
  await page.waitForFunction(() => window.__fixtureAudio.filter(a => a.src && a.readyState >= 3).length === 2);
  await page.evaluate(() => { const audio = window.__fixtureAudio.find(a => a.src && !a.paused); audio.currentTime = 19.2; });
  await page.waitForFunction(() => document.querySelector('.player-track')?.textContent === 'Blue Hour');
  await page.waitForFunction(() => window.__fixtureAudio.filter(a => a.src && !a.paused).length === 2);
  await pause(); assert.ok((await audioState()).every(a => a.paused));
  console.log('PASS: real native crossfade overlap and pause cancellation');

  await player.getByRole('button', { name: 'Queue', exact: true }).click();
  const queue = page.locator('.queue-panel');
  const from = await queue.getByLabel('Drag to reorder Evening Tide').boundingBox();
  const to = await queue.getByLabel('Drag to reorder Cedar Light').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 }); await page.mouse.up();
  assert.equal((await queueState()).queue[2].track, 'Evening Tide');
  await queue.getByLabel('Filter queue').fill('golden'); assert.equal(await queue.locator('[data-song-key]').count(), 1);
  await queue.getByLabel('Filter queue').fill('');
  await queue.evaluate(async el => { await Promise.all(el.getAnimations({ subtree: true }).filter(a => a.effect.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))); });
  assert.ok((await queue.locator('.queue-item__info').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().width))).every(width => width > 80));
  await queue.screenshot({ path: `${output}/desktop-queue.png` });
  await queue.getByRole('button', { name: 'Clear queue', exact: true }).click(); assert.equal((await queueState()).queue.length, 0);
  assert.ok((await audioState()).every(a => a.paused)); await queue.getByLabel('Close queue').click();
  console.log('PASS: pointer queue reorder, filtering and clear queue');

  await page.getByRole('button', { name: 'Create playlist', exact: true }).click();
  await page.getByLabel('New playlist name').fill('Night Drive'); await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('This playlist is empty', { exact: true }).waitFor();
  assert.equal(await page.evaluate(async () => (await window.__fixture.db.playlists.toArray()).filter(p => p.name === 'Night Drive').length), 1);
  await page.getByRole('button', { name: 'Ready', exact: true }).click();
  await page.getByRole('button', { name: 'More actions for Amber Coast', exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Playlist', exact: true }).click();
  await page.getByLabel('Night Drive', { exact: true }).check(); await page.getByRole('button', { name: /^Save/ }).click();
  await page.waitForFunction(async () => {
    const p = (await window.__fixture.db.playlists.toArray()).find(p => p.name === 'Night Drive');
    return (await window.__fixture.db.playlistSongs.where('playlistKey').equals(p.playlistKey).count()) === 1;
  });
  console.log('PASS: create empty playlist and add a song');

  await songButton('Amber Coast').click(); await playing();
  await settings(); await page.getByLabel('Sleep timer', { exact: true }).selectOption('track'); await closeSettings();
  await page.evaluate(() => { window.__fixtureAudio.find(a => a.src && !a.paused).currentTime = 23.85; });
  await page.waitForFunction(() => document.querySelector('.player-bar .play-btn').getAttribute('aria-label') === 'Play');
  assert.equal((await queueState()).sleepTimer, null); assert.equal((await queueState()).queueIndex, 0);
  console.log('PASS: end-of-track sleep takes precedence over crossfade');

  const databaseResult = await page.evaluate(async () => {
    const module = await import('/src/db.js'); const key = window.__fixture.songs[0].songKey;
    const before = (await module.db.songs.where('songKey').equals(key).first()).playCount;
    await Promise.all(Array.from({ length: 10 }, () => module.touchSongPlayed(key)));
    const after = (await module.db.songs.where('songKey').equals(key).first()).playCount;
    const claims = await module.db.transaction('rw', module.db.syncOutbox, async () => {
      await Promise.all(Array.from({ length: 10 }, (_, i) => module.enqueueSyncOutbox({ entityType: 'fixture', entityKey: 'concurrent', payload: { value: i } })));
      const operations = await module.db.syncOutbox.where('entityType').equals('fixture').toArray();
      const first = await module.claimSyncOutbox(operations[0].opId, 1000);
      const duplicate = await module.claimSyncOutbox(first.opId, 1001);
      const newer = await module.enqueueSyncOutbox({ entityType: 'fixture', entityKey: 'concurrent', payload: { value: 99 } });
      const blocked = await module.claimSyncOutbox(newer.opId, 1002);
      const recovered = await module.claimSyncOutbox(first.opId, 122000);
      const staleCompletion = await module.updateSyncOutbox(first.opId, { status: 'done' }, first.claimId);
      await module.updateSyncOutbox(first.opId, { status: 'done', leaseUntil: 0 }, recovered.claimId);
      const next = await module.claimSyncOutbox(newer.opId, 122001);
      await module.db.syncOutbox.where('entityType').equals('fixture').delete();
      return { count: operations.length, exclusive: duplicate === null && blocked === null, staleIgnored: staleCompletion === null, latest: next.payload.value };
    });
    return { increment: after - before, ...claims };
  });
  assert.deepEqual(databaseResult, { increment: 10, count: 1, exclusive: true, staleIgnored: true, latest: 99 });
  console.log('PASS: atomic play counts, outbox claims, crash recovery and stale completion protection');

  await page.waitForFunction(() => !document.querySelector('.toast'));
  for (const [name, width, height] of [['desktop', 1440, 1000], ['tablet', 834, 1112], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await settings(); await page.screenshot({ path: `${output}/${name}-settings.png` }); await closeSettings();
    const buttonBoxes = await player.locator('.play-btn, .playback-settings summary').evaluateAll(elements => elements.map(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; }));
    assert.ok(buttonBoxes.every(r => r.x >= 0 && r.right <= width && r.y >= 0 && r.bottom <= height), `${name} player controls in viewport`);
    await page.getByRole('button', { name: /Open player for Amber Coast/ }).click();
    const geometry = await page.evaluate(() => {
      const art = document.querySelector('.expanded-player__art-container').getBoundingClientRect();
      const details = document.querySelector('.expanded-player__details-column').getBoundingClientRect();
      return { separated: details.top >= art.bottom || details.left >= art.right };
    });
    assert.ok(geometry.separated, `${name} platter and track details do not overlap`);
    await page.screenshot({ path: `${output}/${name}-expanded.png` });
    await page.getByRole('button', { name: 'Minimize player' }).click();
  }
  await page.getByRole('button', { name: 'More navigation options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Create playlist', exact: true }).click();
  await page.getByLabel('New playlist name').fill('Mobile Mix');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('This playlist is empty', { exact: true }).waitFor();
  await page.evaluate(async () => { await window.__fixture.db.playlistSongs.clear(); await window.__fixture.db.playlists.clear(); });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Create playlist', exact: true }).click();
  await page.getByLabel('New playlist name').fill('First Playlist');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('This playlist is empty', { exact: true }).waitFor();
  console.log('PASS: playlist creation on mobile and with no existing playlists');
  assert.deepEqual(errors, []);
  console.log(`PASS: desktop, tablet, mobile layouts; no browser console errors. Screenshots: ${output}`);
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` });
  console.error('BROWSER ERRORS', errors);
  throw error;
} finally { await browser.close(); }
