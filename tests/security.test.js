import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  REFRESH_TOKEN_STORAGE_KEY,
  getStoredRefreshToken,
  setStoredRefreshToken,
  clearStoredRefreshToken,
  exchangeCodeWithWorker,
  refreshAccessTokenWithWorker,
  revokeGoogleToken,
} from '../src/services/cloudflareAuth.js';
import { GoogleDriveService } from '../src/services/GoogleDriveService.js';
import {
  GEMMA_SERVICE_CONFIG_KEY,
  getGemmaServiceConfig,
  saveGemmaServiceConfig,
  clearGemmaServiceToken,
  rotateGemmaServiceToken,
} from '../src/services/gemmaServiceConfig.js';
import {
  exchangeGemmaSessionToken,
  revokeGemmaSessionToken,
  syncGemmaVectorsFromService,
  queryTextVector,
} from '../src/services/gemmaVectors.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
  };
}

test('Finding 1: refresh tokens are purged from persistent localStorage in browser environments and on Drive service init', async () => {
  const prevLocal = globalThis.localStorage;
  const prevSession = globalThis.sessionStorage;
  const local = makeStorage({ [REFRESH_TOKEN_STORAGE_KEY]: 'legacy-persistent-refresh-token' });
  const session = makeStorage();
  globalThis.localStorage = local;
  globalThis.sessionStorage = session;

  try {
    clearStoredRefreshToken();
    local.setItem(REFRESH_TOKEN_STORAGE_KEY, 'legacy-persistent-refresh-token');

    // Constructing GoogleDriveService purges any legacy refresh token from localStorage
    const service = new GoogleDriveService();
    assert.equal(local.getItem(REFRESH_TOKEN_STORAGE_KEY), null);

    // Setting a refresh token when sessionStorage exists never writes to localStorage
    local.setItem(REFRESH_TOKEN_STORAGE_KEY, 'stale-local-token');
    setStoredRefreshToken('session-only-token');
    assert.equal(local.getItem(REFRESH_TOKEN_STORAGE_KEY), null);
    assert.equal(session.getItem(REFRESH_TOKEN_STORAGE_KEY), 'session-only-token');
    assert.equal(getStoredRefreshToken(), 'session-only-token');

    // adoptStoredToken also purges any legacy localStorage refresh token
    local.setItem(REFRESH_TOKEN_STORAGE_KEY, 'another-stale-token');
    service.adoptStoredToken();
    assert.equal(local.getItem(REFRESH_TOKEN_STORAGE_KEY), null);

    clearStoredRefreshToken();
    assert.equal(getStoredRefreshToken(), null);
    assert.equal(session.getItem(REFRESH_TOKEN_STORAGE_KEY), null);
  } finally {
    clearStoredRefreshToken();
    globalThis.localStorage = prevLocal;
    globalThis.sessionStorage = prevSession;
  }
});

test('Finding 1: exchangeCodeWithWorker and refreshAccessTokenWithWorker keep refresh_token out of localStorage', async () => {
  const prevLocal = globalThis.localStorage;
  const prevSession = globalThis.sessionStorage;
  const prevFetch = globalThis.fetch;
  const prevEnv = process.env.VITE_AUTH_WORKER_URL;

  const local = makeStorage({ [REFRESH_TOKEN_STORAGE_KEY]: 'old-local-token' });
  const session = makeStorage();
  globalThis.localStorage = local;
  globalThis.sessionStorage = session;
  process.env.VITE_AUTH_WORKER_URL = 'https://auth.example.com';

  const fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'access-123',
        refresh_token: 'volatile-refresh-456',
        expires_in: 3600,
      }),
    };
  };

  try {
    clearStoredRefreshToken();
    local.setItem(REFRESH_TOKEN_STORAGE_KEY, 'old-local-token');

    const exchanged = await exchangeCodeWithWorker('auth-code-abc');
    assert.equal(exchanged.access_token, 'access-123');
    assert.equal(local.getItem(REFRESH_TOKEN_STORAGE_KEY), null);
    assert.equal(session.getItem(REFRESH_TOKEN_STORAGE_KEY), null);
    assert.equal(getStoredRefreshToken(), 'volatile-refresh-456');
    assert.equal(fetchCalls[0].options.credentials, 'include');
    assert.equal(fetchCalls[0].options.headers['Cache-Control'], 'no-store');

    const refreshed = await refreshAccessTokenWithWorker();
    assert.equal(refreshed.access_token, 'access-123');
    assert.equal(local.getItem(REFRESH_TOKEN_STORAGE_KEY), null);
    assert.equal(session.getItem(REFRESH_TOKEN_STORAGE_KEY), null);
    assert.equal(fetchCalls[1].options.credentials, 'include');
  } finally {
    clearStoredRefreshToken();
    if (prevEnv === undefined) delete process.env.VITE_AUTH_WORKER_URL;
    else process.env.VITE_AUTH_WORKER_URL = prevEnv;
    globalThis.fetch = prevFetch;
    globalThis.localStorage = prevLocal;
    globalThis.sessionStorage = prevSession;
  }
});

test('Finding 2: logout revokes Google grant remotely, clears local state on failure, and notifies user when revocation fails', async () => {
  const prevLocal = globalThis.localStorage;
  const prevSession = globalThis.sessionStorage;
  const local = makeStorage();
  const session = makeStorage();
  globalThis.localStorage = local;
  globalThis.sessionStorage = session;

  try {
    const service = new GoogleDriveService();
    service._persistToken('active-access-token', Date.now() + 60_000);
    setStoredRefreshToken('active-refresh-token');

    const revokeCalls = [];
    const okResult = await service.logout({
      fetchImpl: async (url, options) => {
        revokeCalls.push({ url, options });
        return { ok: true, status: 200 };
      },
    });

    assert.equal(okResult.signedOut, true);
    assert.equal(okResult.revoked, true);
    assert.equal(okResult.warning, '');
    assert.equal(service.accessToken, null);
    assert.equal(getStoredRefreshToken(), null);
    assert.equal(revokeCalls.some(c => c.url === 'https://oauth2.googleapis.com/revoke'), true);

    // Now simulate remote revocation failure: local state must still be cleared and user notified
    service._persistToken('second-access-token', Date.now() + 60_000);
    setStoredRefreshToken('second-refresh-token');
    const authErrors = [];
    const unsubscribe = service.subscribeAuthRequired(err => authErrors.push(err.message));

    const failResult = await service.logout({
      fetchImpl: async () => ({ ok: false, status: 503 }),
    });
    unsubscribe();

    assert.equal(failResult.signedOut, true);
    assert.equal(failResult.revoked, false);
    assert.match(failResult.warning, /revocation could not be completed/i);
    assert.equal(service.accessToken, null);
    assert.equal(getStoredRefreshToken(), null);
    assert.equal(authErrors.some(msg => /revocation could not be completed/i.test(msg)), true);

    // Direct revokeGoogleToken helper also clears storage even when fetch throws
    setStoredRefreshToken('third-refresh-token');
    const netFail = await revokeGoogleToken('third-refresh-token', {
      fetchImpl: async () => {
        throw new Error('network down');
      },
    });
    assert.equal(netFail.revoked, false);
    assert.equal(getStoredRefreshToken(), null);
  } finally {
    clearStoredRefreshToken();
    globalThis.localStorage = prevLocal;
    globalThis.sessionStorage = prevSession;
  }
});

test('Finding 3: Gemma service config never persists bearer token in localStorage, scrubs legacy tokens, and expires/rotates tokens', async () => {
  const prevWindow = globalThis.window;
  const storage = makeStorage();
  globalThis.window = { localStorage: storage };

  try {
    const saved = saveGemmaServiceConfig({
      baseUrl: 'https://embed.example.com',
      token: 'super-secret-bearer',
      ttlMs: 1000,
      now: 100,
    });
    assert.deepEqual(saved, { baseUrl: 'https://embed.example.com', token: 'super-secret-bearer' });

    // Raw localStorage value must NOT contain the secret token
    const rawPersisted = JSON.parse(storage.getItem(GEMMA_SERVICE_CONFIG_KEY));
    assert.deepEqual(rawPersisted, { baseUrl: 'https://embed.example.com' });
    assert.equal('token' in rawPersisted, false);

    // Active within TTL
    assert.deepEqual(getGemmaServiceConfig({ now: 500 }), {
      baseUrl: 'https://embed.example.com',
      token: 'super-secret-bearer',
    });

    // Rotation updates volatile token without writing it to localStorage
    rotateGemmaServiceToken('rotated-bearer', { ttlMs: 1000, now: 600 });
    assert.deepEqual(JSON.parse(storage.getItem(GEMMA_SERVICE_CONFIG_KEY)), {
      baseUrl: 'https://embed.example.com',
    });
    assert.deepEqual(getGemmaServiceConfig({ now: 900 }), {
      baseUrl: 'https://embed.example.com',
      token: 'rotated-bearer',
    });

    // Expired after TTL
    assert.deepEqual(getGemmaServiceConfig({ now: 2000 }), {
      baseUrl: 'https://embed.example.com',
      token: '',
    });

    // Legacy localStorage entry with token is scrubbed on read
    storage.setItem(GEMMA_SERVICE_CONFIG_KEY, JSON.stringify({
      baseUrl: 'https://embed.example.com',
      token: 'legacy-persisted-secret',
    }));
    const migrated = getGemmaServiceConfig({ now: 2100 });
    assert.equal(migrated.token, 'legacy-persisted-secret');
    assert.deepEqual(JSON.parse(storage.getItem(GEMMA_SERVICE_CONFIG_KEY)), {
      baseUrl: 'https://embed.example.com',
    });

    assert.equal(clearGemmaServiceToken(), true);
    assert.deepEqual(getGemmaServiceConfig({ now: 2200 }), {
      baseUrl: 'https://embed.example.com',
      token: '',
    });

    // Insecure remote HTTP baseUrl is rejected before sending bearer token
    await assert.rejects(
      syncGemmaVectorsFromService({
        baseUrl: 'http://remote-insecure.example.com',
        token: 'secret',
        fetchImpl: async () => ({ ok: true, json: async () => ({ songs: [] }) }),
      }),
      /HTTPS/i,
    );
    await assert.rejects(
      queryTextVector({
        baseUrl: 'http://remote-insecure.example.com',
        token: 'secret',
        text: 'chill',
        fetchImpl: async () => ({ ok: true, json: async () => ({ vector: [] }) }),
      }),
      /HTTPS/i,
    );

    // Session exchange and revoke helpers work over HTTPS / loopback
    const sessionCalls = [];
    const sessionToken = await exchangeGemmaSessionToken({
      baseUrl: 'http://127.0.0.1:8765',
      token: 'admin-token',
      scope: 'read',
      ttlSeconds: 300,
      fetchImpl: async (url, options) => {
        sessionCalls.push({ url, options });
        return { ok: true, json: async () => ({ token: 'ses.x.y', scope: 'read', ttlSeconds: 300 }) };
      },
    });
    assert.equal(sessionToken.token, 'ses.x.y');
    const revoked = await revokeGemmaSessionToken({
      baseUrl: 'http://127.0.0.1:8765',
      token: 'ses.x.y',
      fetchImpl: async (url, options) => {
        sessionCalls.push({ url, options });
        return { ok: true, json: async () => ({ revoked: true }) };
      },
    });
    assert.equal(revoked.revoked, true);
    assert.equal(sessionCalls.length, 2);
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  }
});

test('Finding 5 & dependencies: VM setup script, systemd unit, and requirements.txt enforce strict permissions and pinned versions', () => {
  const setupSh = fs.readFileSync(path.join(ROOT_DIR, 'embedding-service/deploy/setup_vm.sh'), 'utf8');
  assert.match(setupSh, /install -d -m 0700 -o sisic-embed -g sisic-embed \/var\/lib\/sisic-embed \/var\/lib\/sisic-embed\/spool/);
  assert.match(setupSh, /chmod 0700 \/var\/lib\/sisic-embed \/var\/lib\/sisic-embed\/spool/);
  assert.match(setupSh, /-exec chmod 0600 \{\} \+/);

  const serviceUnit = fs.readFileSync(path.join(ROOT_DIR, 'embedding-service/deploy/sisic-embed.service'), 'utf8');
  assert.match(serviceUnit, /^UMask=0077$/m);

  const requirements = fs.readFileSync(path.join(ROOT_DIR, 'embedding-service/requirements.txt'), 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
  assert.ok(requirements.length >= 9);
  for (const req of requirements) {
    assert.match(req, /^[A-Za-z0-9_.-]+==[0-9][A-Za-z0-9_.-]*$/, `Expected pinned requirement, got: ${req}`);
  }
});

test('Findings 3, 4, 5: embedding-service enforces scoped sessions, body/PCM/text/queue/spool/rate limits, and 0600 DB permissions', () => {
  const venvPython = '/Users/sidslaptop/dev/gemini embedding 2/.venv/bin/python';
  const pythonBin = fs.existsSync(venvPython) ? venvPython : 'python3';

  const pyScript = `
import base64
import os
import stat
import sys
import tempfile
from pathlib import Path
import numpy as np
from fastapi.testclient import TestClient

sys.path.insert(0, ${JSON.stringify(path.join(ROOT_DIR, 'embedding-service'))})
os.environ["SISIC_EMBED_TOKEN"] = "primary-secret"
from app import create_app
from sisic_embed import jobqueue, store

class StubEmbedder:
    def embed_clips(self, clips, batch_size=4):
        return np.ones((len(clips), 768), dtype=np.float32) / np.sqrt(768)
    def embed_text(self, text):
        return np.ones(768, dtype=np.float32) / np.sqrt(768)

with tempfile.TemporaryDirectory() as tmpdir:
    tmp = Path(tmpdir)
    db_file = tmp / "clips.sqlite"
    spool_dir = tmp / "spool"

    # Pre-create permissive DB file to verify store.connect tightens permissions to 0600
    db_file.write_bytes(b"")
    os.chmod(db_file, 0o644)
    con = store.connect(str(db_file))
    con.close()
    assert (db_file.stat().st_mode & 0o777) == 0o600, f"Expected 0600 on db, got {oct(db_file.stat().st_mode)}"

    os.environ["SISIC_EMBED_TOKEN"] = "primary-secret"
    os.environ["SISIC_EMBED_TOKENS"] = "rotated-secret"
    os.environ["SISIC_EMBED_READ_TOKEN"] = "readonly-secret"
    os.environ["SISIC_EMBED_MAX_QUEUED_JOBS"] = "2"
    os.environ["SISIC_EMBED_MAX_SPOOL_BYTES"] = "900000"
    os.environ["SISIC_EMBED_MAX_QUERY_CHARS"] = "50"
    os.environ["SISIC_EMBED_MAX_BODY_BYTES"] = "700000"
    os.environ["SISIC_EMBED_RATE_LIMIT_PER_MINUTE"] = "200"

    app = create_app(str(db_file), str(spool_dir), StubEmbedder())
    with TestClient(app) as client:
        assert (spool_dir.stat().st_mode & 0o777) == 0o700

        # 1. Rotated token and read-scoped token enforcement
        assert client.get("/jobs", headers={"Authorization": "Bearer rotated-secret"}).status_code == 200
        assert client.get("/jobs", headers={"Authorization": "Bearer readonly-secret"}).status_code == 200

        valid_pcm = base64.b64encode(np.zeros(80000, dtype="<f4").tobytes()).decode()
        clip_req = {
            "songKey": "artist::song",
            "fileHash": "h1",
            "offsetSeconds": 0,
            "sampleRate": 16000,
            "pcm": valid_pcm,
        }
        assert client.post("/clips", headers={"Authorization": "Bearer readonly-secret"}, json=clip_req).status_code == 403

        # 2. Short-lived scoped session token & revocation
        ses_res = client.post("/auth/session", headers={"Authorization": "Bearer primary-secret"}, json={"scope": "read", "ttlSeconds": 300})
        assert ses_res.status_code == 200
        ses_token = ses_res.json()["token"]
        assert client.get("/vectors", headers={"Authorization": f"Bearer {ses_token}"}).status_code == 200
        assert client.post("/clips", headers={"Authorization": f"Bearer {ses_token}"}, json=clip_req).status_code == 403
        assert client.post("/auth/revoke", headers={"Authorization": f"Bearer {ses_token}"}).status_code == 200
        assert client.get("/vectors", headers={"Authorization": f"Bearer {ses_token}"}).status_code == 401

        # 3. Oversized body rejected with 413 before JSON parsing
        huge_body = b'{"pcm":"' + (b"A" * 750000) + b'"}'
        res_413 = client.post("/clips", headers={"Authorization": "Bearer primary-secret", "Content-Type": "application/json"}, content=huge_body)
        assert res_413.status_code == 413

        # 4. Oversized text query rejected with 422
        res_long_q = client.post("/query", headers={"Authorization": "Bearer primary-secret"}, json={"text": "x" * 60})
        assert res_long_q.status_code == 422

        # 5. Queue capacity bound enforced directly on jobqueue.enqueue
        qcon = jobqueue.connect(str(tmp / "queue_limit.sqlite"))
        jobqueue.enqueue(qcon, "f1", "a::1", 0, "m", 0, "/tmp/1", max_queued=2)
        jobqueue.enqueue(qcon, "f2", "a::2", 0, "m", 0, "/tmp/2", max_queued=2)
        try:
            jobqueue.enqueue(qcon, "f3", "a::3", 0, "m", 0, "/tmp/3", max_queued=2)
            raise AssertionError("Expected QueueFullError")
        except jobqueue.QueueFullError:
            pass
        qcon.close()

        # 6. Per-client rate limit returns 429
        os.environ["SISIC_EMBED_RATE_LIMIT_PER_MINUTE"] = "3"
        statuses = [client.get("/jobs", headers={"Authorization": "Bearer primary-secret"}).status_code for _ in range(5)]
        assert 429 in statuses
`;

  const res = spawnSync(pythonBin, ['-c', pyScript], { encoding: 'utf8' });
  assert.equal(res.status, 0, `Python security test failed:\n${res.stderr || res.stdout}`);
});
