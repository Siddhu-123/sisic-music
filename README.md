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
- Imported files are identified by SHA-256, saved offline in IndexedDB, and skipped when the same file is imported again.
- Import metadata, embedding, and metadata-only cloud sync jobs are persisted locally so offline work can retry later.
- Queue state, current position, repeat mode, and the paused/playing restore state are persisted in browser storage.
- The embedding provider is intentionally injected through `setEmbeddingProvider`; the app does not invent or upload embeddings without a configured provider.
