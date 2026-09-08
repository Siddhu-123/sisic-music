import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ['--autoplay-policy=no-user-gesture-required'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${process.env.PLAYER_TEST_URL || 'http://127.0.0.1:5178'}/tests/browser/fixture.html`);
  await page.waitForFunction(() => window.__fixture?.db);
  await page.evaluate(async () => {
    const { db, songs } = window.__fixture;
    const { upsertSongToDb } = await import('/src/db.js');
    await upsertSongToDb({ ...songs[0], bpm: 120, musicalKey: 'C major', djAnalysisStatus: 'ready', djMetadataVersion: 1, djMetadataUpdatedAt: '2026-09-08T00:00:00Z' });
    await upsertSongToDb({ ...songs[0], bpm: null, musicalKey: '', djAnalysisStatus: 'ready', djMetadataVersion: 1, djMetadataUpdatedAt: '2026-09-09T00:00:00Z' });
    await upsertSongToDb({ ...songs[0], bpm: 120, musicalKey: 'C major', djAnalysisStatus: 'ready', djMetadataVersion: 1, djMetadataUpdatedAt: '2026-09-08T00:00:00Z' });
    const analyzed = await db.songs.where('songKey').equals(songs[0].songKey).first();
    if (analyzed.bpm !== null || analyzed.musicalKey !== '') throw new Error('New unknown metadata was overwritten by stale analysis');
    await db.playbackEvents.clear();
    const events = [];
    for (let i = 0; i < 12; i++) {
      for (const [j, eventType, positionSeconds] of [[0, 'playback-start', 0], [1, 'user-skip', 19]]) {
        const id = `dj-history-${i}-${j}`;
        events.push({ id, eventId: id, eventType, positionSeconds, songKey: songs[0].songKey, artist: songs[0].artist,
          durationSeconds: 24, sessionId: `dj-session-${i}`, createdAt: new Date(Date.now() - 3600000 + i * 30000 + j * 20000).toISOString(),
          context: { hour: new Date().getHours(), deviceType: 'desktop', timeBucket: 'night' } });
      }
    }
    await db.playbackEvents.bulkPut(events);
    for (const song of songs) await db.songs.where('songKey').equals(song.songKey).modify({ bpm: 120, musicalKey: 'C major', keyConfidence: .8, djMetadataVersion: 1 });
  });
  await page.getByRole('button', { name: 'Ready', exact: true }).click();
  await page.getByRole('button', { name: 'Play Amber Coast by Low Sun', exact: true }).first().click();
  await page.waitForFunction(() => window.__fixtureAudio.some(audio => !audio.paused && audio.currentTime > .1));
  await page.getByLabel('Playback settings', { exact: true }).click();
  await page.getByLabel('Adaptive DJ mode', { exact: true }).check();
  await page.waitForFunction(() => document.querySelector('.playback-settings__panel')?.textContent.includes('Up next:'), null, { timeout: 22000 });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('sisic:queue-state:v1'))?.djHistory?.candidateKeys?.length > 0, null, { timeout: 15000 });
  await page.waitForFunction(async () => (await window.__fixture.db.playbackEvents.where('eventType').equals('dj-transition').count()) > 0, null, { timeout: 5000 });
  const result = await page.evaluate(async () => ({
    transitions: await window.__fixture.db.playbackEvents.where('eventType').equals('dj-transition').toArray(),
    completes: await window.__fixture.db.playbackEvents.where('eventType').equals('playback-complete').count(),
    cache: await window.__fixture.db.djTransitionScores.count(),
    state: JSON.parse(localStorage.getItem('sisic:queue-state:v1')),
  }));
  assert.ok(result.transitions[0]?.positionSeconds < 19, `transition begins before historical skip point: ${JSON.stringify(result)}`);
  assert.equal(result.completes, 0, 'DJ transition is not a full-completion label');
  assert.ok(result.cache > 0);
  assert.equal(result.state.djHistory.candidateKeys.length, 1);
  assert.notEqual(result.state.queue[result.state.queueIndex].songKey, 'fixture-0');
  await page.getByLabel('Adaptive DJ mode', { exact: true }).uncheck();
  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `/private/tmp/sisic-dj-${name}.png` });
    const box = await page.locator('.playback-settings__panel').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= height);
  }
  assert.deepEqual(errors, []);
  console.log('PASS: browser skip signal, DJ ranking, preload/crossfade, transition cache, clean telemetry, persistence, toggle, desktop/mobile settings');
} finally { await browser.close(); }
