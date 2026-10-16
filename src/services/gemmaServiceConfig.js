export const GEMMA_SERVICE_CONFIG_KEY = 'sisic.gemmaService.v1';

export function getGemmaServiceConfig() {
  try {
    const raw = window.localStorage.getItem(GEMMA_SERVICE_CONFIG_KEY);
    if (!raw) return null;
    const config = JSON.parse(raw);
    if (!config || typeof config !== 'object') return null;
    return {
      baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : '',
      token: typeof config.token === 'string' ? config.token : '',
    };
  } catch {
    return null;
  }
}

export function saveGemmaServiceConfig({ baseUrl = '', token = '' } = {}) {
  const config = { baseUrl: String(baseUrl), token: String(token) };
  try {
    window.localStorage.setItem(GEMMA_SERVICE_CONFIG_KEY, JSON.stringify(config));
    return config;
  } catch {
    return null;
  }
}

export function clearGemmaServiceToken() {
  try {
    const config = getGemmaServiceConfig();
    if (config?.baseUrl) {
      window.localStorage.setItem(GEMMA_SERVICE_CONFIG_KEY, JSON.stringify({ ...config, token: '' }));
    } else {
      window.localStorage.removeItem(GEMMA_SERVICE_CONFIG_KEY);
    }
    return true;
  } catch {
    return false;
  }
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
