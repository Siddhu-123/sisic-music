export const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;
export const MIN_TOKEN_LIFETIME_SECONDS = 60;

export function tokenExpiryFromResponse(response = {}, now = Date.now()) {
  const reportedSeconds = Number(response.expires_in);
  const lifetimeSeconds = Number.isFinite(reportedSeconds) && reportedSeconds > 0
    ? Math.max(MIN_TOKEN_LIFETIME_SECONDS, reportedSeconds)
    : DEFAULT_TOKEN_LIFETIME_SECONDS;
  return now + (lifetimeSeconds * 1000);
}

export function workerAuthMessageAction(message = {}, state = {}) {
  if (message.type === 'SISIC_DRIVE_TOKEN_REQUEST') {
    return state.isAuthenticated ? 'sync-token' : 'ignore';
  }
  if (message.type !== 'SISIC_DRIVE_AUTH_ERROR') return 'ignore';
  if (!state.isAuthenticated) return 'ignore';
  if (message.tokenVersion && message.tokenVersion !== state.tokenVersion) return 'sync-token';
  return 'reauthorize';
}
