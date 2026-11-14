import {
  SESSION_TTL_MS,
  SESSION_TTL_SECONDS,
  TX_TTL_MS,
  TX_TTL_SECONDS,
  buildSetCookie,
  constantTimeEqual,
  createD1SessionStore,
  isSecureRequestUrl,
  parseCookies,
  randomTokenId,
  sanitizeReturnTo,
  sealJsonAead,
  sealRefreshToken,
  sessionCookieName,
  sha256Base64Url,
  txCookieName,
  unsealJsonAead,
  unsealRefreshToken,
  verifySameOriginPost,
} from './_vault.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DEFAULT_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

function jsonResponse(body, status = 200, headers = {}) {
  const respHeaders = new Headers({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  return new Response(JSON.stringify(body), { status, headers: respHeaders });
}

function redirectResponse(location, cookies = []) {
  const headers = new Headers({
    Location: location,
    'Cache-Control': 'no-store',
  });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
}

function resolveAction(pathname) {
  const normalized = pathname.replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts.at(-1) || '';
}

function allowedOriginsFromEnv(env) {
  return String(env?.ALLOWED_ORIGINS || env?.ALLOWED_ORIGIN || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function validateConfig(env) {
  if (!env?.GOOGLE_CLIENT_ID || !env?.GOOGLE_CLIENT_SECRET || !env?.AUTH_ENC_KEY) {
    return 'Missing server auth secrets (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, AUTH_ENC_KEY).';
  }
  return '';
}

export async function handleAuthRequest({ request, env, fetchImpl = fetch, sessionStore = null, now = () => Date.now() }) {
  const url = new URL(request.url);
  const action = resolveAction(url.pathname);
  const secure = isSecureRequestUrl(url);
  const sessCookie = sessionCookieName(url);
  const txCookie = txCookieName(url);
  const allowedOrigins = allowedOriginsFromEnv(env);
  const cookies = parseCookies(request.headers.get('Cookie') || '');

  if (request.method === 'OPTIONS') {
    const origin = request.headers.get('Origin') || '';
    if (origin && (origin === url.origin || allowedOrigins.includes(origin))) {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, X-Sisic-SW',
          'Cache-Control': 'no-store',
        },
      });
    }
    return new Response(null, { status: 403 });
  }

  const configErr = validateConfig(env);
  const store = sessionStore || (env?.AUTH_DB ? createD1SessionStore(env.AUTH_DB) : null);
  if (!store || configErr) {
    return jsonResponse({ error: 'vault_unconfigured', message: configErr || 'AUTH_DB D1 binding missing.' }, 503);
  }

  const currentNow = now();

  // 1. GET /api/auth/session — non-secret cookie existence check for Offline-First Boot
  if (request.method === 'GET' && action === 'session') {
    const sid = cookies.get(sessCookie);
    if (!sid) return jsonResponse({ authenticatedSession: false }, 200);
    const row = await store.get(sid);
    if (!row || Number(row.expires_at) <= currentNow) {
      if (row) await store.delete(sid);
      return jsonResponse({ authenticatedSession: false }, 200, {
        'Set-Cookie': buildSetCookie(sessCookie, '', { maxAgeSeconds: 0, path: '/', secure }),
      });
    }
    return jsonResponse({
      authenticatedSession: true,
      expiresAt: row.expires_at,
      scope: row.scope,
    }, 200);
  }

  // 2. GET /api/auth/login — Start top-level PKCE OAuth authorization code flow
  if (request.method === 'GET' && action === 'login') {
    const state = randomTokenId(24);
    const codeVerifier = randomTokenId(48);
    const codeChallenge = await sha256Base64Url(codeVerifier);
    const returnTo = sanitizeReturnTo(url.searchParams.get('returnTo') || '/');
    const requestedPrompt = url.searchParams.get('prompt') === 'consent' ? 'consent' : 'select_account';
    const scope = String(env.GOOGLE_DRIVE_SCOPE || DEFAULT_DRIVE_SCOPE);

    const txSealed = await sealJsonAead(
      env.AUTH_ENC_KEY,
      { state, codeVerifier, returnTo, exp: currentNow + TX_TTL_MS },
      'sisic-oauth-tx',
    );
    const txSetCookie = buildSetCookie(txCookie, `${txSealed.nonce}.${txSealed.ciphertext}`, {
      maxAgeSeconds: TX_TTL_SECONDS,
      path: '/',
      secure,
      sameSite: 'Lax',
    });

    const authUrl = new URL(GOOGLE_AUTH_URL);
    authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', `${url.origin}/api/auth/callback`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scope);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('include_granted_scopes', 'true');
    authUrl.searchParams.set('prompt', requestedPrompt);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    return redirectResponse(authUrl.toString(), [txSetCookie]);
  }

  // 3. GET /api/auth/callback — Verify state/PKCE, exchange code, seal refresh token in D1
  if (request.method === 'GET' && action === 'callback') {
    const oauthError = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    const clearTxCookie = buildSetCookie(txCookie, '', { maxAgeSeconds: 0, path: '/', secure });

    if (oauthError) {
      return redirectResponse(`/?auth_error=${encodeURIComponent(oauthError)}`, [clearTxCookie]);
    }

    const rawTx = cookies.get(txCookie) || '';
    const dotIdx = rawTx.indexOf('.');
    if (dotIdx <= 0 || !code || !returnedState) {
      return redirectResponse('/?auth_error=invalid_oauth_state', [clearTxCookie]);
    }

    let tx;
    try {
      tx = await unsealJsonAead(
        env.AUTH_ENC_KEY,
        { nonce: rawTx.slice(0, dotIdx), ciphertext: rawTx.slice(dotIdx + 1) },
        'sisic-oauth-tx',
      );
    } catch {
      return redirectResponse('/?auth_error=corrupt_oauth_state', [clearTxCookie]);
    }

    if (!tx?.exp || currentNow > tx.exp || !constantTimeEqual(tx.state, returnedState)) {
      return redirectResponse('/?auth_error=state_mismatch', [clearTxCookie]);
    }

    const tokenResp = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${url.origin}/api/auth/callback`,
        code_verifier: tx.codeVerifier,
        grant_type: 'authorization_code',
      }).toString(),
    });
    const tokenData = await tokenResp.json().catch(() => ({}));
    if (!tokenResp.ok || !tokenData.access_token) {
      return redirectResponse('/?auth_error=code_exchange_failed', [clearTxCookie]);
    }

    const existingSid = cookies.get(sessCookie);
    let refreshToken = tokenData.refresh_token || '';
    if (!refreshToken && existingSid) {
      const existingRow = await store.get(existingSid);
      if (existingRow) {
        try {
          refreshToken = await unsealRefreshToken(env.AUTH_ENC_KEY, {
            sid: existingRow.sid,
            epoch: existingRow.token_epoch,
            encRefreshToken: existingRow.enc_refresh_token,
            nonce: existingRow.nonce,
          });
        } catch {
          refreshToken = '';
        }
      }
    }
    if (!refreshToken) {
      // Force Google consent screen once if Google withheld an offline refresh token on first grant.
      return redirectResponse('/api/auth/login?prompt=consent', [clearTxCookie]);
    }

    const sid = existingSid || randomTokenId(32);
    const epoch = 1;
    const sealed = await sealRefreshToken(env.AUTH_ENC_KEY, { sid, epoch, refreshToken });
    await store.put({
      sid,
      enc_refresh_token: sealed.ciphertext,
      nonce: sealed.nonce,
      scope: String(tokenData.scope || env.GOOGLE_DRIVE_SCOPE || DEFAULT_DRIVE_SCOPE),
      token_epoch: epoch,
      expires_at: currentNow + SESSION_TTL_MS,
      created_at: currentNow,
      last_used_at: currentNow,
    });

    const sessSetCookie = buildSetCookie(sessCookie, sid, {
      maxAgeSeconds: SESSION_TTL_SECONDS,
      path: '/',
      secure,
      sameSite: 'Lax',
    });
    return redirectResponse(sanitizeReturnTo(tx.returnTo || '/'), [clearTxCookie, sessSetCookie]);
  }

  // Enforce same-origin CSRF validation for all state-changing / token-minting POST routes
  if (request.method === 'POST') {
    if (!verifySameOriginPost(request, allowedOrigins)) {
      return jsonResponse({ error: 'csrf_rejected', message: 'Cross-origin POST rejected.' }, 403);
    }
  }

  // 4. POST /api/auth/exchange — GIS popup code exchange storing refresh_token exclusively in D1
  if (request.method === 'POST' && action === 'exchange') {
    const body = await request.json().catch(() => ({}));
    const code = String(body.code || '').trim();
    const redirectUri = String(body.redirect_uri || 'postmessage').trim();
    if (!code) return jsonResponse({ error: 'invalid_request', message: 'Missing code.' }, 400);

    const tokenResp = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });
    const tokenData = await tokenResp.json().catch(() => ({}));
    if (!tokenResp.ok || !tokenData.access_token) {
      return jsonResponse({ error: tokenData.error || 'exchange_failed', message: tokenData.error_description || 'Token exchange failed.' }, tokenResp.status || 400);
    }

    const headers = {};
    if (tokenData.refresh_token) {
      const sid = randomTokenId(32);
      const epoch = 1;
      const sealed = await sealRefreshToken(env.AUTH_ENC_KEY, { sid, epoch, refreshToken: tokenData.refresh_token });
      await store.put({
        sid,
        enc_refresh_token: sealed.ciphertext,
        nonce: sealed.nonce,
        scope: String(tokenData.scope || DEFAULT_DRIVE_SCOPE),
        token_epoch: epoch,
        expires_at: currentNow + SESSION_TTL_MS,
        created_at: currentNow,
        last_used_at: currentNow,
      });
      headers['Set-Cookie'] = buildSetCookie(sessCookie, sid, {
        maxAgeSeconds: SESSION_TTL_SECONDS,
        path: '/',
        secure,
        sameSite: 'Lax',
      });
    }

    return jsonResponse({
      access_token: tokenData.access_token,
      expires_in: tokenData.expires_in,
      token_type: tokenData.token_type || 'Bearer',
      scope: tokenData.scope,
      session_active: Boolean(tokenData.refresh_token || cookies.get(sessCookie)),
    }, 200, headers);
  }

  // 5. POST /api/auth/refresh — Mint short-lived access_token from D1 sealed refresh_token
  if (request.method === 'POST' && action === 'refresh') {
    const sid = cookies.get(sessCookie);
    if (!sid) {
      return jsonResponse({ error: 'session_missing', message: 'No active auth session.' }, 401);
    }
    const row = await store.get(sid);
    if (!row || Number(row.expires_at) <= currentNow) {
      if (row) await store.delete(sid);
      return jsonResponse({ error: 'session_expired', message: 'Auth session expired.' }, 401, {
        'Set-Cookie': buildSetCookie(sessCookie, '', { maxAgeSeconds: 0, path: '/', secure }),
      });
    }

    let refreshToken;
    try {
      refreshToken = await unsealRefreshToken(env.AUTH_ENC_KEY, {
        sid: row.sid,
        epoch: row.token_epoch,
        encRefreshToken: row.enc_refresh_token,
        nonce: row.nonce,
      });
    } catch {
      await store.delete(sid);
      return jsonResponse({ error: 'vault_decrypt_failed', message: 'Session could not be decrypted.' }, 401, {
        'Set-Cookie': buildSetCookie(sessCookie, '', { maxAgeSeconds: 0, path: '/', secure }),
      });
    }

    const tokenResp = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        grant_type: 'refresh_token',
      }).toString(),
    });
    const tokenData = await tokenResp.json().catch(() => ({}));
    if (!tokenResp.ok || !tokenData.access_token) {
      if (tokenResp.status === 400 || tokenResp.status === 401 || tokenData.error === 'invalid_grant') {
        await store.delete(sid);
        return jsonResponse({
          error: tokenData.error || 'invalid_grant',
          message: tokenData.error_description || 'Google refresh grant revoked or expired.',
        }, 401, {
          'Set-Cookie': buildSetCookie(sessCookie, '', { maxAgeSeconds: 0, path: '/', secure }),
        });
      }
      return jsonResponse({
        error: tokenData.error || 'upstream_refresh_failed',
        message: 'Temporary error refreshing Google access token.',
      }, 502);
    }

    const nextEpoch = tokenData.refresh_token ? Number(row.token_epoch || 1) + 1 : Number(row.token_epoch || 1);
    const nextRefresh = tokenData.refresh_token || refreshToken;
    const sealed = tokenData.refresh_token
      ? await sealRefreshToken(env.AUTH_ENC_KEY, { sid, epoch: nextEpoch, refreshToken: nextRefresh })
      : { ciphertext: row.enc_refresh_token, nonce: row.nonce };

    await store.put({
      sid,
      enc_refresh_token: sealed.ciphertext,
      nonce: sealed.nonce,
      scope: String(tokenData.scope || row.scope || ''),
      token_epoch: nextEpoch,
      expires_at: currentNow + SESSION_TTL_MS,
      created_at: row.created_at,
      last_used_at: currentNow,
    });

    const sessSetCookie = buildSetCookie(sessCookie, sid, {
      maxAgeSeconds: SESSION_TTL_SECONDS,
      path: '/',
      secure,
      sameSite: 'Lax',
    });
    return jsonResponse({
      access_token: tokenData.access_token,
      expires_in: tokenData.expires_in,
      token_type: tokenData.token_type || 'Bearer',
      scope: tokenData.scope || row.scope,
      session_active: true,
    }, 200, { 'Set-Cookie': sessSetCookie });
  }

  // 6. POST /api/auth/logout (or /revoke) — Delete D1 vault row, clear cookie, revoke upstream grant
  if (request.method === 'POST' && (action === 'logout' || action === 'revoke')) {
    const sid = cookies.get(sessCookie);
    let tokenToRevoke = '';
    if (sid) {
      const row = await store.get(sid);
      if (row) {
        try {
          tokenToRevoke = await unsealRefreshToken(env.AUTH_ENC_KEY, {
            sid: row.sid,
            epoch: row.token_epoch,
            encRefreshToken: row.enc_refresh_token,
            nonce: row.nonce,
          });
        } catch {
          tokenToRevoke = '';
        }
        await store.delete(sid);
      }
    }
    const body = await request.json().catch(() => ({}));
    if (!tokenToRevoke && body?.token) tokenToRevoke = String(body.token);

    let revoked = false;
    if (tokenToRevoke) {
      try {
        const revResp = await fetchImpl(GOOGLE_REVOKE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: tokenToRevoke }).toString(),
        });
        revoked = Boolean(revResp?.ok);
      } catch {
        revoked = false;
      }
    }
    return jsonResponse({ signedOut: true, revoked }, 200, {
      'Set-Cookie': buildSetCookie(sessCookie, '', { maxAgeSeconds: 0, path: '/', secure }),
    });
  }

  return jsonResponse({ error: 'not_found', message: 'Unknown auth endpoint.' }, 404);
}

export function onRequest(context) {
  return handleAuthRequest({ request: context.request, env: context.env });
}
