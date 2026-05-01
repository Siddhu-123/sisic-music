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
- `sisic-playback-log.json`: recent playback errors, short endings, and skips.

The browser reads compact indexes first. The worker performs full Drive audio reconciliation and owns `sisic-songs.json` and `sisic-queue.json`.
