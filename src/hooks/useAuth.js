import { useState, useEffect, useRef, useCallback } from 'react';
import { driveService } from '../services/GoogleDriveService';
import { workerAuthMessageAction } from '../services/driveAuth';
import { syncLibraryToDb, requestPersistentStorage } from '../db';
import {
  checkServerSession,
  getStoredRefreshToken,
  isAuthBackendAvailable,
  isSameOriginAuthAvailable,
  startTopLevelLogin,
} from '../services/cloudflareAuth';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() || '';
export const SPOTIFY_JSON_FILE_ID = import.meta.env.VITE_SPOTIFY_JSON_FILE_ID?.trim() || '';
export const DRIVE_FOLDER_ID = import.meta.env.VITE_DRIVE_FOLDER_ID?.trim() || '';
const RECONNECT_MESSAGE = 'Drive connection paused. Reconnect to continue syncing and streaming.';
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
    script.addEventListener('error', () => {
      googleIdentityScriptPromise = null;
      script.remove();
      reject(new Error('Google sign-in could not load. Check your connection and try again.'));
    }, { once: true });
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
    hasAuthWorker: isAuthBackendAvailable(),
    hasOptionHAuth: isSameOriginAuthAvailable(),
    hasStoredRefreshToken: Boolean(getStoredRefreshToken()),
  };
}

function missingConfigMessage(missing = getMissingConfig()) {
  return missing.length > 0 ? `Missing required config: ${missing.join(', ')}.` : '';
}

function readInitialAuthError() {
  try {
    const authErr = new URL(window.location.href).searchParams.get('auth_error');
    return authErr ? `Google sign-in returned: ${authErr.replace(/_/g, ' ')}` : '';
  } catch {
    return '';
  }
}

export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState(() => driveService.isAuthenticated);
  const [hasAuthorizedSession, setHasAuthorizedSession] = useState(() => driveService.hasAuthorizedSession || DEV_UI_PREVIEW || Boolean(getStoredRefreshToken()));
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState('');
  const [signedOutExplicitly, setSignedOutExplicitly] = useState(false);
  const [error, setError] = useState(() => readInitialAuthError()
    || missingConfigMessage()
    || ((driveService.hasAuthorizedSession || DEV_UI_PREVIEW || Boolean(getStoredRefreshToken())) && !driveService.isAuthenticated ? RECONNECT_MESSAGE : ''));
  const hasSyncedOnMount = useRef(false);

  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('auth_error')) {
        url.searchParams.delete('auth_error');
        window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
      }
    } catch {
      // Ignore malformed location URLs
    }

    const missing = getMissingConfig();
    if (missing.length > 0 && !isSameOriginAuthAvailable()) return undefined;

    const backendAvailable = isAuthBackendAvailable();
    const shouldAttemptSilentRestore = backendAvailable || driveService.hasAuthorizedSession || Boolean(getStoredRefreshToken());
    if (!shouldAttemptSilentRestore) return undefined;
    let cancelled = false;
    const init = async () => {
      try {
        if (backendAvailable && !driveService.isAuthenticated && navigator.onLine !== false) {
          let canRefresh = Boolean(driveService.hasAuthorizedSession || getStoredRefreshToken());
          if (isSameOriginAuthAvailable()) {
            const session = await checkServerSession();
            canRefresh = Boolean(session?.authenticatedSession);
          }
          if (canRefresh) {
            const refreshed = await driveService.refreshTokenSilently();
            if (refreshed && !cancelled) {
              setIsAuthenticated(true);
              setHasAuthorizedSession(true);
              setSignedOutExplicitly(false);
              setError('');
              driveService.syncTokenToServiceWorker();
              return;
            }
          }
        }

        if (!CLIENT_ID) return;
        await loadGoogleIdentityServices();
        if (cancelled) return;
        driveService.initTokenClient(CLIENT_ID);
        driveService.syncTokenToServiceWorker();
        if (driveService.hasAuthorizedSession && !driveService.isAuthenticated && navigator.onLine !== false) {
          driveService.requestToken({ prompt: '' })
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
        if (!cancelled && navigator.onLine !== false) {
          setError(error instanceof Error ? error.message : 'Google sign-in could not load.');
        }
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
    if (!isAuthBackendAvailable()) return undefined;

    const refreshIfStale = async () => {
      if (navigator.onLine === false) return;
      const expiringSoon = !driveService.isAuthenticated
        || (driveService.tokenExpiry && (driveService.tokenExpiry - Date.now() < 120_000));
      if (!expiringSoon) return;
      if (isSameOriginAuthAvailable()) {
        const session = await checkServerSession();
        if (!session?.authenticatedSession) return;
      } else if (!(driveService.hasAuthorizedSession || getStoredRefreshToken())) {
        return;
      }
      const refreshed = await driveService.refreshTokenSilently();
      if (refreshed) {
        setIsAuthenticated(true);
        setHasAuthorizedSession(true);
        setSignedOutExplicitly(false);
        setError('');
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') refreshIfStale().catch(() => {});
    };
    const handleOnline = () => { refreshIfStale().catch(() => {}); };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleOnline);
    window.addEventListener('online', handleOnline);

    let timer;
    if (isAuthenticated && driveService.tokenExpiry) {
      const timeUntilExpiry = driveService.tokenExpiry - Date.now();
      const delay = Math.max(0, timeUntilExpiry - 60_000 + 250);
      timer = window.setTimeout(async () => {
        const refreshed = await driveService.refreshTokenSilently();
        if (refreshed) {
          setIsAuthenticated(true);
          setError('');
          return;
        }
        if (!driveService.isAuthenticated && navigator.onLine !== false) {
          driveService.requireAuthentication(new Error('Google Drive authorization ended.'));
        }
      }, delay);
    }

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleOnline);
      window.removeEventListener('online', handleOnline);
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
    setSignedOutExplicitly(false);
    setIsAuthorizing(true);
    try {
      setError('');
      if (isSameOriginAuthAvailable()) {
        const currentPath = `${window.location.pathname || '/'}${window.location.search || ''}`;
        startTopLevelLogin({
          prompt: driveService.hasAuthorizedSession ? 'select_account' : 'consent',
          returnTo: currentPath,
        });
        return;
      }

      const missing = getMissingConfig();
      if (missing.length > 0) {
        setError(missingConfigMessage(missing));
        return;
      }
      if (!driveService.tokenClient) {
        await loadGoogleIdentityServices();
        driveService.initTokenClient(CLIENT_ID);
      }
      // A user-initiated reconnect may need an account picker or consent;
      // silent mode is reserved for the automatic refresh restore above.
      await driveService.requestToken({ prompt: driveService.hasAuthorizedSession ? 'select_account' : 'consent' });
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

  const logout = useCallback(async () => {
    setIsAuthorizing(true);
    try {
      const res = await driveService.logout();
      setIsAuthenticated(false);
      setHasAuthorizedSession(false);
      setSignedOutExplicitly(true);
      setSyncStatus('');
      setError(res?.warning || '');
    } finally {
      setIsAuthorizing(false);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated && !hasSyncedOnMount.current && !isSyncing) {
      const cancel = scheduleIdle(() => { hasSyncedOnMount.current = true; syncLibrary(); }, 1800);
      return cancel;
    }
    return undefined;
  }, [isAuthenticated, isSyncing, syncLibrary]);

  return { isAuthenticated, hasAuthorizedSession, signedOutExplicitly, isAuthorizing, isSyncing, syncStatus, error, login, logout, syncLibrary, setupStatus: getAuthSetupStatus() };
}
