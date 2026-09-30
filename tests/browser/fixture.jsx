// Local browser regression fixture. Vite's production entry does not include this file.
import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { driveService } from '../../src/services/GoogleDriveService.js';
import { db, upsertSongToDb, getPlaylistSnapshotForDrive } from '../../src/db.js';
import '../../src/index.css';

if (!import.meta.env.DEV) throw new Error('The fixture only runs in the development server.');
(() => {
  try {
    const saved = localStorage.getItem('sisic_theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = saved || (prefersDark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#12141a' : '#e7e8ec');
  } catch (e) {
    console.warn('Initial theme application failed:', e);
  }
})();
// Keep this fixture entirely local, even when the checkout has production configuration.
const localFetch = window.fetch.bind(window);
window.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (url.origin !== location.origin && url.protocol !== 'blob:' && url.protocol !== 'data:') return Promise.resolve(new Response('{}', { status: 503 }));
  return localFetch(input, options);
};
const nativeAudio = window.Audio;
window.__fixtureAudio = [];
window.__mediaActions = {};
if (navigator.mediaSession) {
  const setActionHandler = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
  navigator.mediaSession.setActionHandler = (name, handler) => { window.__mediaActions[name] = handler; setActionHandler(name, handler); };
}
window.Audio = function (...args) { const audio = new nativeAudio(...args); window.__fixtureAudio.push(audio); return audio; };

function tone(frequency) {
  const rate = 8000, length = rate * 24;
  const buffer = new ArrayBuffer(44 + length * 2), view = new DataView(buffer);
  const text = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++) view.setInt16(44 + i * 2, Math.sin(i / rate * frequency * Math.PI * 2) * 900, true);
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}
const titles = ['Amber Coast', 'Blue Hour', 'Cedar Light', 'Driftwood', 'Evening Tide', 'Far From Home', 'Golden Lines', 'Harbour'];
const songs = titles.map((track, i) => ({ songKey: `fixture-${i}`, track, artist: i % 2 ? 'North Atlantic' : 'Low Sun', album: 'Quiet Hours',
  driveFileId: `fixture-audio-${i}`, durationSeconds: 24, size: 384044,
  coverArtUrl: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="hsl(${25+i*32},35%,45%)"/><circle cx="200" cy="200" r="140" fill="none" stroke="#eee4d9" stroke-width="3"/><text x="200" y="210" text-anchor="middle" fill="#eee4d9" font-family="sans-serif" font-size="25">${track}</text></svg>`)}`,
}));
const urls = new Map(songs.map((song, i) => [song.driveFileId, tone(180 + i * 35)]));
window.addEventListener('pagehide', () => urls.forEach(url => URL.revokeObjectURL(url)));
for (const song of songs) await upsertSongToDb(song, 'Quiet Hours');
Object.assign(driveService, {
  accessToken: 'local-fixture-token', tokenExpiry: Date.now() + 3600000, tokenVersion: 'local-fixture', hasAuthorizedSession: true,
  tokenClient: {},
  getAudioStreamUrl: fileId => urls.get(fileId),
  getAudioFileMetadata: async fileId => ({ id: fileId, mimeType: 'audio/wav', size: 384044 }),
  loadDriveIndexes: async () => ({ songs, playlists: await getPlaylistSnapshotForDrive(), jobs: [], deleted: [], duplicates: [], playbackEvents: [] }),
  requestSongDownload: async () => ({ queued: false, alreadyQueued: true }),
  findSongFile: async song => ({ id: song.driveFileId || songs.find(item => item.songKey === song.songKey)?.driveFileId, mimeType: 'audio/wav' }),
  listDownloadJobs: async () => [], readSongIndex: async () => ({ songs }),
  writePlaylistIndex: async () => {}, appendPlaybackLog: async () => {},
  fetchSpotifyLibrary: async () => ({ playlists: [{ playlist_name: 'Quiet Hours', tracks: songs }] }),
});
window.google = { accounts: { oauth2: { initTokenClient: () => ({}) } } };
window.__fixture = { db, songs };
const { default: App } = await import('../../src/App.jsx');
createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
