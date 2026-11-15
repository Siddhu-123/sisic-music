export const INTERACTIVE_SHORTCUT_SELECTOR = [
  'input',
  'textarea',
  'select',
  'button',
  'summary',
  'a[href]',
  'area[href]',
  'audio[controls]',
  'video[controls]',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[contenteditable="plaintext-only"]',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="dialog"]',
].join(', ');

const HARDWARE_MEDIA_KEYS = new Set([
  'MediaPlayPause',
  'MediaStop',
  'MediaTrackNext',
  'MediaTrackPrevious',
]);

/**
 * Returns true when global playback keyboard shortcuts (Space, arrows, M) must yield
 * to the focused UI control so native Space activation on disclosures (<summary>),
 * buttons, links, switches, inputs, and dialogs works as expected.
 */
export function shouldIgnoreGlobalPlaybackShortcut(event) {
  if (!event || event.defaultPrevented || event.repeat) return true;
  if (event.ctrlKey || event.metaKey || event.altKey) return true;
  if (HARDWARE_MEDIA_KEYS.has(event.key)) return false;

  const target = event.target;
  if (!target) return false;
  if (target.isContentEditable) return true;
  if (typeof target.closest === 'function' && target.closest(INTERACTIVE_SHORTCUT_SELECTOR)) {
    return true;
  }
  return false;
}
