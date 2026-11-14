/**
 * Sisic Music — Cloudflare Auth Worker Client Service
 * 
 * Communicates with the Cloudflare Worker auth backend to perform
 * authorization code exchange and silent token renewal using stored refresh tokens.
 */

export const REFRESH_TOKEN_STORAGE_KEY = 'sisic_refresh_token';

let volatileRefreshToken = null;

function clearPersistentRefreshToken() {
  try {
    if (typeof localStorage !== 'undefined' && typeof localStorage?.removeItem === 'function') {
      localStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignore inaccessible storage errors
  }
}

export function getAuthWorkerUrl() {
  const url = import.meta.env?.VITE_AUTH_WORKER_URL?.trim()
    || globalThis.process?.env?.VITE_AUTH_WORKER_URL?.trim()
    || '';
  return url.replace(/\/$/, '');
}

export function isSameOriginAuthAvailable() {
  const disabled = (import.meta.env?.VITE_DISABLE_SAME_ORIGIN_AUTH || globalThis.process?.env?.VITE_DISABLE_SAME_ORIGIN_AUTH || '') === '1';
  if (disabled) return false;
  if (getAuthWorkerUrl()) return false;
  if (typeof window === 'undefined' || !window.location?.protocol) return false;
  return window.location.protocol === 'http:' || window.location.protocol === 'https:';
}

export function isAuthWorkerConfigured() {
  return Boolean(getAuthWorkerUrl());
}

export function isAuthBackendAvailable() {
  return isAuthWorkerConfigured() || isSameOriginAuthAvailable();
}

export function getAuthApiBaseUrl() {
  const workerUrl = getAuthWorkerUrl();
  if (workerUrl) return `${workerUrl}/auth`;
  if (isSameOriginAuthAvailable()) return '/api/auth';
  return '';
}

export function buildTopLevelLoginUrl({ prompt = 'select_account', returnTo = '/' } = {}) {
  const baseUrl = getAuthApiBaseUrl();
  if (!baseUrl) return '';
  const safeReturnTo = String(returnTo || '/').startsWith('/') && !String(returnTo || '/').startsWith('//') ? returnTo : '/';
  const params = new URLSearchParams({ prompt: prompt === 'consent' ? 'consent' : 'select_account', returnTo: safeReturnTo });
  return `${baseUrl}/login?${params.toString()}`;
}

export function startTopLevelLogin(options = {}) {
  const target = buildTopLevelLoginUrl(options);
  if (!target || typeof window === 'undefined') return false;
  window.location.assign(target);
  return true;
}

export async function checkServerSession({ fetchImpl = fetch } = {}) {
  const baseUrl = getAuthApiBaseUrl();
  if (!baseUrl || typeof fetchImpl !== 'function') return { authenticatedSession: false };
  try {
    const res = await fetchImpl(`${baseUrl}/session`, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Cache-Control': 'no-store' },
    });
    if (!res?.ok) return { authenticatedSession: false };
    return await res.json().catch(() => ({ authenticatedSession: false }));
  } catch {
    return { authenticatedSession: false };
  }
}

export function getStoredRefreshToken() {
  if (volatileRefreshToken) return volatileRefreshToken;
  try {
    if (typeof sessionStorage !== 'undefined' && typeof sessionStorage?.getItem === 'function') {
      clearPersistentRefreshToken();
      return sessionStorage.getItem(REFRESH_TOKEN_STORAGE_KEY);
    }
    return typeof localStorage !== 'undefined' ? localStorage.getItem(REFRESH_TOKEN_STORAGE_KEY) : null;
  } catch {
    return null;
  }
}

export function setStoredRefreshToken(token) {
  volatileRefreshToken = token ? String(token) : null;
  try {
    if (typeof sessionStorage !== 'undefined' && typeof sessionStorage?.setItem === 'function') {
      clearPersistentRefreshToken();
      if (token) {
        sessionStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, String(token));
      } else {
        sessionStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
      }
      return;
    }
    if (typeof localStorage !== 'undefined') {
      if (token) {
        localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, token);
      } else {
        localStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
      }
    }
  } catch (err) {
    console.warn('Failed to persist refresh token in storage:', err);
  }
}

export function clearStoredRefreshToken() {
  volatileRefreshToken = null;
  try {
    if (typeof sessionStorage !== 'undefined' && typeof sessionStorage?.removeItem === 'function') {
      sessionStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignore inaccessible sessionStorage
  }
  clearPersistentRefreshToken();
}

/**
 * Exchange an OAuth authorization code with the Cloudflare Worker.
 * Keeps any returned refresh token only in volatile memory (never in localStorage).
 */
export async function exchangeCodeWithWorker(code, redirectUri = 'postmessage') {
  const baseUrl = getAuthApiBaseUrl();
  if (!baseUrl) throw new Error('Cloudflare Auth Worker URL is not configured.');

  const res = await fetch(`${baseUrl}/exchange`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify({ code, redirect_uri: redirectUri }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errorMsg = data.message || data.error || `Code exchange failed with status ${res.status}`;
    throw new Error(errorMsg);
  }

  clearPersistentRefreshToken();
  if (data.refresh_token) {
    volatileRefreshToken = String(data.refresh_token);
  }

  return data;
}

/**
 * Silently refresh the access token using the same-origin HttpOnly session cookie (Option H)
 * or legacy volatile refresh token when pointing at a standalone auth worker.
 */
export async function refreshAccessTokenWithWorker(refreshToken = getStoredRefreshToken(), { fetchImpl = fetch } = {}) {
  const baseUrl = getAuthApiBaseUrl();
  if (!baseUrl) throw new Error('Cloudflare Auth Worker URL is not configured.');
  const sameOrigin = isSameOriginAuthAvailable();
  if (!refreshToken && !sameOrigin) throw new Error('No refresh token available.');

  const res = await fetchImpl(`${baseUrl}/refresh`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(refreshToken ? { refresh_token: refreshToken } : {}),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 || data.error === 'invalid_grant' || data.error === 'session_missing' || data.error === 'session_expired') {
      clearStoredRefreshToken();
    }
    const errorMsg = data.message || data.error || `Token refresh failed with status ${res.status}`;
    const err = new Error(errorMsg);
    err.status = res.status;
    err.code = data.error || '';
    throw err;
  }

  clearPersistentRefreshToken();
  if (data.refresh_token) {
    volatileRefreshToken = String(data.refresh_token);
  }

  return data;
}

/**
 * Revoke the Google OAuth token/grant remotely (via the Option H /api/auth/logout vault delete +
 * upstream revoke, or legacy worker /auth/revoke + Google OAuth2 revoke) and clear local state.
 */
export async function revokeGoogleToken(token = getStoredRefreshToken(), { fetchImpl = fetch } = {}) {
  const targetToken = String(token || getStoredRefreshToken() || '').trim();
  clearStoredRefreshToken();

  const baseUrl = getAuthApiBaseUrl();
  const sameOrigin = isSameOriginAuthAvailable();
  let workerRevoked = false;
  let googleRevoked = false;
  let attempted = false;

  if (baseUrl && typeof fetchImpl === 'function') {
    attempted = true;
    try {
      const endpoint = sameOrigin ? `${baseUrl}/logout` : `${baseUrl}/revoke`;
      const workerRes = await fetchImpl(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
        body: JSON.stringify(targetToken ? { token: targetToken } : {}),
      });
      if (workerRes?.ok) {
        const body = await workerRes.json().catch(() => ({}));
        workerRevoked = sameOrigin ? Boolean(body?.revoked ?? true) : true;
      }
    } catch {
      // Fall through to direct Google revocation when client holds a token
    }
  }

  // Same-origin /api/auth/logout already unsealed and revoked the upstream grant server-side.
  if (!(sameOrigin && workerRevoked) && targetToken && typeof fetchImpl === 'function') {
    attempted = true;
    try {
      const googleRes = await fetchImpl('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ token: targetToken }).toString(),
      });
      if (googleRes?.ok) {
        googleRevoked = true;
      }
    } catch {
      // Handled below
    }
  }

  if (!attempted || workerRevoked || googleRevoked) {
    return { revoked: attempted ? (workerRevoked || googleRevoked) : false, warning: '' };
  }

  return {
    revoked: false,
    warning: 'Signed out locally, but remote Google grant revocation could not be completed.',
  };
}
