const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const SESSION_TTL_MS = 400 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_SECONDS = 400 * 24 * 60 * 60;
export const TX_TTL_MS = 10 * 60 * 1000;
export const TX_TTL_SECONDS = 10 * 60;

function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(str) {
  const padded = String(str || '').replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(str || '').length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomTokenId(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export async function sha256Base64Url(input) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(input)));
  return toBase64Url(new Uint8Array(digest));
}

async function importAesKey(secretB64) {
  const raw = fromBase64Url(secretB64);
  if (raw.length !== 32) {
    throw new Error('AUTH_ENC_KEY must decode to exactly 32 bytes (256 bits).');
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function sealJsonAead(secretB64, payload, aadString) {
  const key = await importAesKey(secretB64);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(String(aadString || '')) },
    key,
    encoder.encode(JSON.stringify(payload)),
  );
  return {
    ciphertext: toBase64Url(new Uint8Array(cipherBuffer)),
    nonce: toBase64Url(iv),
  };
}

export async function unsealJsonAead(secretB64, { ciphertext, nonce }, aadString) {
  const key = await importAesKey(secretB64);
  const iv = fromBase64Url(nonce);
  const cipher = fromBase64Url(ciphertext);
  const plainBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(String(aadString || '')) },
    key,
    cipher,
  );
  return JSON.parse(decoder.decode(plainBuffer));
}

export function sealRefreshToken(secretB64, { sid, epoch = 1, refreshToken }) {
  return sealJsonAead(secretB64, { refreshToken: String(refreshToken) }, `${sid}:${epoch}`);
}

export async function unsealRefreshToken(secretB64, { sid, epoch = 1, encRefreshToken, nonce }) {
  const plain = await unsealJsonAead(secretB64, { ciphertext: encRefreshToken, nonce }, `${sid}:${epoch}`);
  if (!plain?.refreshToken) throw new Error('Vault entry missing refreshToken.');
  return String(plain.refreshToken);
}

export function parseCookies(cookieHeader = '') {
  const cookies = new Map();
  for (const part of String(cookieHeader || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (name) {
      try { cookies.set(name, decodeURIComponent(val)); } catch { cookies.set(name, val); }
    }
  }
  return cookies;
}

export function isSecureRequestUrl(url) {
  return new URL(String(url)).protocol === 'https:';
}

export function sessionCookieName(requestUrl) {
  return isSecureRequestUrl(requestUrl) ? '__Host-sisic_session' : 'sisic_session';
}

export function txCookieName(requestUrl) {
  return isSecureRequestUrl(requestUrl) ? '__Host-sisic_oauth_tx' : 'sisic_oauth_tx';
}

export function buildSetCookie(name, value, { maxAgeSeconds, path = '/', secure = true, sameSite = 'Lax' } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    'HttpOnly',
    `SameSite=${sameSite}`,
  ];
  if (typeof maxAgeSeconds === 'number') parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function sanitizeReturnTo(raw = '/') {
  const text = String(raw || '/').trim();
  if (!text.startsWith('/') || text.startsWith('//') || /^\/\\/.test(text)) return '/';
  return text;
}

export function constantTimeEqual(a, b) {
  const left = encoder.encode(String(a || ''));
  const right = encoder.encode(String(b || ''));
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

export function verifySameOriginPost(request, allowedOrigins = []) {
  const reqUrl = new URL(request.url);
  const fetchSite = String(request.headers.get('Sec-Fetch-Site') || '').toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return false;
  }
  const origin = request.headers.get('Origin');
  const allowed = new Set([reqUrl.origin, ...allowedOrigins.filter(Boolean)]);
  if (origin) return allowed.has(origin);
  const referer = request.headers.get('Referer');
  if (referer) {
    try {
      return allowed.has(new URL(referer).origin);
    } catch {
      return false;
    }
  }
  // Allow programmatic/SW same-origin fetch when Sec-Fetch-Site is 'same-origin' or explicit SW header is set.
  if (fetchSite === 'same-origin' || request.headers.get('X-Sisic-SW') === '1') {
    return true;
  }
  return false;
}

export function createD1SessionStore(db) {
  return {
    async get(sid) {
      if (!sid) return null;
      const row = await db.prepare(
        'SELECT sid, enc_refresh_token, nonce, scope, token_epoch, expires_at, created_at, last_used_at FROM auth_sessions WHERE sid = ?'
      ).bind(sid).first();
      return row || null;
    },
    async put(record) {
      await db.prepare(
        `INSERT INTO auth_sessions (sid, enc_refresh_token, nonce, scope, token_epoch, expires_at, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET
           enc_refresh_token = excluded.enc_refresh_token,
           nonce = excluded.nonce,
           scope = excluded.scope,
           token_epoch = excluded.token_epoch,
           expires_at = excluded.expires_at,
           last_used_at = excluded.last_used_at
         WHERE excluded.token_epoch >= auth_sessions.token_epoch`
      ).bind(
        record.sid,
        record.enc_refresh_token,
        record.nonce,
        record.scope || '',
        record.token_epoch ?? 1,
        record.expires_at,
        record.created_at,
        record.last_used_at,
      ).run();
    },
    async delete(sid) {
      if (!sid) return;
      await db.prepare('DELETE FROM auth_sessions WHERE sid = ?').bind(sid).run();
    },
    async pruneExpired(nowTs = Date.now()) {
      await db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').bind(nowTs).run();
    },
  };
}

export function createMemorySessionStore() {
  const rows = new Map();
  return {
    rows,
    async get(sid) {
      return rows.get(sid) || null;
    },
    async put(record) {
      const existing = rows.get(record.sid);
      if (existing && Number(existing.token_epoch ?? 1) > Number(record.token_epoch ?? 1)) {
        return;
      }
      rows.set(record.sid, { ...record });
    },
    async delete(sid) {
      rows.delete(sid);
    },
    async pruneExpired(nowTs = Date.now()) {
      for (const [sid, row] of rows.entries()) {
        if (Number(row.expires_at) <= nowTs) rows.delete(sid);
      }
    },
  };
}
