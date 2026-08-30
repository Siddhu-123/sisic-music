import test from 'node:test';
import assert from 'node:assert/strict';
import { generateProceduralArtwork, hashString, getArtworkThemeColors } from './artworkService.js';

test('hashString produces stable deterministic hashes', () => {
  const hash1 = hashString('artist::track');
  const hash2 = hashString('artist::track');
  const hash3 = hashString('other::track');

  assert.strictEqual(hash1, hash2);
  assert.notStrictEqual(hash1, hash3);
  assert.ok(hash1 >= 0);
});

test('generateProceduralArtwork produces valid SVG data URI with initials and colors', () => {
  const art = generateProceduralArtwork({
    artist: 'Daft Punk',
    track: 'Get Lucky',
    songKey: 'daft punk::get lucky',
  });

  assert.ok(art.coverArtUrl.startsWith('data:image/svg+xml;utf8,'));
  assert.ok(decodeURIComponent(art.coverArtUrl).includes('DG')); // Daft Punk / Get Lucky initials
  assert.strictEqual(art.isProcedural, true);
  assert.ok(typeof art.hue === 'number');
  assert.ok(art.colors.primary.startsWith('hsl('));
});

test('generateProceduralArtwork escapes user-provided initials for SVG text', () => {
  const art = generateProceduralArtwork({ artist: '<Artist', track: '&Track' });
  const svg = decodeURIComponent(art.coverArtUrl);
  assert.ok(svg.includes('>&lt;&amp;</text>'));
});

test('getArtworkThemeColors returns valid HSL color tokens for theming', () => {
  const theme = getArtworkThemeColors({ songKey: 'queen::bohemian rhapsody' });
  assert.ok(theme.accent.startsWith('hsl('));
  assert.ok(theme.glow.startsWith('hsla('));
  assert.ok(theme.shadowSoft.startsWith('hsla('));
});
