import React, { useState, useEffect, useCallback } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Home, Search, Library, Music2 } from 'lucide-react';
import { db } from './db';
import { driveService } from './services/GoogleDriveService';
import { useAudioPlayer } from './hooks/useAudioPlayer';
import { useAuth, DRIVE_FOLDER_ID } from './hooks/useAuth';
import {
  PlayerBar,
  SongCard,
  LoginScreen,
  SyncBanner,
} from './components/Components';
import './App.css';

const VIEWS = { HOME: 'home', SEARCH: 'search', LIBRARY: 'library' };

function App() {
  const { isAuthenticated, isSyncing, syncStatus, error: authError, login, syncLibrary } = useAuth();
  const player = useAudioPlayer();

  const [view, setView] = useState(VIEWS.HOME);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPlaylist, setSelectedPlaylist] = useState(null);
  const [downloadingIds, setDownloadingIds] = useState(new Set());
  const [actionError, setActionError] = useState('');

  // Live data from IndexedDB
  const allSongs = useLiveQuery(() => db.songs.orderBy('track').toArray(), []);
  const playlists = useLiveQuery(async () => {
    const names = await db.songs.orderBy('playlistName').uniqueKeys();
    return names;
  }, []);

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

  // Wire queue/index changes in useAudioPlayer to actually play a song
  useEffect(() => {
    if (player.queue.length === 0) return;
    const song = player.queue[player.queueIndex];
    if (song) {
      player.loadAndPlay(song, driveService.accessToken);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.queueIndex, player.queue]);

  const handlePlaySong = useCallback((song) => {
    const idx = visibleSongs.findIndex(s => s.id === song.id);
    player.setQueueAndPlay(visibleSongs, idx >= 0 ? idx : 0);
  }, [visibleSongs, player]);

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
      } else {
        // 3. Not on Drive yet — signal the Mac background worker
        await driveService.requestSongDownload(song, DRIVE_FOLDER_ID);
        alert(`"${song.track}" has been added to the download queue. Your Mac will process it shortly.`);
      }
    } catch (e) {
      console.error('Download failed:', e);
      setActionError(e instanceof Error ? e.message : 'Download failed.');
    } finally {
      setDownloadingIds(prev => { const n = new Set(prev); n.delete(song.id); return n; });
    }
  }, [downloadingIds]);

  if (!isAuthenticated) {
    return <LoginScreen onLogin={login} error={authError} />;
  }

  const bannerError = authError || actionError || player.error;
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
          <span>♪</span> SpotiClone
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

      {/* ── Player Bar ── */}
      <PlayerBar player={player} />

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
