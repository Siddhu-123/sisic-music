import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Home, Search, Library, Music2, TrendingUp } from 'lucide-react';
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
const PAGE_SIZE = 50; // Songs to show per page in Library view

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
  const [pageLimit, setPageLimit] = useState(PAGE_SIZE);

  // Search catalogue — loaded once from static JSON (~300KB, 3932 songs)
  const [catalogue, setCatalogue] = useState([]);
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}unique_songs.json`)
      .then(r => r.json())
      .then(data => {
        // Normalize shape: { artist, track }
        const normalized = data.map((s, i) => ({
          _catalogueId: i, // Not a DB id — just for React keys
          artist: s.artistName || s.artist || 'Unknown',
          track: s.trackName || s.track || 'Unknown',
          album: s.album || '',
          isCatalogueOnly: true, // Not in IndexedDB yet
        }));
        setCatalogue(normalized);
      })
      .catch(e => console.error('Failed to load search catalogue:', e));
  }, []);

  // Load song metadata from IndexedDB WITHOUT blob data (saves hundreds of MB of RAM).
  const libraryData = useLiveQuery(async () => {
    try {
      const songs = await db.songs.toCollection().toArray();
      // Strip blob field from memory — it's only needed when actually playing offline
      const light = songs.map(({ blob, ...rest }) => ({ ...rest, hasBlob: !!blob }));
      light.sort((a, b) => (a.track || '').localeCompare(b.track || ''));
      const playlists = Array.from(new Set(
        light.map(song => song.playlistName).filter(Boolean)
      )).sort((a, b) => a.localeCompare(b));
      return { songs: light, playlists, error: '' };
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

  // ── Derived views ──────────────────────────────────────────────────────

  // Top played songs (for home page)
  const topPlayed = useMemo(() => {
    return [...allSongs]
      .filter(s => (s.playCount || 0) > 0)
      .sort((a, b) => (b.playCount || 0) - (a.playCount || 0))
      .slice(0, 8);
  }, [allSongs]);

  // Songs available on Drive (can actually play)
  const availableSongs = useMemo(() => {
    return allSongs.filter(s => s.driveFileId || s.isDownloaded || s.hasBlob);
  }, [allSongs]);

  // Search results from the catalogue — searches ALL 3932 unique songs
  // without needing them in IndexedDB. Merges with local DB info if available.
  const searchResults = useMemo(() => {
    if (!searchQuery || searchQuery.length < 2) return [];
    const q = searchQuery.toLowerCase();
    // Build a map of DB songs by artist+track for quick lookup
    const dbMap = new Map(allSongs.map(s => [`${s.artist}|||${s.track}`, s]));

    return catalogue
      .filter(s => s.track.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q))
      .slice(0, 60)
      .map(s => {
        // If this song is already in our local DB, use the richer DB version
        const dbSong = dbMap.get(`${s.artist}|||${s.track}`);
        return dbSong || s;
      });
  }, [catalogue, allSongs, searchQuery]);

  // Library view songs (with playlist filter + pagination)
  const librarySongs = useMemo(() => {
    return selectedPlaylist
      ? allSongs.filter(s => s.playlistName === selectedPlaylist)
      : availableSongs; // Default library shows songs that are playable
  }, [allSongs, selectedPlaylist, availableSongs]);

  const effectivePageLimit = view === VIEWS.LIBRARY ? pageLimit : PAGE_SIZE;

  // ── Playback ──────────────────────────────────────────────────────────

  // Wire queue/index changes to play a song.
  // If the song doesn't have a driveFileId yet, look it up on Drive first.
  useEffect(() => {
    if (player.queue.length === 0) return;
    const song = player.queue[player.queueIndex];
    if (!song) return;

    const playSong = async () => {
      let resolved = song;
      if (!song.driveFileId && !song.isDownloaded && DRIVE_FOLDER_ID) {
        try {
          const found = await driveService.findSongFile(song.track, DRIVE_FOLDER_ID, song.artist);
          if (found) {
            await db.songs.update(song.id, { driveFileId: found.id });
            resolved = { ...song, driveFileId: found.id };
          }
        } catch (e) {
          console.error('Drive lookup for queued song failed:', e);
        }
      }

      // For offline songs, we need to fetch the blob from DB (we stripped it from memory)
      if (resolved.isDownloaded && !resolved.blob) {
        try {
          const fullSong = await db.songs.get(resolved.id);
          if (fullSong?.blob) {
            resolved = { ...resolved, blob: fullSong.blob };
          }
        } catch (e) {
          console.error('Failed to load offline blob:', e);
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
  const handlePlaySong = useCallback(async (song, songList) => {
    const songs = songList || [song];
    const idx = songs.findIndex(s => s.id === song.id);
    const startIdx = idx >= 0 ? idx : 0;

    // Already has a Drive file ID or local blob → play immediately
    if (song.driveFileId || song.isDownloaded) {
      player.setQueueAndPlay(songs, startIdx);
      return;
    }

    // No driveFileId stored — search Drive for the file first
    if (DRIVE_FOLDER_ID) {
      try {
        const found = await driveService.findSongFile(song.track, DRIVE_FOLDER_ID, song.artist);
        if (found) {
          await db.songs.update(song.id, { driveFileId: found.id });
          const updated = songs.map(s =>
            s.id === song.id ? { ...s, driveFileId: found.id } : s
          );
          player.setQueueAndPlay(updated, startIdx);
          return;
        }
      } catch (e) {
        console.error('Drive lookup failed:', e);
      }

      // Not on Drive → queue for Mac worker download
      try {
        await driveService.requestSongDownload(song, DRIVE_FOLDER_ID);
        addToast(`Queued "${song.track}" for download`);
      } catch (e) {
        addToast(`Failed to queue "${song.track}": ${e.message || 'Drive write error'}`);
      }
    }

    // Try to find next playable song in the list
    const playable = songs.filter(s => s.driveFileId || s.isDownloaded);
    if (playable.length > 0) {
      player.setQueueAndPlay(playable, 0);
    }
  }, [player, addToast]);

  /**
   * Seamless download flow:
   * 1. Check if already on Drive → cache locally
   * 2. Not on Drive → queue for Mac worker + toast
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
      let fileId = song.driveFileId;
      if (!fileId) {
        const found = await driveService.findSongFile(song.track, DRIVE_FOLDER_ID, song.artist);
        if (found) {
          fileId = found.id;
          await db.songs.update(song.id, { driveFileId: fileId });
        }
      }

      if (fileId) {
        const blob = await driveService.downloadFileAsBlob(fileId);
        await db.songs.update(song.id, { blob, isDownloaded: true, driveFileId: fileId });
        addToast(`"${song.track}" saved for offline`);
      } else {
        try {
          await driveService.requestSongDownload(song, DRIVE_FOLDER_ID);
          addToast(`Queued "${song.track}" for download — Mac worker will process it`);
        } catch (e) {
          addToast(`Failed to queue "${song.track}": ${e.message || 'Drive write error'}`);
        }
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

  // Determine what songs to display based on current view
  let displaySongs = [];

  if (view === VIEWS.SEARCH) {
    displaySongs = searchResults;
  } else if (view === VIEWS.LIBRARY) {
    displaySongs = librarySongs.slice(0, effectivePageLimit);
  }
  // HOME view renders its own sections below, not the grid

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
              onClick={() => { setView(item.id); setSelectedPlaylist(null); setSearchQuery(''); setPageLimit(PAGE_SIZE); }}
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
                  onClick={() => { setSelectedPlaylist(pl); setView(VIEWS.LIBRARY); setPageLimit(PAGE_SIZE); }}
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

        {/* ── HOME VIEW ── */}
        {view === VIEWS.HOME && (
          <>
            <header className="main-view__header">
              <h1 className="main-view__title">Good evening</h1>
            </header>

            {/* Playlist Quick Access */}
            {playlists.length > 0 && (
              <section className="home-section">
                <h2 className="home-section__title">Your Playlists</h2>
                <div className="playlist-grid">
                  {playlists.filter(p => p !== 'Listening History').slice(0, 12).map(pl => {
                    const hue = pl.charCodeAt(0) % 360;
                    const count = allSongs.filter(s => s.playlistName === pl).length;
                    return (
                      <div
                        key={pl}
                        className="playlist-card"
                        onClick={() => { setSelectedPlaylist(pl); setView(VIEWS.LIBRARY); setPageLimit(PAGE_SIZE); }}
                      >
                        <div
                          className="playlist-card__art"
                          style={{ background: `linear-gradient(135deg, hsl(${hue}, 60%, 30%), hsl(${(hue + 80) % 360}, 50%, 18%))` }}
                        />
                        <div className="playlist-card__info">
                          <span className="playlist-card__name">{pl}</span>
                          <span className="playlist-card__count">{count} songs</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Top Played */}
            {topPlayed.length > 0 && (
              <section className="home-section">
                <h2 className="home-section__title">
                  <TrendingUp size={18} style={{ marginRight: 8, verticalAlign: 'middle' }} />
                  Most Played
                </h2>
                <div className="songs-grid">
                  {topPlayed.map(song => (
                    <SongCard
                      key={song.id}
                      song={song}
                      onPlay={(s) => handlePlaySong(s, topPlayed)}
                      onDownload={handleDownload}
                      isCurrentSong={player.currentSong?.id === song.id}
                      isDownloading={downloadingIds.has(song.id)}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Available to Play */}
            {availableSongs.length > 0 && (
              <section className="home-section">
                <h2 className="home-section__title">Ready to Play</h2>
                <div className="songs-grid">
                  {availableSongs.slice(0, 8).map(song => (
                    <SongCard
                      key={song.id}
                      song={song}
                      onPlay={(s) => handlePlaySong(s, availableSongs)}
                      onDownload={handleDownload}
                      isCurrentSong={player.currentSong?.id === song.id}
                      isDownloading={downloadingIds.has(song.id)}
                    />
                  ))}
                </div>
              </section>
            )}

            {allSongs.length === 0 && (
              <div className="empty-state">
                <Music2 size={48} color="var(--text-muted)" />
                <h3>Library is empty</h3>
                <p>Your library will appear here after syncing with Drive.</p>
              </div>
            )}
          </>
        )}

        {/* ── SEARCH VIEW ── */}
        {view === VIEWS.SEARCH && (
          <>
            <header className="main-view__header">
              <h1 className="main-view__title">Search</h1>
              <div className="search-box">
                <Search size={18} className="search-box__icon" />
                <input
                  type="search"
                  placeholder="Search songs, artists…"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  autoComplete="off"
                  autoFocus
                />
              </div>
            </header>

            {searchQuery.length < 2 ? (
              <div className="empty-state">
                <Search size={48} color="var(--text-muted)" />
                <h3>Search your library</h3>
                <p>Find any of your {catalogue.length.toLocaleString()} songs by name or artist</p>
              </div>
            ) : searchResults.length === 0 ? (
              <div className="empty-state">
                <Music2 size={48} color="var(--text-muted)" />
                <h3>No results</h3>
                <p>Try a different search term</p>
              </div>
            ) : (
              <div className="songs-grid">
                {displaySongs.map(song => (
                  <SongCard
                    key={song.id || `cat-${song._catalogueId}`}
                    song={song}
                    onPlay={(s) => handlePlaySong(s, searchResults)}
                    onDownload={handleDownload}
                    isCurrentSong={player.currentSong?.id === song.id}
                    isDownloading={song.id ? downloadingIds.has(song.id) : false}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* ── LIBRARY VIEW ── */}
        {view === VIEWS.LIBRARY && (
          <>
            <header className="main-view__header">
              <h1 className="main-view__title">{selectedPlaylist || 'Your Library'}</h1>
              <div className="search-box">
                <Search size={18} className="search-box__icon" />
                <input
                  type="search"
                  placeholder="Filter…"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  autoComplete="off"
                />
              </div>
            </header>

            {/* Filter within library view */}
            {(() => {
              const filtered = searchQuery.length >= 2
                ? librarySongs.filter(s => {
                    const q = searchQuery.toLowerCase();
                    return s.track.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q);
                  })
                : librarySongs;
              const shown = filtered.slice(0, pageLimit);
              const hasMore = pageLimit < filtered.length;

              return shown.length === 0 ? (
                <div className="empty-state">
                  <Music2 size={48} color="var(--text-muted)" />
                  <h3>No songs</h3>
                  <p>{selectedPlaylist ? 'This playlist is empty' : 'No playable songs yet'}</p>
                </div>
              ) : (
                <>
                  <div className="library-count">{filtered.length} songs</div>
                  <div className="songs-grid">
                    {shown.map(song => (
                      <SongCard
                        key={song.id}
                        song={song}
                        onPlay={(s) => handlePlaySong(s, filtered)}
                        onDownload={handleDownload}
                        isCurrentSong={player.currentSong?.id === song.id}
                        isDownloading={downloadingIds.has(song.id)}
                      />
                    ))}
                  </div>
                  {hasMore && (
                    <button
                      className="load-more-btn"
                      onClick={() => setPageLimit(p => p + PAGE_SIZE)}
                    >
                      Show more ({filtered.length - pageLimit} remaining)
                    </button>
                  )}
                </>
              );
            })()}
          </>
        )}
      </main>

      {/* ── Queue Panel ── */}
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
            onClick={() => { setView(item.id); setSelectedPlaylist(null); setSearchQuery(''); }}
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
