// Run against the local fixture only: node scripts/verify-reference-player.mjs [url]
// Uses the same public controls as the application, in an isolated browser session.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const url = process.argv[2] || 'http://127.0.0.1:5199/tests/browser/fixture.html';
if (!/^http:\/\/127\.0\.0\.1:\d+\/tests\/browser\/fixture\.html$/.test(url)) throw Error('Use the local fixture URL.');
const output = resolve('../screenshots');
mkdirSync(output, { recursive: true });
const session = 'sisic-reference-check';
const browser = (...args) => execFileSync('npx', ['--yes', 'agent-browser', '--session', session, ...args], {
  encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024,
});
const evaluate = source => browser('eval', source);
const snapshot = () => browser('snapshot', '-i');
const click = selector => { browser('click', selector); snapshot(); };
const key = name => { browser('press', name); snapshot(); };
const check = (name, source) => {
  evaluate(`(() => { const assert = (ok, message) => { if (!ok) throw new Error(message); }; ${source}; return 'PASS'; })()`);
  console.log(`PASS ${name}`);
};
const capture = name => browser('screenshot', resolve(output, `final-${name}.png`));
const player = '.expanded-player--reference';
const inPlayer = label => `${player} [aria-label="${label}"]`;
const geometry = `
  const box = selector => { const node = document.querySelector(selector); assert(node, selector + ' missing'); return node.getBoundingClientRect(); };
  const deck = box('.turntable'), platter = box('.turntable__platter-bed'), badge = box('.turntable__speed-badge');
  assert(platter.left >= deck.left && platter.right <= deck.right && platter.top >= deck.top && platter.bottom <= deck.bottom, 'Platter escapes deck');
  assert(platter.bottom + 4 <= badge.top, 'Platter overlaps speed badge');
  const label = box('.turntable__deck-label');
  assert(label.bottom + 2 <= platter.top, 'Deck label overlaps platter');
  const content = document.querySelector('.expanded-player__content');
  assert(content.scrollWidth <= content.clientWidth + 1, 'Horizontal content overflow');
  for (const name of ['Minimize player', 'Equalizer', 'More Like This']) {
    const r = box('.expanded-player__header [aria-label="' + name + '"]');
    assert(r.width >= 44 && r.height >= 44 && r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight, name + ' inaccessible');
  }
`;

try {
  browser('open', url);
  browser('wait', '.sidebar__nav-item');
  browser('set', 'viewport', '1660', '948');
  evaluate(`document.documentElement.dataset.theme = 'dark'; localStorage.setItem('sisic_theme', 'dark')`);
  snapshot();
  click('.sidebar__nav-item:nth-child(3)');
  click('button[aria-label="Play Amber Coast by Low Sun"]');
  click('.player-song-info__open');
  click(inPlayer('Pause'));
  check('Desktop geometry and complete crate row', `${geometry}
    assert(box('.crate-card').bottom <= innerHeight, 'Crate card below desktop viewport');
    assert(!document.querySelector('.expanded-player input[readonly]'), 'Inert search');
    assert(!/Gaurav|10 Sep 2024|Drive connected/.test(document.querySelector('.expanded-player').textContent), 'Fake account data');
  `);
  capture('desktop-player');

  for (const [label, selector] of [['Equalizer', '.equalizer-modal'], ['More Like This', '.recommendations-modal'], ['Song details', '.song-info-panel'], ['Queue', '.queue-panel']]) {
    click(inPlayer(label));
    check(`${label} opens above player`, `
      const modal = document.querySelector('${selector}'); assert(modal, 'Missing dialog');
      const rect = modal.getBoundingClientRect();
      assert(modal.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + Math.min(30, rect.height / 2))), 'Dialog hidden behind player');
      assert(modal.contains(document.activeElement), 'Dialog focus missing');
    `);
    key('Escape');
    check(`${label} dismissal retains player`, `assert(!document.querySelector('${selector}'), 'Dialog still open'); assert(document.querySelector('${player}'), 'Player unexpectedly closed');`);
  }

  browser('fill', inPlayer('Search library by song or artist'), 'Blue Hour');
  click(inPlayer('Show library search results'));
  check('Search reaches real filtered library', `
    assert(!document.querySelector('${player}'), 'Player did not close for results');
    assert(document.querySelector('.search-box input')?.value === 'Blue Hour', 'Library query not applied');
    assert(document.querySelectorAll('.song-card').length === 1 && document.querySelector('.song-card').textContent.includes('Blue Hour'), 'Incorrect results');
    assert(!document.querySelector('.sidebar').inert, 'Background still inert');
  `);
  click('.player-song-info__open');

  for (const [width, height, name] of [[1280, 800, 'laptop-player'], [768, 1024, 'tablet-player'], [390, 844, 'mobile-player'], [320, 568, 'narrow-player']]) {
    browser('set', 'viewport', String(width), String(height));
    evaluate(`document.querySelector('.expanded-player__content').scrollTop = 0`);
    snapshot();
    check(`${width}px geometry`, geometry);
    capture(name);
    evaluate(`document.querySelector('.expanded-controls').scrollIntoView({block:'center'})`);
    check(`${width}px transport reachable`, `
      const container = document.querySelector('.expanded-player__content').getBoundingClientRect();
      for (const button of document.querySelectorAll('.expanded-controls button')) {
        const r = button.getBoundingClientRect();
        assert(r.left >= 0 && r.right <= innerWidth + 1 && r.top >= container.top && r.bottom <= innerHeight, 'Transport clipped');
        assert(button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)), 'Transport covered');
      }
    `);
    if (width === 320) capture('narrow-controls');
    evaluate(`document.querySelector('.expanded-crate-section').scrollIntoView({block:'end'})`);
    check(`${width}px bottom content reachable`, `
      const r = document.querySelector('.crate-card').getBoundingClientRect();
      assert(r.top >= 0 && r.bottom <= innerHeight + 1, 'Crate cannot be scrolled into view');
    `);
  }

  click(inPlayer('Minimize player'));
  browser('set', 'viewport', '1660', '948');
  click('.sidebar__nav-item[aria-label="View personal taste profile"]');
  check('Taste profile values and export', `
    const bars = [...document.querySelectorAll('.vector-bar-column')];
    assert(bars.length === 64, 'Vector dimensionality');
    for (const column of bars) {
      const val = Number(column.title.split(':')[1]);
      const height = parseFloat(column.querySelector('.vector-bar').style.height);
      assert(Math.abs(height / 100 - val) < .001, 'Misleading chart scale');
    }
    window.__profileExport = null;
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => { if (blob.type === 'application/json') window.__profileExport = blob; return create(blob); };
  `);
  capture('desktop-taste');
  click('.taste-export-btn');
  evaluate(`(async () => { const profile = JSON.parse(await window.__profileExport.text()); if (profile.tasteVector.length !== 64 || profile.appName !== 'Sisic Music') throw Error('Invalid profile JSON'); return 'Export valid'; })()`);
  console.log('PASS JSON export contains 64 actual vector values');
  evaluate(`document.documentElement.dataset.theme = 'light'`);
  capture('light-taste');
  browser('set', 'viewport', '320', '568');
  evaluate(`document.documentElement.dataset.theme = 'dark'; document.querySelector('.taste-profile-modal').scrollTop = 0`);
  capture('narrow-taste');
  evaluate(`document.querySelector('.taste-export-btn').scrollIntoView({block:'center'})`);
  check('Narrow taste export reachable', `const button = document.querySelector('.taste-export-btn'); const r = button.getBoundingClientRect(); assert(r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, 'Export clipped');`);
  capture('narrow-taste-export');
  key('Escape');
  check('Taste Escape dismissal', `assert(!document.querySelector('.taste-profile-modal'), 'Taste dialog still open');`);
  browser('set', 'viewport', '1660', '948');
  evaluate(`document.documentElement.dataset.theme = 'light'`);
  click('.player-song-info__open');
  capture('light-player');
  const errors = browser('errors').trim();
  if (errors) throw Error(`Browser errors: ${errors}`);
  console.log('PASS no browser runtime errors');
} finally {
  browser('close');
}
