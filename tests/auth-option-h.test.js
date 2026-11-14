import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { handleAuthRequest } from '../functions/api/auth/[[path]].js';
import {
  createMemorySessionStore,
  sealRefreshToken,
  unsealRefreshToken,
  sanitizeReturnTo,
} from '../functions/api/auth/_vault.js';

const TEST_ENC_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY'; // 32 bytes base64url

function makeEnv() {
  return {
    GOOGLE_CLIENT_ID: 'client-id-123.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'client-secret-xyz',
    AUTH_ENC_KEY: TEST_ENC_KEY,
    GOOGLE_DRIVE_SCOPE: 'https://www.googleapis.com/auth/drive',
  };
}

function extractCookies(response) {
  const raw = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  const map = new Map();
  for (const line of raw) {
    const first = line.split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) map.set(first.slice(0, eq).trim(), decodeURIComponent(first.slice(eq + 1).trim()));
  }
  return map;
}

test('AEAD vault binds ciphertext to sid and token_epoch (rejects cross-row or epoch swaps)', async () => {
  const sealed = await sealRefreshToken(TEST_ENC_KEY, {
    sid: 'session-A',
    epoch: 2,
    refreshToken: '1//google-refresh-secret',
  });
  const ok = await unsealRefreshToken(TEST_ENC_KEY, {
    sid: 'session-A',
    epoch: 2,
    encRefreshToken: sealed.ciphertext,
    nonce: sealed.nonce,
  });
  assert.equal(ok, '1//google-refresh-secret');

  await assert.rejects(
    unsealRefreshToken(TEST_ENC_KEY, {
      sid: 'session-B',
      epoch: 2,
      encRefreshToken: sealed.ciphertext,
      nonce: sealed.nonce,
    }),
  );
  await assert.rejects(
    unsealRefreshToken(TEST_ENC_KEY, {
      sid: 'session-A',
      epoch: 1,
      encRefreshToken: sealed.ciphertext,
      nonce: sealed.nonce,
    }),
  );
});

test('sanitizeReturnTo blocks open redirects', () => {
  assert.equal(sanitizeReturnTo('/library?view=1'), '/library?view=1');
  assert.equal(sanitizeReturnTo('//evil.example/steal'), '/');
  assert.equal(sanitizeReturnTo('https://evil.example'), '/');
  assert.equal(sanitizeReturnTo('/\\evil.example'), '/');
});

test('Option H full PKCE login -> callback -> D1 sealed vault -> refresh -> rotation -> logout replay rejection', async () => {
  const env = makeEnv();
  const store = createMemorySessionStore();
  let fakeNow = 1_700_000_000_000;
  let refreshCallCount = 0;

  const mockFetch = async (url, init) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      const params = new URLSearchParams(init.body);
      const grantType = params.get('grant_type');
      if (grantType === 'authorization_code') {
        assert.ok(params.get('code_verifier'));
        return new Response(JSON.stringify({
          access_token: 'access-initial',
          refresh_token: 'refresh-secret-1',
          expires_in: 3600,
          scope: env.GOOGLE_DRIVE_SCOPE,
        }), { status: 200 });
      }
      if (grantType === 'refresh_token') {
        refreshCallCount++;
        const rt = params.get('refresh_token');
        if (refreshCallCount === 1) {
          assert.equal(rt, 'refresh-secret-1');
          // Simulate upstream Google refresh token rotation on first refresh!
          return new Response(JSON.stringify({
            access_token: 'access-rotated-2',
            refresh_token: 'refresh-secret-2',
            expires_in: 3600,
          }), { status: 200 });
        }
        assert.equal(rt, 'refresh-secret-2');
        return new Response(JSON.stringify({
          access_token: 'access-steady-3',
          expires_in: 3600,
        }), { status: 200 });
      }
    }
    if (String(url) === 'https://oauth2.googleapis.com/revoke') {
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  // Step 1: Login initiates PKCE + sealed TX cookie + offline redirect
  const loginRes = await handleAuthRequest({
    request: new Request('https://sisic-music.pages.dev/api/auth/login?returnTo=//evil.com', { method: 'GET' }),
    env,
    fetchImpl: mockFetch,
    sessionStore: store,
    now: () => fakeNow,
  });
  assert.equal(loginRes.status, 302);
  const googleAuthUrl = new URL(loginRes.headers.get('Location'));
  assert.equal(googleAuthUrl.origin, 'https://accounts.google.com');
  assert.equal(googleAuthUrl.searchParams.get('access_type'), 'offline');
  assert.equal(googleAuthUrl.searchParams.get('code_challenge_method'), 'S256');
  const state = googleAuthUrl.searchParams.get('state');
  const loginCookies = extractCookies(loginRes);
  const txVal = loginCookies.get('__Host-sisic_oauth_tx');
  assert.ok(txVal);

  // Step 2: Callback exchanges code, seals refresh token in D1, sets __Host-sisic_session cookie
  const cbRes = await handleAuthRequest({
    request: new Request(`https://sisic-music.pages.dev/api/auth/callback?code=auth-code-99&state=${encodeURIComponent(state)}`, {
      method: 'GET',
      headers: { Cookie: `__Host-sisic_oauth_tx=${encodeURIComponent(txVal)}` },
    }),
    env,
    fetchImpl: mockFetch,
    sessionStore: store,
    now: () => fakeNow,
  });
  assert.equal(cbRes.status, 302);
  // Open redirect attempt sanitized to '/' and ZERO tokens in redirect URL
  assert.equal(cbRes.headers.get('Location'), '/');
  const cbCookies = extractCookies(cbRes);
  const sid = cbCookies.get('__Host-sisic_session');
  assert.ok(sid && store.rows.has(sid));
  assert.ok(!JSON.stringify(store.rows.get(sid)).includes('refresh-secret-1'));

  // Step 3: Cross-origin CSRF POST rejected with 403
  const csrfRes = await handleAuthRequest({
    request: new Request('https://sisic-music.pages.dev/api/auth/refresh', {
      method: 'POST',
      headers: {
        Origin: 'https://attacker.example',
        'Sec-Fetch-Site': 'cross-site',
        Cookie: `__Host-sisic_session=${encodeURIComponent(sid)}`,
      },
    }),
    env,
    fetchImpl: mockFetch,
    sessionStore: store,
    now: () => fakeNow,
  });
  assert.equal(csrfRes.status, 403);

  // Step 4: Same-origin refresh mints access_token cleanly, never returns refresh_token, and increments epoch on rotation
  fakeNow += 14 * 24 * 60 * 60 * 1000; // 14 days later!
  const ref1 = await handleAuthRequest({
    request: new Request('https://sisic-music.pages.dev/api/auth/refresh', {
      method: 'POST',
      headers: {
        Origin: 'https://sisic-music.pages.dev',
        'Sec-Fetch-Site': 'same-origin',
        Cookie: `__Host-sisic_session=${encodeURIComponent(sid)}`,
      },
    }),
    env,
    fetchImpl: mockFetch,
    sessionStore: store,
    now: () => fakeNow,
  });
  assert.equal(ref1.status, 200);
  assert.equal(ref1.headers.get('Cache-Control'), 'no-store');
  const body1 = await ref1.json();
  assert.equal(body1.access_token, 'access-rotated-2');
  assert.equal(body1.refresh_token, undefined);
  assert.equal(store.rows.get(sid).token_epoch, 2);

  // Second refresh uses rotated refresh-secret-2
  const ref2 = await handleAuthRequest({
    request: new Request('https://sisic-music.pages.dev/api/auth/refresh', {
      method: 'POST',
      headers: {
        'Sec-Fetch-Site': 'same-origin',
        'X-Sisic-SW': '1',
        Cookie: `__Host-sisic_session=${encodeURIComponent(sid)}`,
      },
    }),
    env,
    fetchImpl: mockFetch,
    sessionStore: store,
    now: () => fakeNow,
  });
  assert.equal(ref2.status, 200);
  const body2 = await ref2.json();
  assert.equal(body2.access_token, 'access-steady-3');

  // Step 5: Logout deletes D1 row, clears cookie, and subsequent replay of old sid fails with 401
  const outRes = await handleAuthRequest({
    request: new Request('https://sisic-music.pages.dev/api/auth/logout', {
      method: 'POST',
      headers: {
        Origin: 'https://sisic-music.pages.dev',
        Cookie: `__Host-sisic_session=${encodeURIComponent(sid)}`,
      },
    }),
    env,
    fetchImpl: mockFetch,
    sessionStore: store,
    now: () => fakeNow,
  });
  assert.equal(outRes.status, 200);
  assert.equal(store.rows.has(sid), false);

  const replayRes = await handleAuthRequest({
    request: new Request('https://sisic-music.pages.dev/api/auth/refresh', {
      method: 'POST',
      headers: {
        Origin: 'https://sisic-music.pages.dev',
        Cookie: `__Host-sisic_session=${encodeURIComponent(sid)}`,
      },
    }),
    env,
    fetchImpl: mockFetch,
    sessionStore: store,
    now: () => fakeNow,
  });
  assert.equal(replayRes.status, 401);
});

test('Service Worker automatically refreshes access token via same-origin cookie on 401 without breaking audio playback', async () => {
  const authNotifications = [];
  const fetchCalls = [];
  const context = {
    URL,
    Headers,
    Response,
    setTimeout,
    clearTimeout,
    fetch: async (url, init = {}) => {
      fetchCalls.push({ url: String(url), headers: init.headers });
      if (String(url).endsWith('/api/auth/refresh')) {
        assert.equal(init.credentials, 'include');
        assert.equal(init.headers['X-Sisic-SW'], '1');
        return new Response(JSON.stringify({ access_token: 'fresh-sw-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (String(url).includes('fields=size,mimeType')) {
        const auth = init.headers?.Authorization || init.headers?.get?.('Authorization');
        if (auth === 'Bearer expired-token') {
          return new Response('Unauthorized', { status: 401 });
        }
        assert.equal(auth, 'Bearer fresh-sw-token');
        return new Response(JSON.stringify({ size: 1000, mimeType: 'audio/mpeg' }), { status: 200 });
      }
      if (String(url).includes('alt=media')) {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 206,
          headers: { 'Content-Length': '4' },
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    },
    self: {
      addEventListener() {},
      location: { origin: 'https://sisic-music.pages.dev', href: 'https://sisic-music.pages.dev/stream-sw.js' },
      clients: {
        matchAll: async () => [{ postMessage: msg => authNotifications.push(msg) }],
      },
    },
  };
  vm.createContext(context);
  const source = fs.readFileSync(new URL('../public/stream-sw.js', import.meta.url), 'utf8');
  vm.runInContext(source, context);
  vm.runInContext("driveAccessToken = 'expired-token'; driveTokenVersion = 'v1';", context);

  const req = {
    signal: new AbortController().signal,
    headers: new Headers({ Range: 'bytes=0-3' }),
  };
  context.__testReq = req;
  const resp = await vm.runInContext("streamDriveFile('file-abc', __testReq)", context);
  assert.equal(resp.status, 206);
  assert.equal(resp.headers.get('Content-Range'), 'bytes 0-3/1000');
  assert.equal(authNotifications.some(m => m.type === 'SISIC_DRIVE_AUTH_ERROR'), false);
  assert.ok(fetchCalls.some(c => c.url.endsWith('/api/auth/refresh')));
});

test('Concurrent refresh race fence prevents stale epoch overwrite and false invalid_grant delete', async () => {
  const env = makeEnv();
  const store = createMemorySessionStore();
  const sealed1 = await sealRefreshToken(TEST_ENC_KEY, { sid: 'sid-race', epoch: 1, refreshToken: 'rt-epoch-1' });
  await store.put({
    sid: 'sid-race',
    enc_refresh_token: sealed1.ciphertext,
    nonce: sealed1.nonce,
    scope: env.GOOGLE_DRIVE_SCOPE,
    token_epoch: 1,
    expires_at: 2_000_000_000_000,
    created_at: 1_700_000_000_000,
    last_used_at: 1_700_000_000_000,
  });

  // Stale epoch put cannot downgrade a newer epoch
  const sealed2 = await sealRefreshToken(TEST_ENC_KEY, { sid: 'sid-race', epoch: 2, refreshToken: 'rt-epoch-2' });
  await store.put({
    sid: 'sid-race',
    enc_refresh_token: sealed2.ciphertext,
    nonce: sealed2.nonce,
    scope: env.GOOGLE_DRIVE_SCOPE,
    token_epoch: 2,
    expires_at: 2_000_000_000_000,
    created_at: 1_700_000_000_000,
    last_used_at: 1_700_000_000_000,
  });
  await store.put({ ...sealed1, sid: 'sid-race', enc_refresh_token: sealed1.ciphertext, nonce: sealed1.nonce, token_epoch: 1, expires_at: 2_000_000_000_000 });
  assert.equal(store.rows.get('sid-race').token_epoch, 2);

  // Concurrent refresh: reset store to epoch 1, then rotate to epoch 2 *while* upstream refresh is in flight
  await store.delete('sid-race');
  await store.put({
    sid: 'sid-race',
    enc_refresh_token: sealed1.ciphertext,
    nonce: sealed1.nonce,
    scope: env.GOOGLE_DRIVE_SCOPE,
    token_epoch: 1,
    expires_at: 2_000_000_000_000,
    created_at: 1_700_000_000_000,
    last_used_at: 1_700_000_000_000,
  });

  let call = 0;
  const raceFetch = async (url, init) => {
    assert.equal(String(url), 'https://oauth2.googleapis.com/token');
    const params = new URLSearchParams(init.body);
    call += 1;
    if (call === 1) {
      assert.equal(params.get('refresh_token'), 'rt-epoch-1');
      // Another worker/tab rotated epoch 1 -> 2 before our response finished
      await store.put({
        sid: 'sid-race',
        enc_refresh_token: sealed2.ciphertext,
        nonce: sealed2.nonce,
        scope: env.GOOGLE_DRIVE_SCOPE,
        token_epoch: 2,
        expires_at: 2_000_000_000_000,
        created_at: 1_700_000_000_000,
        last_used_at: 1_700_000_000_000,
      });
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    }
    assert.equal(params.get('refresh_token'), 'rt-epoch-2');
    return new Response(JSON.stringify({ access_token: 'recovered-epoch-2', expires_in: 3600 }), { status: 200 });
  };

  const res = await handleAuthRequest({
    request: new Request('https://sisic-music.pages.dev/api/auth/refresh', {
      method: 'POST',
      headers: {
        Origin: 'https://sisic-music.pages.dev',
        Cookie: '__Host-sisic_session=sid-race',
      },
    }),
    env,
    fetchImpl: raceFetch,
    sessionStore: store,
    now: () => 1_700_000_100_000,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.access_token, 'recovered-epoch-2');
  assert.equal(store.rows.get('sid-race')?.token_epoch, 2);
});

test('Account-switch callback never inherits previous refresh_token, preserves returnTo, and attaches security headers', async () => {
  const env = makeEnv();
  const store = createMemorySessionStore();
  const oldSealed = await sealRefreshToken(TEST_ENC_KEY, { sid: 'old-user-a-sid', epoch: 1, refreshToken: 'user-a-refresh' });
  await store.put({
    sid: 'old-user-a-sid',
    enc_refresh_token: oldSealed.ciphertext,
    nonce: oldSealed.nonce,
    scope: env.GOOGLE_DRIVE_SCOPE,
    token_epoch: 1,
    expires_at: 2_000_000_000_000,
    created_at: 1_700_000_000_000,
    last_used_at: 1_700_000_000_000,
  });

  const loginRes = await handleAuthRequest({
    request: new Request('https://sisic-music.pages.dev/api/auth/login?prompt=select_account&returnTo=%2Fexplore', { method: 'GET' }),
    env,
    sessionStore: store,
    now: () => 1_700_000_000_000,
  });
  assert.equal(loginRes.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(loginRes.headers.get('Referrer-Policy'), 'same-origin');
  assert.equal(loginRes.headers.get('X-Frame-Options'), 'DENY');
  const loc = new URL(loginRes.headers.get('Location'));
  const state = loc.searchParams.get('state');
  const txVal = extractCookies(loginRes).get('__Host-sisic_oauth_tx');

  // Simulate Google returning User B access_token WITHOUT refresh_token on select_account
  const cbRes = await handleAuthRequest({
    request: new Request(`https://sisic-music.pages.dev/api/auth/callback?code=user-b-code&state=${encodeURIComponent(state)}`, {
      method: 'GET',
      headers: {
        Cookie: `__Host-sisic_oauth_tx=${encodeURIComponent(txVal)}; __Host-sisic_session=old-user-a-sid`,
      },
    }),
    env,
    fetchImpl: async () => new Response(JSON.stringify({ access_token: 'user-b-access', expires_in: 3600 }), { status: 200 }),
    sessionStore: store,
    now: () => 1_700_000_000_000,
  });
  assert.equal(cbRes.status, 302);
  // Old User A session deleted, User A token NOT inherited, returnTo preserved on prompt=consent escalation
  assert.equal(store.rows.has('old-user-a-sid'), false);
  assert.equal(cbRes.headers.get('Location'), '/api/auth/login?prompt=consent&returnTo=%2Fexplore');
  assert.equal(cbRes.headers.get('X-Frame-Options'), 'DENY');
});
