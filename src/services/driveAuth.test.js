import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TOKEN_LIFETIME_SECONDS,
  MIN_TOKEN_LIFETIME_SECONDS,
  tokenExpiryFromResponse,
  workerAuthMessageAction,
} from './driveAuth.js';

test('token expiry uses Google lifetime and safe fallbacks', () => {
  const now = 1_000_000;
  assert.equal(tokenExpiryFromResponse({ expires_in: 3600 }, now), now + 3_600_000);
  assert.equal(tokenExpiryFromResponse({ expires_in: 5 }, now), now + (MIN_TOKEN_LIFETIME_SECONDS * 1000));
  assert.equal(tokenExpiryFromResponse({}, now), now + (DEFAULT_TOKEN_LIFETIME_SECONDS * 1000));
});

test('worker token requests recover without falsely logging out', () => {
  const state = { isAuthenticated: true, tokenVersion: 'current' };
  assert.equal(workerAuthMessageAction({ type: 'SISIC_DRIVE_TOKEN_REQUEST' }, state), 'sync-token');
  assert.equal(workerAuthMessageAction({ type: 'SISIC_DRIVE_AUTH_ERROR', tokenVersion: 'old' }, state), 'sync-token');
  assert.equal(workerAuthMessageAction({ type: 'SISIC_DRIVE_AUTH_ERROR', tokenVersion: 'current' }, state), 'reauthorize');
});
