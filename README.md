# Sisic Music Web App

React/Vite static app for a Google Drive backed music locker.

## Commands

```bash
npm install
npm test
npm run lint
npm run build
npm run dev
```

## Required Environment

Create `web-app/.env` locally:

```bash
VITE_GOOGLE_CLIENT_ID="your OAuth web client id"
VITE_SPOTIFY_JSON_FILE_ID="Drive file id for spotify_data.json"
VITE_DRIVE_FOLDER_ID="Drive folder id for Sisic audio and JSON indexes"
```

Enable Drive API and create a Web OAuth client in Google Cloud before building. Add the deployed GitHub Pages origin as an authorized JavaScript origin. The static site automates Google sign-in, Drive authorization, library sync, range streaming, and Mac-worker source preparation, but Google Cloud project/OAuth registration and the three build variables remain a one-time manual setup.

## Drive Metadata Files

- `sisic-songs.json`: compact source of truth for ready Drive audio.
- `sisic-queue.json`: browser queue summary for worker job state.
- `sisic-deleted.json`: songs intentionally offloaded from Drive.
- `sisic-playlists.json`: app-owned playlist membership writeback.
- `sisic-playback-log.json`: playback starts, pauses, seeks, stops, completions, errors, and skips.
- `sisic-imports.json`: metadata-only manifest for local imported tracks when Drive sync is available.

The browser reads compact indexes first. The worker performs full Drive audio reconciliation and owns `sisic-songs.json` and `sisic-queue.json`.

## Local import and queue behavior

- Drop one or more supported audio files or folders onto the main view, or use the `Import music` control.
- Imported files are identified by SHA-256 and their metadata is saved in IndexedDB, so the same file can be skipped without retaining its audio bytes in browser storage.
- Authenticated imports upload the source to Drive for Mac-worker processing. Metadata and cloud sync jobs are persisted locally so failed metadata work can retry; if an import was not uploaded, select the source again after signing in. Embedding jobs are created only when a provider is configured.
- YouTube downloads are limited to 8 minutes by default. Known longer songs ask for confirmation before queueing; the Mac worker checks candidate durations before extraction and pauses over-limit requests for review.
- Queue state, current position, repeat mode, and the paused/playing restore state are persisted in browser storage.
- The embedding provider is intentionally injected through `setEmbeddingProvider`; the app does not invent or upload embeddings without a configured provider.
