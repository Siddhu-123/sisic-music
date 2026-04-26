import { useCallback, useEffect, useRef, useState } from 'react';
import { driveService } from '../services/GoogleDriveService';
import { syncLibraryToDb, requestPersistentStorage, db } from '../db';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() || '';
export const SPOTIFY_JSON_FILE_ID = import.meta.env.VITE_SPOTIFY_JSON_FILE_ID?.trim() || '';
export const DRIVE_FOLDER_ID = import.meta.env.VITE_DRIVE_FOLDER_ID?.trim() || '';

const REQUIRED_CONFIG = {
  VITE_GOOGLE_CLIENT_ID: CLIENT_ID,
  VITE_SPOTIFY_JSON_FILE_ID: SPOTIFY_JSON_FILE_ID,
  VITE_DRIVE_FOLDER_ID: DRIVE_FOLDER_ID,
};

function getMissingConfig() {
  return Object.entries(REQUIRED_CONFIG)
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

function missingConfigMessage(missing = getMissingConfig()) {
  return missing.length > 0 ? `Missing required config: ${missing.join(', ')}.` : '';
}

export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState(() => driveService.isAuthenticated);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState('');
  const [error, setError] = useState(() => missingConfigMessage());
  const hasAutoSynced = useRef(false);

  const syncLibrary = useCallback(async () => {
    setError('');
    if (!SPOTIFY_JSON_FILE_ID) {
      setError('Missing required config: VITE_SPOTIFY_JSON_FILE_ID.');
      return;
    }

    setIsSyncing(true);
    setSyncStatus('Fetching library from Drive...');
    try {
      const data = await driveService.fetchSpotifyLibrary(SPOTIFY_JSON_FILE_ID);

      // Flatten: each playlist track gets tagged with its playlist name
      const allSongs = [];

      (data.saved_tracks || []).forEach(t => {
        allSongs.push({ ...t, playlistName: 'Liked Songs' });
      });

      (data.playlists || []).forEach(pl => {
        (pl.tracks || []).forEach(t => {
          allSongs.push({ ...t, playlistName: pl.playlist_name });
        });
      });

      const added = await syncLibraryToDb(allSongs);
      setSyncStatus(`Synced. ${added} new tracks added.`);

      // Save last sync timestamp
      await db.metadata.put({ key: 'lastSync', value: new Date().toISOString() });
    } catch (e) {
      console.error('Sync failed:', e);
      let message = e instanceof Error ? e.message : 'Sync failed.';
      if (message.includes('Spotify library file failed: Drive API 404')) {
        message = 'Spotify library file was not found for this Google account. Check VITE_SPOTIFY_JSON_FILE_ID, sign in with the Drive account that owns the file, or share spotify_data.json with that account.';
      }
      setError(message);
      setSyncStatus('Sync failed.');
    } finally {
      setIsSyncing(false);
    }
  }, []);

  // Init GIS once the script tag has loaded
  useEffect(() => {
    const missing = getMissingConfig();
    if (missing.length > 0) {
      return undefined;
    }

    const tryInit = () => {
      if (window.google?.accounts?.oauth2) {
        driveService.initTokenClient(CLIENT_ID);
        return true;
      }
      return false;
    };

    if (!tryInit()) {
      // Script might still be loading, poll for it
      const interval = setInterval(() => {
        if (tryInit()) clearInterval(interval);
      }, 300);
      return () => clearInterval(interval);
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated || hasAutoSynced.current) return;
    hasAutoSynced.current = true;
    syncLibrary();
  }, [isAuthenticated, syncLibrary]);

  const login = async () => {
    try {
      setError('');
      const missing = getMissingConfig();
      if (missing.length > 0) {
        setError(missingConfigMessage(missing));
        return;
      }
      if (!driveService.tokenClient) {
        setError('Google sign-in is not ready yet. Wait a moment and try again.');
        return;
      }
      await driveService.requestToken();
      setIsAuthenticated(true);
      // After login, request persistent storage and sync library
      await requestPersistentStorage();
      await syncLibrary();
    } catch (e) {
      console.error('Login failed:', e);
      setError(e instanceof Error ? e.message : 'Login failed.');
    }
  };

  return { isAuthenticated, isSyncing, syncStatus, error, login, syncLibrary };
}
