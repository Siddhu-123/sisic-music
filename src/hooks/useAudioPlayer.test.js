import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { ACTIONS } from './useAudioPlayer.js';
import { PlaybackController } from '../services/PlaybackController.js';

// The hook exposes only whitelisted controller methods. A UI control calling a method that is not listed
// throws on click and nothing else notices (this hid the DJ voice toggle).
test('every player.setXxx(...) call made by a component is exposed by the hook and exists on the controller', () => {
  const dir = new URL('../components/', import.meta.url);
  const called = new Set();
  for (const file of readdirSync(dir).filter(name => /\.jsx?$/.test(name))) {
    for (const match of readFileSync(new URL(file, dir), 'utf8').matchAll(/\bplayer\.(set[A-Z]\w*)\(/g)) called.add(match[1]);
  }
  assert.ok(called.size > 3, 'the scan should find the settings controls');
  for (const name of called) {
    assert.ok(ACTIONS.includes(name), `${name} is called by a component but missing from ACTIONS`);
    assert.equal(typeof PlaybackController.prototype[name] === 'function' || name in new PlaybackController({ resolveUrl: async () => '' }), true, `${name} is not on the controller`);
  }
});
