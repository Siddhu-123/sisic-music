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

export function isAuthWorkerConfigured() {
  return Boolean(getAuthWorkerUrl());
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
  const workerUrl = getAuthWorkerUrl();
  if (!workerUrl) throw new Error('Cloudflare Auth Worker URL is not configured.');

  const res = await fetch(`${workerUrl}/auth/exchange`, {
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
 * Silently refresh the access token using the volatile refresh token or server session.
 */
export async function refreshAccessTokenWithWorker(refreshToken = getStoredRefreshToken()) {
  const workerUrl = getAuthWorkerUrl();
  if (!workerUrl) throw new Error('Cloudflare Auth Worker URL is not configured.');
  if (!refreshToken) throw new Error('No refresh token available.');

  const res = await fetch(`${workerUrl}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 || data.error === 'invalid_grant') {
      clearStoredRefreshToken();
    }
    const errorMsg = data.message || data.error || `Token refresh failed with status ${res.status}`;
    throw new Error(errorMsg);
  }

  clearPersistentRefreshToken();
  if (data.refresh_token) {
    volatileRefreshToken = String(data.refresh_token);
  }

  return data;
}

/**
 * Revoke the Google OAuth token/grant remotely (via the auth worker if configured
 * and via Google's OAuth2 revocation endpoint) while always clearing local token state.
 */
export async function revokeGoogleToken(token = getStoredRefreshToken(), { fetchImpl = fetch } = {}) {
  const targetToken = String(token || getStoredRefreshToken() || '').trim();
  clearStoredRefreshToken();

  const workerUrl = getAuthWorkerUrl();
  let workerRevoked = false;
  let googleRevoked = false;
  let attempted = false;

  if (workerUrl && typeof fetchImpl === 'function') {
    attempted = true;
    try {
      const workerRes = await fetchImpl(`${workerUrl}/auth/revoke`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
        body: JSON.stringify(targetToken ? { token: targetToken } : {}),
      });
      if (workerRes?.ok) {
        workerRevoked = true;
      }
    } catch {
      // Fall through to direct Google revocation
    }
  }

  if (targetToken && typeof fetchImpl === 'function') {
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
