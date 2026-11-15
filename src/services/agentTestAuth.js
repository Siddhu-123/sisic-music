export const AGENT_TEST_TOKEN_PARAM = 'test-token';
export const AGENT_TEST_STORAGE_KEY = 'sisic_agent_test_token';

function safeStorageGet(storage, key) {
  try {
    return storage?.getItem(key) || '';
  } catch {
    return '';
  }
}

function safeStorageSet(storage, key, value) {
  try {
    storage?.setItem(key, value);
  } catch {
    // Ignore storage quota or privacy mode errors.
  }
}

function safeStorageRemove(storage, key) {
  try {
    storage?.removeItem(key);
  } catch {
    // Ignore storage errors.
  }
}

/**
 * Resolves whether an AI-agent testing session should bypass the login gate.
 * Requires a non-empty configured token (VITE_AGENT_TEST_TOKEN).
 */
export function resolveAgentTestSession({
  configuredToken = '',
  search = '',
  storage = null,
} = {}) {
  const expected = String(configuredToken || '').trim();
  if (!expected) {
    return { active: false, matchedFromUrl: false };
  }

  const params = new URLSearchParams(search || '');
  const urlToken = params.get(AGENT_TEST_TOKEN_PARAM);

  if (urlToken === 'clear' || urlToken === 'logout') {
    safeStorageRemove(storage, AGENT_TEST_STORAGE_KEY);
    return { active: false, matchedFromUrl: false };
  }

  if (urlToken && urlToken === expected) {
    safeStorageSet(storage, AGENT_TEST_STORAGE_KEY, expected);
    return { active: true, matchedFromUrl: true };
  }

  if (safeStorageGet(storage, AGENT_TEST_STORAGE_KEY) === expected) {
    return { active: true, matchedFromUrl: false };
  }

  return { active: false, matchedFromUrl: false };
}

/**
 * Browser helper that resolves the test session from window.location / sessionStorage
 * and strips the token query parameter from the URL bar once activated.
 */
export function isAgentTestSessionActive(configuredToken = '') {
  if (typeof window === 'undefined') return false;
  const result = resolveAgentTestSession({
    configuredToken,
    search: window.location.search,
    storage: window.sessionStorage,
  });

  if (result.matchedFromUrl && typeof window.history?.replaceState === 'function') {
    const url = new URL(window.location.href);
    url.searchParams.delete(AGENT_TEST_TOKEN_PARAM);
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(null, '', nextUrl);
  }

  return result.active;
}
