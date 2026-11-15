import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INTERACTIVE_SHORTCUT_SELECTOR, shouldIgnoreGlobalPlaybackShortcut } from './playbackShortcuts.js';

const mockTarget = ({ matchedSelector = null, isContentEditable = false } = {}) => ({
  isContentEditable,
  closest(selector) {
    if (!matchedSelector) return null;
    const parts = selector.split(',').map(s => s.trim());
    return parts.includes(matchedSelector) ? { tagName: matchedSelector.toUpperCase() } : null;
  },
});

describe('playbackShortcuts', () => {
  it('ignores Space and playback keys when a summary disclosure, button, switch, or link is focused', () => {
    for (const tag of ['summary', 'button', 'input', 'select', '[role="button"]', '[role="switch"]', '[role="dialog"]']) {
      assert.equal(
        shouldIgnoreGlobalPlaybackShortcut({
          key: ' ',
          code: 'Space',
          target: mockTarget({ matchedSelector: tag }),
        }),
        true,
        `Expected ${tag} to yield global Space shortcut (${INTERACTIVE_SHORTCUT_SELECTOR})`,
      );
    }
  });

  it('allows Space and playback keys on neutral workspace regions and hardware media keys', () => {
    assert.equal(
      shouldIgnoreGlobalPlaybackShortcut({ key: ' ', code: 'Space', target: mockTarget() }),
      false,
    );
    assert.equal(
      shouldIgnoreGlobalPlaybackShortcut({
        key: 'MediaPlayPause',
        target: mockTarget({ matchedSelector: 'summary' }),
      }),
      false,
    );
    assert.equal(
      shouldIgnoreGlobalPlaybackShortcut({ key: ' ', ctrlKey: true, target: mockTarget() }),
      true,
    );
  });
});
