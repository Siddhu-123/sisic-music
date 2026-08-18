import { useState, useEffect, useRef, useCallback } from 'react';
import { driveService } from '../services/GoogleDriveService';
import { workerAuthMessageAction } from '../services/driveAuth';
import { syncLibraryToDb, requestPersistentStorage } from '../db';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() || '';
export const SPOTIFY_JSON_FILE_ID = import.meta.env.VITE_SPOTIFY_JSON_FILE_ID?.trim() || '';
export const DRIVE_FOLDER_ID = import.meta.env.VITE_DRIVE_FOLDER_ID?.trim() || '';
const RECONNECT_MESSAGE = 'Drive connection paused. Reconnect to continue syncing; offline music stays available.';
const DEV_UI_PREVIEW = import.meta.env.DEV && new URLSearchParams(window.location.search).has('ui-preview');

const REQUIRED_CONFIG = {
  VITE_GOOGLE_CLIENT_ID: CLIENT_ID,
  VITE_SPOTIFY_JSON_FILE_ID: SPOTIFY_JSON_FILE_ID,
  VITE_DRIVE_FOLDER_ID: DRIVE_FOLDER_ID,
};

let googleIdentityScriptPromise;

function loadGoogleIdentityServices() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (googleIdentityScriptPromise) return googleIdentityScriptPromise;
  googleIdentityScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-google-identity-services]');
    const script = existing || document.createElement('script');
    script.async = true;
    script.defer = true;
    script.src = 'https://accounts.google.com/gsi/client';
    script.dataset.googleIdentityServices = 'true';
    script.addEventListener('load', resolve, { once: true });
    script.addEventListener('error', () => reject(new Error('Google sign-in could not load. Check your connection and try again.')), { once: true });
    if (!existing) document.head.appendChild(script);
  });
  return googleIdentityScriptPromise;
}

function scheduleIdle(callback, timeout = 1400) {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(callback, { timeout });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(callback, Math.min(timeout, 800));
  return () => window.clearTimeout(id);
}

function getMissingConfig() {
  return Object.entries(REQUIRED_CONFIG)
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

export function getAuthSetupStatus() {
  const missing = getMissingConfig();
  return {
    missing,
    ready: missing.length === 0,
    hasClientId: Boolean(CLIENT_ID),
    hasDriveFolder: Boolean(DRIVE_FOLDER_ID),
    hasLibraryFile: Boolean(SPOTIFY_JSON_FILE_ID),
  };
}

function missingConfigMessage(missing = getMissingConfig()) {
  return missing.length > 0 ? `Missing required config: ${missing.join(', ')}.` : '';
}

export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState(() => driveService.isAuthenticated);
  const [hasAuthorizedSession, setHasAuthorizedSession] = useState(() => driveService.hasAuthorizedSession || DEV_UI_PREVIEW);
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState('');
  const [error, setError] = useState(() => missingConfigMessage()
    || ((driveService.hasAuthorizedSession || DEV_UI_PREVIEW) && !driveService.isAuthenticated ? RECONNECT_MESSAGE : ''));
  const hasSyncedOnMount = useRef(false);

  useEffect(() => {
    const missing = getMissingConfig();
    if (missing.length > 0) return undefined;

    if (!driveService.hasAuthorizedSession) return undefined;
    let cancelled = false;
    const init = async () => {
      try {
        await loadGoogleIdentityServices();
        if (cancelled) return;
        driveService.initTokenClient(CLIENT_ID);
        driveService.syncTokenToServiceWorker();
        if (driveService.hasAuthorizedSession && !driveService.isAuthenticated) {
          driveService.requestToken()
            .then(() => {
              if (cancelled) return;
              setIsAuthenticated(true);
              setHasAuthorizedSession(true);
              setError('');
            })
            .catch(() => {
              // Silent restore is best-effort. The reconnect action remains
              // available when Google requires user interaction.
            });
        }
      } catch (error) {
        if (!cancelled) setError(error instanceof Error ? error.message : 'Google sign-in could not load.');
      }
    };
    const cancel = scheduleIdle(init);
    return () => {
      cancelled = true;
      cancel();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = driveService.subscribeAuthRequired(() => {
      setIsAuthenticated(false);
      setHasAuthorizedSession(true);
      setError(RECONNECT_MESSAGE);
      setSyncStatus('');
    });

    const handleServiceWorkerMessage = event => {
      const action = workerAuthMessageAction(event.data, {
        isAuthenticated: driveService.isAuthenticated,
        tokenVersion: driveService.tokenVersion,
      });
      if (action === 'sync-token') {
        driveService.syncTokenToServiceWorker(event.source);
      } else if (action === 'reauthorize') {
        driveService.requireAuthentication(new Error(event.data.message || 'Google Drive authorization ended.'));
      }
    };
    const handleStoredToken = () => {
      if (!driveService.adoptStoredToken()) return;
      setIsAuthenticated(true);
      setHasAuthorizedSession(true);
      setError('');
    };
    navigator.serviceWorker?.addEventListener('message', handleServiceWorkerMessage);
    window.addEventListener('storage', handleStoredToken);

    return () => {
      unsubscribe();
      navigator.serviceWorker?.removeEventListener('message', handleServiceWorkerMessage);
      window.removeEventListener('storage', handleStoredToken);
    };
  }, []);

  useEffect(() => {
    if (!isAuthenticated || !driveService.tokenExpiry) return undefined;

    const delay = Math.max(0, driveService.tokenExpiry - Date.now() + 250);
    const timer = window.setTimeout(() => {
      if (!driveService.isAuthenticated) {
        driveService.requireAuthentication(new Error('Google Drive authorization ended.'));
      }
    }, delay);
    return () => window.clearTimeout(timer);
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
    setIsAuthorizing(true);
    try {
      setError('');
      const missing = getMissingConfig();
      if (missing.length > 0) {
        setError(missingConfigMessage(missing));
        return;
      }
      if (!driveService.tokenClient) {
        await loadGoogleIdentityServices();
        driveService.initTokenClient(CLIENT_ID);
      }
      await driveService.requestToken();
      setIsAuthenticated(true);
      setHasAuthorizedSession(true);
      setError('');
      await requestPersistentStorage();
      await syncLibrary();
    } catch (e) {
      console.error('Login failed:', e);
      setError(e instanceof Error ? e.message : 'Login failed.');
    } finally {
      setIsAuthorizing(false);
    }
  }, [syncLibrary]);

  useEffect(() => {
    if (isAuthenticated && !hasSyncedOnMount.current && !isSyncing) {
      hasSyncedOnMount.current = true;
      const cancel = scheduleIdle(() => syncLibrary(), 1800);
      return cancel;
    }
    return undefined;
  }, [isAuthenticated, isSyncing, syncLibrary]);

  return { isAuthenticated, hasAuthorizedSession, isAuthorizing, isSyncing, syncStatus, error, login, syncLibrary, setupStatus: getAuthSetupStatus() };
}
