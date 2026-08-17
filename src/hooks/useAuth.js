import { useState, useEffect, useRef, useCallback } from 'react';
import { driveService } from '../services/GoogleDriveService';
import { syncLibraryToDb, requestPersistentStorage } from '../db';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() || '';
export const SPOTIFY_JSON_FILE_ID = import.meta.env.VITE_SPOTIFY_JSON_FILE_ID?.trim() || '';
export const DRIVE_FOLDER_ID = import.meta.env.VITE_DRIVE_FOLDER_ID?.trim() || '';
const TOKEN_REFRESH_LEAD_MS = 5 * 60 * 1000;

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
  const hasSyncedOnMount = useRef(false);

  useEffect(() => {
    const missing = getMissingConfig();
    if (missing.length > 0) return undefined;

    const tryInit = () => {
      if (window.google?.accounts?.oauth2) {
        driveService.initTokenClient(CLIENT_ID);
        return true;
      }
      return false;
    };

    if (!tryInit()) {
      const interval = setInterval(() => {
        if (tryInit()) clearInterval(interval);
      }, 300);
      return () => clearInterval(interval);
    }
    return undefined;
  }, []);

  useEffect(() => {
    const unsubscribe = driveService.subscribeAuthRequired(() => {
      setIsAuthenticated(false);
      setError('Google Drive access expired. Sign in again to continue.');
      setSyncStatus('');
    });

    const handleServiceWorkerMessage = event => {
      if (event.data?.type !== 'SISIC_DRIVE_AUTH_ERROR') return;
      driveService.requireAuthentication(new Error(event.data.message || 'Google Drive access expired.'));
    };
    navigator.serviceWorker?.addEventListener('message', handleServiceWorkerMessage);

    return () => {
      unsubscribe();
      navigator.serviceWorker?.removeEventListener('message', handleServiceWorkerMessage);
    };
  }, []);

  useEffect(() => {
    if (!isAuthenticated || !driveService.tokenExpiry) return undefined;

    let cancelled = false;
    let timer = null;
    const scheduleExpiryCheck = () => {
      if (cancelled) return;
      const delay = Math.max(0, (driveService.tokenExpiry || Date.now()) - Date.now() + 250);
      timer = window.setTimeout(() => {
        if (!driveService.isAuthenticated) {
          driveService.requireAuthentication(new Error('Google Drive access expired.'));
        }
      }, delay);
    };
    const refreshBeforeExpiry = async () => {
      if (cancelled) return;
      if (!driveService.isAuthenticated) {
        driveService.requireAuthentication(new Error('Google Drive access expired.'));
        return;
      }
      try {
        await driveService.refreshAccessToken({ notifyOnFailure: false });
        if (!cancelled) scheduleRefresh();
      } catch {
        // Keep the current token until its real expiry if Google needs interaction.
        if (!cancelled) scheduleExpiryCheck();
      }
    };
    const scheduleRefresh = () => {
      if (cancelled) return;
      const delay = Math.max(1000, (driveService.tokenExpiry || Date.now()) - Date.now() - TOKEN_REFRESH_LEAD_MS);
      timer = window.setTimeout(refreshBeforeExpiry, delay);
    };

    scheduleRefresh();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [isAuthenticated]);

  const syncLibrary = useCallback(async () => {
    setError('');
    if (!SPOTIFY_JSON_FILE_ID) {
      setError('Missing required config: VITE_SPOTIFY_JSON_FILE_ID.');
      return null;
    }

    setIsSyncing(true);
    setSyncStatus('Fetching library from Drive...');
    try {
      const data = await driveService.fetchSpotifyLibrary(SPOTIFY_JSON_FILE_ID);
      const allSongs = [];

      (data.saved_tracks || []).forEach(track => {
        allSongs.push({ ...track, playlistName: 'Liked Songs', source: 'spotify' });
      });

      (data.playlists || []).forEach(playlist => {
        (playlist.tracks || []).forEach(track => {
          allSongs.push({ ...track, playlistName: playlist.playlist_name, source: 'spotify' });
        });
      });

      (data.history_tracks || []).forEach(track => {
        allSongs.push({ ...track, playlistName: 'Listening History', source: 'spotify-history' });
      });

      const result = await syncLibraryToDb(allSongs);
      setSyncStatus(
        `Synced ${result.totalSongs} tracks across ${result.playlistLinks} playlist links (${result.added} new, ${result.updated} updated).`
      );
      return result;
    } catch (e) {
      console.error('Sync failed:', e);
      let message = e instanceof Error ? e.message : 'Sync failed.';
      if (message.includes('Spotify library file failed: Drive API 404')) {
        message = 'Spotify library file was not found for this Google account. Check VITE_SPOTIFY_JSON_FILE_ID, sign in with the Drive account that owns the file, or share spotify_data.json with that account.';
      }
      setError(message);
      setSyncStatus('Sync failed.');
      return null;
    } finally {
      setIsSyncing(false);
    }
  }, []);

  const login = useCallback(async () => {
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
      await requestPersistentStorage();
      await syncLibrary();
    } catch (e) {
      console.error('Login failed:', e);
      setError(e instanceof Error ? e.message : 'Login failed.');
    }
  }, [syncLibrary]);

  useEffect(() => {
    if (isAuthenticated && !hasSyncedOnMount.current && !isSyncing) {
      hasSyncedOnMount.current = true;
      syncLibrary();
    }
  }, [isAuthenticated, isSyncing, syncLibrary]);

  return { isAuthenticated, isSyncing, syncStatus, error, login, syncLibrary };
}
