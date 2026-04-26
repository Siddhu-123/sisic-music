import React, { useState, useEffect, useCallback } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Home, Search, Library, Music2 } from 'lucide-react';
import { db, resetLocalDatabase } from './db';
import { driveService } from './services/GoogleDriveService';
import { useAudioPlayer } from './hooks/useAudioPlayer';
import { useAuth, DRIVE_FOLDER_ID } from './hooks/useAuth';
import {
  PlayerBar,
  SongCard,
  LoginScreen,
  SyncBanner,
} from './components/Components';
import { QueuePanel } from './components/QueuePanel';
import { ToastContainer } from './components/Toast';
import { useToast } from './hooks/useToast';
import './App.css';

const VIEWS = { HOME: 'home', SEARCH: 'search', LIBRARY: 'library' };
const EMPTY_LIBRARY = { songs: [], playlists: [], error: '' };

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown browser storage error.');
}

function App() {
  const { isAuthenticated, isSyncing, syncStatus, error: authError, login, syncLibrary } = useAuth();
  const player = useAudioPlayer();
  const { toasts, addToast } = useToast();

  const [view, setView] = useState(VIEWS.HOME);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPlaylist, setSelectedPlaylist] = useState(null);
  const [downloadingIds, setDownloadingIds] = useState(new Set());
  const [actionError, setActionError] = useState('');
  const [showQueue, setShowQueue] = useState(false);

  // Live data from IndexedDB. Read plainly and sort in JS so mobile browsers
  // with fragile cursor/index support do not crash the whole app.
  const libraryData = useLiveQuery(async () => {
    try {
      const songs = await db.songs.toArray();
      songs.sort((a, b) => (a.track || '').localeCompare(b.track || ''));
      const playlists = Array.from(new Set(
        songs.map(song => song.playlistName).filter(Boolean)
      )).sort((a, b) => a.localeCompare(b));
      return { songs, playlists, error: '' };
    } catch (error) {
      console.error('Local music cache failed:', error);
      return {
        ...EMPTY_LIBRARY,
        error: `Local music cache is unavailable: ${errorMessage(error)}`,
      };
    }
  }, [], EMPTY_LIBRARY);

  const safeLibraryData = libraryData || EMPTY_LIBRARY;
  const allSongs = safeLibraryData.songs;
  const playlists = safeLibraryData.playlists;
  const localDbError = safeLibraryData.error;

  // Songs to show in current view
  const visibleSongs = React.useMemo(() => {
    if (!allSongs) return [];
    let base = selectedPlaylist
      ? allSongs.filter(s => s.playlistName === selectedPlaylist)
      : allSongs;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      base = base.filter(
        s => s.track.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q)
      );
    }
    return base;
  }, [allSongs, selectedPlaylist, searchQuery]);

  // Wire queue/index changes in useAudioPlayer to actually play a song.
  // If the song doesn't have a driveFileId yet, look it up on Drive first.
  useEffect(() => {
    if (player.queue.length === 0) return;
    const song = player.queue[player.queueIndex];
    if (!song) return;

    const playSong = async () => {
      let resolved = song;
      // If no driveFileId, try to find it on Drive
      if (!song.driveFileId && !song.isDownloaded && DRIVE_FOLDER_ID) {
        try {
          const found = await driveService.findSongFile(song.track, DRIVE_FOLDER_ID);
          if (found) {
            await db.songs.update(song.id, { driveFileId: found.id });
            resolved = { ...song, driveFileId: found.id };
          }
        } catch (e) {
          console.error('Drive lookup for queued song failed:', e);
        }
      }
      player.loadAndPlay(resolved, driveService.accessToken);
    };

    playSong();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.queueIndex, player.queue]);

  /**
   * Seamless play flow:
   * 1. If song has driveFileId or blob → stream immediately
   * 2. If not → check Drive for the file, update DB, then stream
   * 3. If truly not on Drive → queue for download + toast
   */
  const handlePlaySong = useCallback(async (song) => {
    const idx = visibleSongs.findIndex(s => s.id === song.id);
    const startIdx = idx >= 0 ? idx : 0;

    // Already has a Drive file ID or local blob → play immediately
    if (song.driveFileId || song.isDownloaded) {
      player.setQueueAndPlay(visibleSongs, startIdx);
      return;
    }

    // No driveFileId stored — search Drive for the file first
    if (DRIVE_FOLDER_ID) {
      try {
        const found = await driveService.findSongFile(song.track, DRIVE_FOLDER_ID);
        if (found) {
          // Found on Drive! Update the DB so future plays are instant
          await db.songs.update(song.id, { driveFileId: found.id });
          // Use a copy with the resolved ID (don't mutate Dexie objects)
          const updated = visibleSongs.map(s =>
            s.id === song.id ? { ...s, driveFileId: found.id } : s
          );
          player.setQueueAndPlay(updated, startIdx);
          return;
        }
      } catch (e) {
        console.error('Drive lookup failed:', e);
      }

      // Not on Drive → queue for Mac worker download (await, don't fire-and-forget)
      try {
        await driveService.requestSongDownload(song, DRIVE_FOLDER_ID);
        addToast(`Queued "${song.track}" for download`);
      } catch (e) {
        addToast(`Failed to queue "${song.track}": ${e.message || 'Drive write error'}`);
      }
    }

    // Try to find next playable song in the list
    const playable = visibleSongs.filter(s => s.driveFileId || s.isDownloaded);
    if (playable.length > 0) {
      player.setQueueAndPlay(playable, 0);
    }
  }, [visibleSongs, player, addToast]);

  /**
   * Seamless download flow:
   * 1. Check if already on Drive → cache locally
   * 2. Not on Drive → queue for Mac worker + toast (no alert!)
   */
  const handleDownload = useCallback(async (song) => {
    if (song.isDownloaded || downloadingIds.has(song.id)) return;
    if (!DRIVE_FOLDER_ID) {
      setActionError('Missing required config: VITE_DRIVE_FOLDER_ID.');
      return;
    }

    setActionError('');
    setDownloadingIds(prev => new Set(prev).add(song.id));
    try {
      // 1. Check if the MP3 is already on Drive
      let fileId = song.driveFileId;
      if (!fileId) {
        const found = await driveService.findSongFile(song.track, DRIVE_FOLDER_ID);
        if (found) {
          fileId = found.id;
          await db.songs.update(song.id, { driveFileId: fileId });
        }
      }

      if (fileId) {
        // 2. Download the blob and cache it
        const blob = await driveService.downloadFileAsBlob(fileId);
        await db.songs.update(song.id, { blob, isDownloaded: true, driveFileId: fileId });
        addToast(`"${song.track}" saved for offline`);
      } else {
        // 3. Not on Drive yet → queue for Mac worker
        await driveService.requestSongDownload(song, DRIVE_FOLDER_ID);
        addToast(`Queued "${song.track}" for download — Mac worker will process it`);
      }
    } catch (e) {
      console.error('Download failed:', e);
      setActionError(e instanceof Error ? e.message : 'Download failed.');
    } finally {
      setDownloadingIds(prev => { const n = new Set(prev); n.delete(song.id); return n; });
    }
  }, [downloadingIds, addToast]);

  const handleResetLocalCache = useCallback(async () => {
    const confirmed = window.confirm(
      'Reset the local music cache on this device? This removes downloaded offline songs and synced library rows from this browser, then reloads the app.'
    );
    if (!confirmed) return;

    try {
      await resetLocalDatabase();
      window.location.reload();
    } catch (error) {
      console.error('Local cache reset failed:', error);
      setActionError(`Local cache reset failed: ${errorMessage(error)}`);
    }
  }, []);

  if (!isAuthenticated) {
    return <LoginScreen onLogin={login} error={authError} />;
  }

  const bannerError = authError || actionError || player.error || localDbError;
  const bannerStatus = bannerError || syncStatus;

  const navItems = [
    { id: VIEWS.HOME, icon: Home, label: 'Home' },
    { id: VIEWS.SEARCH, icon: Search, label: 'Search' },
    { id: VIEWS.LIBRARY, icon: Library, label: 'Library' },
  ];

  return (
    <div className="app-shell">
      {/* ── Desktop Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar__logo">
          <span>♪</span> Sisic Music
        </div>

        <nav className="sidebar__nav" aria-label="Main navigation">
          {navItems.map(item => (
            <button
              key={item.id}
              className={`sidebar__nav-item ${view === item.id ? 'sidebar__nav-item--active' : ''}`}
              onClick={() => { setView(item.id); setSelectedPlaylist(null); }}
            >
              <item.icon size={20} />
              {item.label}
            </button>
          ))}
        </nav>

        {playlists && playlists.length > 0 && (
          <>
            <div className="sidebar__section-label">Playlists</div>
            <div>
              {playlists.map(pl => (
                <div
                  key={pl}
                  className={`playlist-item ${selectedPlaylist === pl ? 'playlist-item--active' : ''}`}
                  onClick={() => { setSelectedPlaylist(pl); setView(VIEWS.LIBRARY); }}
                >
                  {pl}
                </div>
              ))}
            </div>
          </>
        )}
      </aside>

      {/* ── Main Content ── */}
      <main className="main-view">
        <SyncBanner
          isSyncing={isSyncing}
          syncStatus={bannerStatus}
          error={Boolean(bannerError)}
          onSync={syncLibrary}
          actionLabel={localDbError ? 'Reset local cache' : ''}
          onAction={localDbError ? handleResetLocalCache : undefined}
        />

        <header className="main-view__header">
          <h1 className="main-view__title">
            {view === VIEWS.HOME && 'Good evening'}
            {view === VIEWS.SEARCH && 'Search'}
            {view === VIEWS.LIBRARY && (selectedPlaylist || 'Your Library')}
          </h1>

          {(view === VIEWS.SEARCH || view === VIEWS.LIBRARY) && (
            <div className="search-box">
              <Search size={18} className="search-box__icon" />
              <input
                type="search"
                placeholder="Songs, artists…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                autoComplete="off"
              />
            </div>
          )}
        </header>

        {/* Song Grid */}
        {visibleSongs.length === 0 ? (
          <div className="empty-state">
            <Music2 size={48} color="var(--text-muted)" />
            <h3>{allSongs?.length === 0 ? 'Library is empty' : 'No results'}</h3>
            <p>
              {allSongs?.length === 0
                ? 'Your library will appear here after syncing with Drive.'
                : 'Try a different search term.'}
            </p>
          </div>
        ) : (
          <div className="songs-grid">
            {visibleSongs.map(song => (
              <SongCard
                key={song.id}
                song={song}
                onPlay={handlePlaySong}
                onDownload={handleDownload}
                isCurrentSong={player.currentSong?.id === song.id}
                isDownloading={downloadingIds.has(song.id)}
              />
            ))}
          </div>
        )}
      </main>

      {/* ── Queue Panel (slide from right) ── */}
      {showQueue && (
        <QueuePanel player={player} onClose={() => setShowQueue(false)} />
      )}

      {/* ── Player Bar ── */}
      <PlayerBar player={player} onToggleQueue={() => setShowQueue(q => !q)} />

      {/* ── Toast Notifications ── */}
      <ToastContainer toasts={toasts} />

      {/* ── Mobile Bottom Nav ── */}
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {navItems.map(item => (
          <button
            key={item.id}
            className={`mobile-nav__btn ${view === item.id ? 'mobile-nav__btn--active' : ''}`}
            onClick={() => { setView(item.id); setSelectedPlaylist(null); }}
          >
            <item.icon size={22} />
            {item.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

export default App;
