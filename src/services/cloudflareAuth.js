/**
 * Sisic Music — Cloudflare Auth Worker Client Service
 * 
 * Communicates with the Cloudflare Worker auth backend to perform
 * authorization code exchange and silent token renewal using stored refresh tokens.
 */

export const REFRESH_TOKEN_STORAGE_KEY = 'sisic_refresh_token';

export function getAuthWorkerUrl() {
  const url = import.meta.env.VITE_AUTH_WORKER_URL?.trim() || '';
  return url.replace(/\/$/, '');
}

export function isAuthWorkerConfigured() {
  return Boolean(getAuthWorkerUrl());
}

export function getStoredRefreshToken() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(REFRESH_TOKEN_STORAGE_KEY) : null;
  } catch {
    return null;
  }
}

export function setStoredRefreshToken(token) {
  try {
    if (typeof localStorage !== 'undefined') {
      if (token) {
        localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, token);
      } else {
        localStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
      }
    }
  } catch (err) {
    console.warn('Failed to persist refresh token in localStorage:', err);
  }
}

export function clearStoredRefreshToken() {
  setStoredRefreshToken(null);
}

/**
 * Exchange an OAuth authorization code with the Cloudflare Worker.
 */
export async function exchangeCodeWithWorker(code, redirectUri = 'postmessage') {
  const workerUrl = getAuthWorkerUrl();
  if (!workerUrl) throw new Error('Cloudflare Auth Worker URL is not configured.');

  const res = await fetch(`${workerUrl}/auth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, redirect_uri: redirectUri }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errorMsg = data.message || data.error || `Code exchange failed with status ${res.status}`;
    throw new Error(errorMsg);
  }

  if (data.refresh_token) {
    setStoredRefreshToken(data.refresh_token);
  }

  return data;
}

/**
 * Silently refresh the access token using the stored refresh token.
 */
export async function refreshAccessTokenWithWorker(refreshToken = getStoredRefreshToken()) {
  const workerUrl = getAuthWorkerUrl();
  if (!workerUrl) throw new Error('Cloudflare Auth Worker URL is not configured.');
  if (!refreshToken) throw new Error('No refresh token available.');

  const res = await fetch(`${workerUrl}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

  if (data.refresh_token) {
    setStoredRefreshToken(data.refresh_token);
  }

  return data;
}
