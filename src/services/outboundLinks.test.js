import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AFFILIATE_DISCLOSURE,
  ALLOWLISTED_HOSTS,
  KNOWN_SERVICES,
  MAX_OUTBOUND_CLICKS,
  MAX_QUERY_LENGTH,
  OUTBOUND_CLICKS_KEY,
  THIRTY_DAYS_MS,
  buildOutboundLinks,
  hasAffiliateLinks,
  isSafeOutboundUrl,
  readOutboundClicks,
  recordOutboundClick,
  summariseOutboundClicks,
} from './outboundLinks.js';

const memoryStorage = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    data,
  };
};

test('query handles encoding of &, #, quotes, unicode, and caps at 120 chars', () => {
  // Ampersand
  const ampLinks = buildOutboundLinks({ artist: 'Fish & Chips', track: 'Rock & Roll' });
  assert.equal(ampLinks.length, 6);
  assert.ok(ampLinks.every(l => l.url.includes('Fish%20%26%20Chips%20Rock%20%26%20Roll')));

  // Hash
  const hashLinks = buildOutboundLinks({ artist: 'Blink', track: 'Song #2' });
  assert.ok(hashLinks.every(l => l.url.includes('Blink%20Song%20%232')));

  // Quotes
  const quoteLinks = buildOutboundLinks({ artist: 'The Who', track: '"Heroes"' });
  assert.ok(quoteLinks.every(l => l.url.includes('The%20Who%20%22Heroes%22')));

  // Unicode
  const unicodeLinks = buildOutboundLinks({ artist: 'Björk', track: 'Jóga (初音ミク)' });
  assert.ok(unicodeLinks.every(l => l.url.includes('Bj%C3%B6rk%20J%C3%B3ga%20(%E5%88%9D%E9%9F%B3%E3%83%9F%E3%82%AF)')));

  // 500-character title capped at 120 characters
  const longTitle = 'A'.repeat(500);
  const cappedLinks = buildOutboundLinks({ artist: '', track: longTitle });
  assert.equal(cappedLinks.length, 6);
  for (const link of cappedLinks) {
    const rawMatch = link.url.match(/A+/);
    assert.ok(rawMatch);
    assert.equal(rawMatch[0].length, MAX_QUERY_LENGTH);
  }

  // Combined artist and 500-char track capped at 120 characters
  const comboLinks = buildOutboundLinks({ artist: 'Artist', track: 'B'.repeat(500) });
  for (const link of comboLinks) {
    const bMatch = link.url.match(/B+/);
    assert.ok(bMatch);
    assert.equal(bMatch[0].length, MAX_QUERY_LENGTH - 'Artist '.length);
  }
});

test('empty artist, empty track, and invalid inputs return []', () => {
  assert.deepEqual(buildOutboundLinks({ artist: '', track: '' }), []);
  assert.deepEqual(buildOutboundLinks({ artist: '   ', track: '   ' }), []);
  assert.deepEqual(buildOutboundLinks({}), []);
  assert.deepEqual(buildOutboundLinks(null), []);
  assert.deepEqual(buildOutboundLinks(undefined), []);

  // One empty, one present
  const artistOnly = buildOutboundLinks({ artist: 'Radiohead', track: '' });
  assert.equal(artistOnly.length, 6);
  assert.ok(artistOnly[0].url.endsWith('/search/Radiohead'));

  const trackOnly = buildOutboundLinks({ artist: '', track: 'Creep' });
  assert.equal(trackOnly.length, 6);
  assert.ok(trackOnly[0].url.endsWith('/search/Creep'));
});

test('generated search links match expected templates and services', () => {
  const links = buildOutboundLinks({ artist: 'Miles Davis', track: 'So What' }, {});
  assert.equal(links.length, 6);

  const expectedServices = [
    { service: 'spotify', label: 'Spotify', url: 'https://open.spotify.com/search/Miles%20Davis%20So%20What' },
    { service: 'youtube-music', label: 'YouTube Music', url: 'https://music.youtube.com/search?q=Miles%20Davis%20So%20What' },
    { service: 'youtube', label: 'YouTube', url: 'https://www.youtube.com/results?search_query=Miles%20Davis%20So%20What' },
    { service: 'apple-music', label: 'Apple Music', url: 'https://music.apple.com/search?term=Miles%20Davis%20So%20What' },
    { service: 'bandcamp', label: 'Bandcamp', url: 'https://bandcamp.com/search?q=Miles%20Davis%20So%20What&item_type=t' },
    { service: 'amazon-music', label: 'Amazon Music', url: 'https://music.amazon.com/search/Miles%20Davis%20So%20What' },
  ];

  for (let i = 0; i < expectedServices.length; i++) {
    assert.equal(links[i].service, expectedServices[i].service);
    assert.equal(links[i].label, expectedServices[i].label);
    assert.equal(links[i].url, expectedServices[i].url);
    assert.equal(links[i].kind, 'search');
    assert.equal(links[i].affiliate, false);
  }
});

test('affiliate parameters are only attached when config is valid', () => {
  // Empty config
  const noAffiliate = buildOutboundLinks({ artist: 'Artist', track: 'Song' }, {});
  assert.equal(hasAffiliateLinks(noAffiliate), false);
  assert.ok(!noAffiliate.some(l => l.affiliate));
  assert.ok(!noAffiliate.some(l => l.url.includes('at=') || l.url.includes('tag=')));

  // Invalid config values: bad tokens, long strings, non-strings
  const invalidConfig = {
    VITE_APPLE_AFFILIATE_TOKEN: 'bad token!',
    VITE_AMAZON_ASSOCIATE_TAG: 'x'.repeat(100),
  };
  const invalidLinks = buildOutboundLinks({ artist: 'Artist', track: 'Song' }, invalidConfig);
  assert.equal(hasAffiliateLinks(invalidLinks), false);
  assert.ok(!invalidLinks.some(l => l.affiliate));
  assert.ok(!invalidLinks.some(l => l.url.includes('at=') || l.url.includes('tag=')));

  const nonStringConfig = {
    VITE_APPLE_AFFILIATE_TOKEN: 12345,
    VITE_AMAZON_ASSOCIATE_TAG: { tag: 'invalid' },
  };
  const nonStringLinks = buildOutboundLinks({ artist: 'Artist', track: 'Song' }, nonStringConfig);
  assert.equal(hasAffiliateLinks(nonStringLinks), false);

  // Valid affiliate tokens
  const validConfig = {
    VITE_APPLE_AFFILIATE_TOKEN: 'apple-token_99',
    VITE_AMAZON_ASSOCIATE_TAG: 'amazon_tag-20',
  };
  const validLinks = buildOutboundLinks({ artist: 'Artist', track: 'Song' }, validConfig);
  assert.equal(hasAffiliateLinks(validLinks), true);

  const appleLink = validLinks.find(l => l.service === 'apple-music');
  assert.equal(appleLink.affiliate, true);
  assert.equal(
    appleLink.url,
    'https://music.apple.com/search?term=Artist%20Song&at=apple-token_99&ct=sisic-music'
  );

  const amazonLink = validLinks.find(l => l.service === 'amazon-music');
  assert.equal(amazonLink.affiliate, true);
  assert.equal(amazonLink.url, 'https://music.amazon.com/search/Artist%20Song?tag=amazon_tag-20');

  // Other services must still have affiliate: false
  const otherLinks = validLinks.filter(l => l.service !== 'apple-music' && l.service !== 'amazon-music');
  assert.ok(otherLinks.every(l => l.affiliate === false));

  // Affiliate disclosure text
  assert.equal(
    AFFILIATE_DISCLOSURE,
    'Some links may earn Sisic Music a commission. It never changes what is recommended.'
  );
  assert.equal(hasAffiliateLinks([]), false);
  assert.equal(hasAffiliateLinks(null), false);
});

test('isSafeOutboundUrl verifies all generated URLs and rejects dangerous URLs', () => {
  const validConfig = {
    VITE_APPLE_AFFILIATE_TOKEN: 'valid_apple_token',
    VITE_AMAZON_ASSOCIATE_TAG: 'valid_amazon_tag',
  };
  const generated = buildOutboundLinks({ artist: 'Daft Punk', track: 'One More Time' }, validConfig);
  assert.equal(generated.length, 6);
  for (const item of generated) {
    assert.equal(isSafeOutboundUrl(item.url), true, `URL should be safe: ${item.url}`);
  }

  // Allowlisted hosts
  for (const host of ALLOWLISTED_HOSTS) {
    assert.equal(isSafeOutboundUrl(`https://${host}/test`), true);
  }

  // Rejection cases
  assert.equal(isSafeOutboundUrl('javascript:alert(1)'), false);
  assert.equal(isSafeOutboundUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(isSafeOutboundUrl('http://open.spotify.com/search/test'), false, 'reject http');
  assert.equal(isSafeOutboundUrl('https://open.spotify.com.evil.com/search'), false, 'reject lookalike');
  assert.equal(isSafeOutboundUrl('https://evil.open.spotify.com/search'), false, 'reject subdomain attack');
  assert.equal(isSafeOutboundUrl('https://open.spotify.com@evil.com'), false, 'reject userinfo host spoofing');
  assert.equal(isSafeOutboundUrl('https://user:pass@open.spotify.com/search'), false, 'reject credentials');
  assert.equal(isSafeOutboundUrl('https://open.spotify.com:8443/search'), false, 'reject non-standard port');
  assert.equal(isSafeOutboundUrl('https://google.com/search'), false, 'reject unknown host');
  assert.equal(isSafeOutboundUrl('not a url'), false);
  assert.equal(isSafeOutboundUrl(''), false);
  assert.equal(isSafeOutboundUrl(null), false);
  assert.equal(isSafeOutboundUrl(undefined), false);
  assert.equal(isSafeOutboundUrl(12345), false);
});

test('click log ring-buffer caps at 500 newest entries', () => {
  const storage = memoryStorage();
  for (let i = 1; i <= 505; i++) {
    const success = recordOutboundClick(
      storage,
      { songKey: `song-${i}`, service: 'spotify' },
      1000000 + i
    );
    assert.equal(success, true);
  }

  const clicks = readOutboundClicks(storage);
  assert.equal(clicks.length, MAX_OUTBOUND_CLICKS);
  // Oldest 5 (song-1 through song-5) must have been dropped
  assert.equal(clicks[0].songKey, 'song-6');
  assert.equal(clicks[clicks.length - 1].songKey, 'song-505');
});

test('click log validates entries on read and filters malformed ones', () => {
  const malformedData = [
    { songKey: 'good-1', service: 'spotify', timestamp: 1000 },
    null,
    'a string',
    { songKey: '', service: 'spotify', timestamp: 1001 },
    { songKey: 'bad-service', service: 'unknown_streaming_svc', timestamp: 1002 },
    { songKey: 'nan-time', service: 'spotify', timestamp: NaN },
    { songKey: 'inf-time', service: 'spotify', timestamp: Infinity },
    { songKey: 'string-time', service: 'spotify', timestamp: '1000' },
    { songKey: 'good-2', service: 'bandcamp', timestamp: 2000, extraProperty: 'ignore' },
  ];

  const storage = memoryStorage({
    [OUTBOUND_CLICKS_KEY]: JSON.stringify(malformedData),
  });

  const valid = readOutboundClicks(storage);
  assert.equal(valid.length, 2);
  assert.deepEqual(valid, [
    { songKey: 'good-1', service: 'spotify', timestamp: 1000 },
    { songKey: 'good-2', service: 'bandcamp', timestamp: 2000 },
  ]);
});

test('click log never throws on throwing storage or undefined storage', () => {
  const throwingStorage = {
    getItem() {
      throw new Error('read failure');
    },
    setItem() {
      throw new Error('quota exceeded');
    },
  };

  assert.doesNotThrow(() => {
    assert.deepEqual(readOutboundClicks(throwingStorage), []);
  });

  assert.doesNotThrow(() => {
    const recorded = recordOutboundClick(throwingStorage, { songKey: 'song-1', service: 'spotify' });
    assert.equal(recorded, false);
  });

  // undefined storage
  assert.doesNotThrow(() => {
    assert.deepEqual(readOutboundClicks(undefined), []);
  });

  assert.doesNotThrow(() => {
    const recorded = recordOutboundClick(undefined, { songKey: 'song-1', service: 'spotify' });
    assert.equal(recorded, false);
  });
});

test('privacy: no song title or extra metadata ever appears in stored JSON', () => {
  const storage = memoryStorage();
  const title = 'CONFIDENTIAL_SONG_TITLE_NEVER_LEAK';
  const track = 'CONFIDENTIAL_TRACK_NAME';
  const album = 'CONFIDENTIAL_ALBUM_NAME';

  recordOutboundClick(
    storage,
    {
      songKey: 'safe-key-1',
      service: 'spotify',
      title,
      track,
      album,
      extra: 'leak-test',
    },
    1700000000000
  );

  const rawJson = storage.getItem(OUTBOUND_CLICKS_KEY);
  assert.ok(rawJson);
  assert.equal(rawJson.includes(title), false, 'title must never appear in stored JSON');
  assert.equal(rawJson.includes(track), false, 'track must never appear in stored JSON');
  assert.equal(rawJson.includes(album), false, 'album must never appear in stored JSON');
  assert.equal(rawJson.includes('leak-test'), false, 'extra properties must not leak');

  const parsed = JSON.parse(rawJson);
  assert.deepEqual(parsed, [
    { songKey: 'safe-key-1', service: 'spotify', timestamp: 1700000000000 },
  ]);
});

test('summariseOutboundClicks aggregates totals, byService counts, and last 30 days', () => {
  const now = 1700000000000;
  const clicks = [
    { songKey: 'k1', service: 'spotify', timestamp: now - 5 * 86400000 },
    { songKey: 'k2', service: 'spotify', timestamp: now - 25 * 86400000 },
    { songKey: 'k3', service: 'youtube-music', timestamp: now - 10 * 86400000 },
    { songKey: 'k4', service: 'apple-music', timestamp: now - 35 * 86400000 }, // outside 30 days
    { songKey: 'k5', service: 'bandcamp', timestamp: now - THIRTY_DAYS_MS }, // boundary, inside 30 days
  ];

  const summary = summariseOutboundClicks(clicks, now);
  assert.equal(summary.total, 5);
  assert.equal(summary.last30Days, 4);
  assert.deepEqual(summary.byService, {
    spotify: 2,
    'youtube-music': 1,
    'apple-music': 1,
    bandcamp: 1,
  });

  // Empty / invalid cases
  assert.deepEqual(summariseOutboundClicks([]), { total: 0, byService: {}, last30Days: 0 });
  assert.deepEqual(summariseOutboundClicks(null), { total: 0, byService: {}, last30Days: 0 });
  assert.deepEqual(summariseOutboundClicks(undefined), { total: 0, byService: {}, last30Days: 0 });
});

test('all known services are recognized', () => {
  assert.equal(KNOWN_SERVICES.size, 6);
  assert.ok(KNOWN_SERVICES.has('spotify'));
  assert.ok(KNOWN_SERVICES.has('youtube-music'));
  assert.ok(KNOWN_SERVICES.has('youtube'));
  assert.ok(KNOWN_SERVICES.has('apple-music'));
  assert.ok(KNOWN_SERVICES.has('bandcamp'));
  assert.ok(KNOWN_SERVICES.has('amazon-music'));
});
