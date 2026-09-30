// Pure service for generating outbound listen/buy search links and recording click telemetry.

export const OUTBOUND_CLICKS_KEY = 'sisic:outbound-clicks:v1';
export const MAX_OUTBOUND_CLICKS = 500;
export const MAX_QUERY_LENGTH = 120;
export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export const AFFILIATE_DISCLOSURE =
  'Some links may earn Sisic Music a commission. It never changes what is recommended.';

export const ALLOWLISTED_HOSTS = new Set([
  'open.spotify.com',
  'music.youtube.com',
  'www.youtube.com',
  'music.apple.com',
  'bandcamp.com',
  'music.amazon.com',
]);

export const KNOWN_SERVICES = new Set([
  'spotify',
  'youtube-music',
  'youtube',
  'apple-music',
  'bandcamp',
  'amazon-music',
]);

// Vite only substitutes the literal `import.meta.env`, so it is read without optional chaining.
const defaultConfig = (() => { try { return import.meta.env || {}; } catch { return {}; } })();

export function sanitizeAffiliateToken(value) {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(token) ? token : null;
}

export function hasAffiliateLinks(links) {
  return Array.isArray(links) && links.some(link => Boolean(link?.affiliate));
}

export function isSafeOutboundUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    if (parsed.port && parsed.port !== '443') return false;
    return ALLOWLISTED_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

export function buildOutboundLinks(song, config = defaultConfig) {
  const artist = String(song?.artist ?? '').trim();
  const track = String(song?.track ?? '').trim();
  if (!artist && !track) return [];

  const raw = artist && track ? `${artist} ${track}` : (artist || track);
  const query = Array.from(raw).slice(0, MAX_QUERY_LENGTH).join('');
  const q = encodeURIComponent(query);

  const conf = config && typeof config === 'object' ? config : defaultConfig;
  const appleToken = sanitizeAffiliateToken(conf?.VITE_APPLE_AFFILIATE_TOKEN);
  const amazonTag = sanitizeAffiliateToken(conf?.VITE_AMAZON_ASSOCIATE_TAG);

  const appleUrl = appleToken
    ? `https://music.apple.com/search?term=${q}&at=${appleToken}&ct=sisic-music`
    : `https://music.apple.com/search?term=${q}`;

  const amazonUrl = amazonTag
    ? `https://music.amazon.com/search/${q}?tag=${amazonTag}`
    : `https://music.amazon.com/search/${q}`;

  return [
    {
      service: 'spotify',
      label: 'Spotify',
      url: `https://open.spotify.com/search/${q}`,
      kind: 'search',
      affiliate: false,
    },
    {
      service: 'youtube-music',
      label: 'YouTube Music',
      url: `https://music.youtube.com/search?q=${q}`,
      kind: 'search',
      affiliate: false,
    },
    {
      service: 'youtube',
      label: 'YouTube',
      url: `https://www.youtube.com/results?search_query=${q}`,
      kind: 'search',
      affiliate: false,
    },
    {
      service: 'apple-music',
      label: 'Apple Music',
      url: appleUrl,
      kind: 'search',
      affiliate: Boolean(appleToken),
    },
    {
      service: 'bandcamp',
      label: 'Bandcamp',
      url: `https://bandcamp.com/search?q=${q}&item_type=t`,
      kind: 'search',
      affiliate: false,
    },
    {
      service: 'amazon-music',
      label: 'Amazon Music',
      url: amazonUrl,
      kind: 'search',
      affiliate: Boolean(amazonTag),
    },
  ];
}

export function sanitizeOutboundClicks(value) {
  if (!Array.isArray(value)) return [];
  const valid = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const songKey = typeof item.songKey === 'string' ? item.songKey.trim() : '';
    const service = typeof item.service === 'string' ? item.service.trim() : '';
    const timestamp = item.timestamp;
    if (!songKey || !KNOWN_SERVICES.has(service)) continue;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) continue;
    valid.push({ songKey, service, timestamp });
  }
  return valid.length > MAX_OUTBOUND_CLICKS ? valid.slice(-MAX_OUTBOUND_CLICKS) : valid;
}

export function readOutboundClicks(storage) {
  try {
    const raw = storage?.getItem(OUTBOUND_CLICKS_KEY);
    return raw ? sanitizeOutboundClicks(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function recordOutboundClick(storage, target = {}, now = Date.now()) {
  try {
    if (!storage || typeof storage.setItem !== 'function') {
      return false;
    }
    const songKey = typeof target?.songKey === 'string' ? target.songKey.trim() : '';
    const service = typeof target?.service === 'string' ? target.service.trim() : '';
    const timestamp = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
    if (!songKey || !KNOWN_SERVICES.has(service) || !Number.isFinite(timestamp)) {
      return false;
    }
    const existing = readOutboundClicks(storage);
    const next = [...existing, { songKey, service, timestamp }];
    const ring = next.length > MAX_OUTBOUND_CLICKS ? next.slice(-MAX_OUTBOUND_CLICKS) : next;
    storage.setItem(OUTBOUND_CLICKS_KEY, JSON.stringify(ring));
    return true;
  } catch {
    return false;
  }
}

export function summariseOutboundClicks(clicks, now = Date.now()) {
  const result = { total: 0, byService: {}, last30Days: 0 };
  if (!Array.isArray(clicks)) return result;
  const cutoff = now - THIRTY_DAYS_MS;
  for (const click of clicks) {
    if (!click || typeof click !== 'object') continue;
    const service = click.service;
    if (typeof service !== 'string' || !service) continue;
    result.total += 1;
    result.byService[service] = (result.byService[service] || 0) + 1;
    if (typeof click.timestamp === 'number' && Number.isFinite(click.timestamp) && click.timestamp >= cutoff) {
      result.last30Days += 1;
    }
  }
  return result;
}
