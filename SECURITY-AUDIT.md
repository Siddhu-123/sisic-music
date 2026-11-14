# Security audit

Date: 2026-11-09

## High — Long-lived Google refresh token is accessible to browser scripts

**Location:** `src/services/cloudflareAuth.js:19`, `src/services/cloudflareAuth.js:27`, `src/services/cloudflareAuth.js:64`, `src/services/GoogleDriveService.js:22`.

**Impact and scenario:** When the auth worker is configured, the app stores the Google refresh token in persistent `localStorage`. A malicious script running on the app's origin, a compromised same-origin dependency, or someone with access to the browser profile can copy it and obtain fresh access tokens after the tab closes. The requested scope grants full Google Drive access, so an attacker could read, change, or delete Drive files. This requires access to the browser origin or profile; the audit did not establish an XSS entry point.

**Fix:** Keep refresh tokens server-side, encrypted and bound to a user session, and use an HttpOnly, Secure, SameSite session cookie with CSRF protection. If a server-side session is not available, avoid persistent refresh tokens in browser storage and require reauthentication. Minimize the Drive scope where the shared-file workflow permits it. Revoke exposed tokens.

## Medium — Signing out does not revoke the Google grant

**Location:** `src/services/GoogleDriveService.js:477`, `src/services/cloudflareAuth.js:41`.

**Impact and scenario:** Sign-out deletes the local refresh token and clears the app's access token but does not revoke the Google token or grant. If an attacker copied a refresh token before sign-out, signing out does not invalidate the attacker's copy; they can continue renewing access until Google revokes or expires it.

**Fix:** Revoke the Google grant or refresh token on explicit sign-out, including server-side copies if the auth design changes. Clear local state even if revocation fails, and tell the user if remote revocation could not be completed.

## Medium — Service bearer token persists in browser storage

**Location:** `src/services/gemmaServiceConfig.js:18`, `src/services/gemmaVectors.js:134`, `embedding-service/app.py:89`.

**Impact and scenario:** The embedding service's bearer token is saved in `localStorage` and has the same authority for all protected endpoints. A malicious same-origin script or a person with access to the browser profile can recover it and, if the service is reachable and any Cloudflare Access gate is also passed, read vectors, submit jobs, or consume model resources. The token remains until explicitly cleared.

**Fix:** Use a short-lived, scoped session or a server-side token broker rather than persisting the bearer token in browser storage. Provide rotation and revocation, and enforce a separate access gate for remote deployments.

## Medium — Embedding API allows resource exhaustion

**Location:** `embedding-service/app.py:100`, `embedding-service/app.py:106`, `embedding-service/app.py:134`, `embedding-service/app.py:191`, `embedding-service/sisic_embed/jobqueue.py:37`.

**Impact and scenario:** The API parses an unrestricted JSON body and base64-decodes the audio before checking its duration. It also accepts an unbounded number of unique queued clips and unrestricted text queries. A bearer-token holder can send an oversized request to exhaust memory, or enqueue clips faster than the single worker processes them to fill the disk and deny service. The documented loopback binding and optional external access gate limit who can reach it.

**Fix:** Enforce request-body limits before JSON parsing at the proxy or ASGI layer, cap encoded PCM and text lengths before decoding or inference, bound queued jobs and spool bytes, and apply per-client rate and concurrency limits. Return a controlled error when limits are reached.

## Medium — VM database can be readable by other local users

**Location:** `embedding-service/deploy/setup_vm.sh:35`, `embedding-service/deploy/setup_vm.sh:47`, `embedding-service/deploy/sisic-embed.service:5`, `embedding-service/sisic_embed/store.py:50`.

**Impact and scenario:** The setup creates the data directories without restrictive modes, and the service sets no restrictive umask before SQLite creates the database and WAL files. With typical `0755` directories and a `0022` service umask, other local users can read song metadata and embeddings from the database without the API bearer token. Actual exposure depends on VM permissions and systemd defaults; the deployed VM was not inspected.

**Fix:** Create the data and spool directories with mode `0700`, set `UMask=0077` in the service, and ensure existing database, WAL, and shared-memory files are owner-only. Verify permissions on the deployed VM.

## Coverage and limits

Reviewed the web authentication and token storage, service worker, outbound requests, embedding API, SQLite operations, subprocess usage, deployment setup, dependency manifests, and common browser injection and secret patterns. Filename history and current source were checked for common secret indicators without opening credential files or printing values. No confirmed committed secret, shell or SQL injection, path traversal, unsafe deserialization, or XSS entry point was identified in the reviewed paths. Git history contents, deployed services, third-party auth worker, and actual credential files were not inspected.

Dependency review was limited: Python requirements are unpinned (`embedding-service/requirements.txt:1`), so installed versions and known advisories cannot be established from the manifest. No comprehensive dependency vulnerability scan was run. The locked Vite version is 8.3.3 (`package-lock.json:2930`), which is listed as patched for [GHSA-rq7h-c2jc-7f22](https://github.com/vitejs/vite/security/advisories/GHSA-rq7h-c2jc-7f22). Generate a locked Python dependency set and run current npm and Python advisory scans in the deployment environment.

## Resolution

- **High — Long-lived Google refresh token is accessible to browser scripts:** Fixed in client code; manual action needed for server-side Worker session storage, OAuth client scope consolidation, and revoking previously exposed tokens.
  - **Fixed in code:** Stopped persisting refresh tokens in `localStorage` during OAuth code exchange and silent refresh (`src/services/cloudflareAuth.js:10-20`, `src/services/cloudflareAuth.js:86-147`), restricted browser token helpers to volatile memory and tab-scoped `sessionStorage` while actively purging `sisic_refresh_token` from `localStorage` (`src/services/cloudflareAuth.js:33-80`), purged any legacy `sisic_refresh_token` from `localStorage` on `GoogleDriveService` initialization and migration (`src/services/GoogleDriveService.js:305`, `src/services/GoogleDriveService.js:409`), enabled `credentials: 'include'` and `Cache-Control: no-store` on worker requests (`src/services/cloudflareAuth.js:90-98`, `src/services/cloudflareAuth.js:122-130`), and allowed overriding the Drive OAuth scope via `VITE_GOOGLE_DRIVE_SCOPE` (`src/services/GoogleDriveService.js:27-30`). Covered by tests in `tests/security.test.js:44-132`.
  - **Manual action needed:** Storing refresh tokens exclusively server-side in encrypted Worker storage bound to an `HttpOnly; Secure; SameSite` cookie requires provisioning stateful Cloudflare storage (KV, D1, or Durable Objects) in the external auth worker deployment. Narrowing the default Drive scope from `https://www.googleapis.com/auth/drive` to `drive.file` requires consolidating the desktop worker and browser app onto the same Google Cloud OAuth client so both share per-file authorization. Any previously exposed refresh tokens must be revoked in Google Cloud Console or the user's Google Account security settings.
- **Medium — Signing out does not revoke the Google grant:** Fixed in code (`src/services/cloudflareAuth.js:153-208`, `src/services/GoogleDriveService.js:483-507`; tested in `tests/security.test.js:134-198`).
  - **Fixed in code:** Added `revokeGoogleToken()` (`src/services/cloudflareAuth.js:153-208`) to revoke tokens via both the configured auth worker (`/auth/revoke`) and Google's OAuth2 revocation endpoint (`https://oauth2.googleapis.com/revoke`), and updated `GoogleDriveService.logout()` (`src/services/GoogleDriveService.js:483-507`) to immediately clear all local token/session state before attempting remote revocation, fall back to access-token revocation if refresh-token revocation fails, and notify `authRequiredListeners` with a user-visible warning when remote revocation cannot be completed.
- **Medium — Service bearer token persists in browser storage:** Fixed in code; manual action needed for external access gate configuration on remote deployments.
  - **Fixed in code:** Updated `saveGemmaServiceConfig()`, `getGemmaServiceConfig()`, `clearGemmaServiceToken()`, and `rotateGemmaServiceToken()` (`src/services/gemmaServiceConfig.js:4-93`) so `localStorage` stores only `{ baseUrl }`, keeps the bearer token in volatile session memory with a bounded TTL (`DEFAULT_GEMMA_TOKEN_TTL_MS`), and automatically scrubs any legacy persisted `token` field from `localStorage`. Added HTTPS/loopback URL enforcement and session-token exchange/revocation helpers in `src/services/gemmaVectors.js:124-160`, and added short-lived scoped session tokens (`POST /auth/session`), token revocation (`POST /auth/revoke`), read-only scoped token support (`SISIC_EMBED_READ_TOKEN`), and multi-token rotation (`SISIC_EMBED_TOKENS`) in `embedding-service/app.py:53-112`, `embedding-service/app.py:174-200`, and `embedding-service/app.py:255-272`. Covered by tests in `tests/security.test.js:200-303` and `tests/security.test.js:322-406`.
  - **Manual action needed:** Enforcing an external authentication gate (such as Cloudflare Access or mTLS) in front of any non-loopback deployment and rotating production `SISIC_EMBED_TOKEN` values in `/etc/sisic-embed.env` must be configured in the deployment environment.
- **Medium — Embedding API allows resource exhaustion:** Fixed in code (`embedding-service/app.py:24-30`, `embedding-service/app.py:202-253`, `embedding-service/app.py:274-349`, `embedding-service/app.py:389-401`, `embedding-service/sisic_embed/jobqueue.py:37-75`; tested in `tests/security.test.js:322-422`).
  - **Fixed in code:** Enforced ASGI middleware request-body byte limits before JSON parsing (`SISIC_EMBED_MAX_BODY_BYTES` for `/clips` and `SISIC_EMBED_MAX_QUERY_BODY_BYTES` for other POST routes, returning HTTP `413` at `embedding-service/app.py:227-245`), capped encoded `pcm`/`pcm16` base64 lengths and metadata lengths before decoding (`embedding-service/app.py:24-28`, `embedding-service/app.py:280-311`), capped text query length before model inference (`SISIC_EMBED_MAX_QUERY_CHARS` at `embedding-service/app.py:390-396`), bounded queued jobs and spool directory bytes (`embedding-service/sisic_embed/jobqueue.py:37-61`, `embedding-service/app.py:319-346`), and added per-client sliding-window rate and concurrency limits returning HTTP `429` with `Retry-After` (`embedding-service/app.py:202-225`).
- **Medium — VM database can be readable by other local users:** Fixed in code; manual action needed to verify and remediate existing files on already-provisioned VMs.
  - **Fixed in code:** Updated `embedding-service/deploy/setup_vm.sh:35-45` to create `/var/lib/sisic-embed`, `/var/lib/sisic-embed/spool`, and `/var/lib/sisic-embed/hf` with mode `0700` (`0750` on `/opt/sisic-embed`) and `chmod 0600` any existing SQLite/spool files; added `UMask=0077` to `embedding-service/deploy/sisic-embed.service:9`; and updated `embedding-service/sisic_embed/store.py:53-83` and `embedding-service/app.py:114-117`, `embedding-service/app.py:151-156`, `embedding-service/app.py:323-326` to apply `0077` umask and enforce `0700` directory / `0600` file modes on SQLite `.sqlite`, `-wal`, `-shm`, and spooled `.f32` files. Covered by tests in `tests/security.test.js:305-355`.
  - **Manual action needed:** On any VM that was provisioned prior to this change, an administrator must run `chmod 0700 /var/lib/sisic-embed /var/lib/sisic-embed/spool` and `chmod 0600 /var/lib/sisic-embed/clips.sqlite*`, reload the systemd unit (`systemctl daemon-reload && systemctl restart sisic-embed`), and verify permissions on the host.
- **Coverage and limits — Unpinned Python requirements:** Fixed in code; manual action needed for ongoing deployment vulnerability scanning.
  - **Fixed in code:** Pinned all Python dependencies in `embedding-service/requirements.txt:1-9` to exact versions (`==`), covered by `tests/security.test.js:313-320`.
  - **Manual action needed:** Run `npm audit` and `pip-audit` against the deployment environment on a recurring schedule when updating dependencies.
