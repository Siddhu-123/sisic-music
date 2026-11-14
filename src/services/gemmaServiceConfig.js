export const GEMMA_SERVICE_CONFIG_KEY = 'sisic.gemmaService.v1';
export const DEFAULT_GEMMA_TOKEN_TTL_MS = 60 * 60 * 1000;

const volatileTokenStore = new WeakMap();
let fallbackVolatileToken = { token: '', expiresAt: 0 };

function getVolatileEntry(storage, now = Date.now()) {
  const entry = storage && typeof storage === 'object'
    ? volatileTokenStore.get(storage)
    : fallbackVolatileToken;
  if (!entry || !entry.token) return '';
  if (entry.expiresAt && now >= entry.expiresAt) {
    if (storage && typeof storage === 'object') volatileTokenStore.delete(storage);
    else fallbackVolatileToken = { token: '', expiresAt: 0 };
    return '';
  }
  return entry.token;
}

function setVolatileEntry(storage, token, ttlMs = DEFAULT_GEMMA_TOKEN_TTL_MS, now = Date.now()) {
  const normalized = String(token || '');
  const duration = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0
    ? Number(ttlMs)
    : DEFAULT_GEMMA_TOKEN_TTL_MS;
  const entry = normalized
    ? { token: normalized, expiresAt: now + duration }
    : { token: '', expiresAt: 0 };
  if (storage && typeof storage === 'object') {
    if (normalized) volatileTokenStore.set(storage, entry);
    else volatileTokenStore.delete(storage);
  } else {
    fallbackVolatileToken = entry;
  }
}

export function getGemmaServiceConfig({ now = Date.now() } = {}) {
  try {
    const storage = window.localStorage;
    const raw = storage.getItem(GEMMA_SERVICE_CONFIG_KEY);
    if (!raw) return null;
    const config = JSON.parse(raw);
    if (!config || typeof config !== 'object') return null;
    const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl : '';
    let token = getVolatileEntry(storage, now);
    if (typeof config.token === 'string' && config.token) {
      if (!token) {
        setVolatileEntry(storage, config.token, DEFAULT_GEMMA_TOKEN_TTL_MS, now);
        token = config.token;
      }
      // Scrub any legacy persistent token from localStorage so only baseUrl persists.
      storage.setItem(GEMMA_SERVICE_CONFIG_KEY, JSON.stringify({ baseUrl }));
    }
    return { baseUrl, token };
  } catch {
    return null;
  }
}

export function saveGemmaServiceConfig({ baseUrl = '', token = '', ttlMs = DEFAULT_GEMMA_TOKEN_TTL_MS, now = Date.now() } = {}) {
  const normalizedBaseUrl = String(baseUrl);
  const normalizedToken = String(token);
  try {
    const storage = window.localStorage;
    // Persist only the non-secret baseUrl in localStorage; keep the bearer token in volatile session memory.
    storage.setItem(GEMMA_SERVICE_CONFIG_KEY, JSON.stringify({ baseUrl: normalizedBaseUrl }));
    setVolatileEntry(storage, normalizedToken, ttlMs, now);
    return { baseUrl: normalizedBaseUrl, token: normalizedToken };
  } catch {
    return null;
  }
}

export function clearGemmaServiceToken() {
  try {
    const storage = window.localStorage;
    const config = getGemmaServiceConfig();
    setVolatileEntry(storage, '');
    if (config?.baseUrl) {
      storage.setItem(GEMMA_SERVICE_CONFIG_KEY, JSON.stringify({ baseUrl: config.baseUrl }));
    } else {
      storage.removeItem(GEMMA_SERVICE_CONFIG_KEY);
    }
    return true;
  } catch {
    return false;
  }
}

export function rotateGemmaServiceToken(nextToken, { ttlMs = DEFAULT_GEMMA_TOKEN_TTL_MS, now = Date.now() } = {}) {
  const current = getGemmaServiceConfig({ now });
  if (!current) return null;
  return saveGemmaServiceConfig({ baseUrl: current.baseUrl, token: nextToken, ttlMs, now });
}

export const emptyGemmaServiceStatus = { lastSync: null, imported: null, unmatched: null, skipped: null, error: '' };

export function gemmaServiceStatusText(status) {
  if (!status?.lastSync && !status?.error) return 'Not synced yet.';
  const parts = [];
  if (status.lastSync) parts.push(`Last sync: ${new Date(status.lastSync).toLocaleString()}`);
  if (status.imported != null) parts.push(`${status.imported} imported · ${status.unmatched} unmatched · ${status.skipped} skipped`);
  if (status.error) parts.push(`Error: ${status.error}`);
  return parts.join(' · ');
}

export async function runSavedGemmaServiceSync({ librarySongs = [], onSynced, sync } = {}) {
  if (typeof sync !== 'function') throw new Error('A sync function is required.');
  const saved = getGemmaServiceConfig();
  if (!saved?.baseUrl || !saved?.token) throw new Error('Save a service URL and token first.');
  const result = await sync({ ...saved, librarySongs });
  await onSynced?.();
  return { ...result, lastSync: new Date().toISOString(), error: '' };
}
