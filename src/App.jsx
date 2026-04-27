import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Home, Search, Library, Music2, TrendingUp } from 'lucide-react';
import {
  AUDIO_CACHE_LIMIT_BYTES,
  cacheSongBlob,
  clearSongPlayable,
  enforceAudioCacheLimit,
  getCachedSongAudio,
  getLibrarySnapshot,
  markSongPlayable,
  resetLocalDatabase,
  syncDownloadJobsToDb,
  touchSongPlayed,
  upsertSongToDb,
} from './db';
import { driveService } from './services/GoogleDriveService';
import { useAudioPlayer } from './hooks/useAudioPlayer';
import { useAuth, DRIVE_FOLDER_ID } from './hooks/useAuth';
import { PlayerBar, SongCard, LoginScreen, SyncBanner } from './components/Components';
import { QueuePanel } from './components/QueuePanel';
import { ToastContainer } from './components/Toast';
import { useToast } from './hooks/useToast';
import { asSongRecord, getSongKey } from './songIdentity';
import './App.css';

const VIEWS = { HOME: 'home', SEARCH: 'search', LIBRARY: 'library' };
const EMPTY_LIBRARY = { songs: [], playlists: [], downloadJobs: [], error: '' };
const PAGE_SIZE = 50;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown browser storage error.');
}

function isPlayable(song) {
  return Boolean(song?.driveFileId || song?.isDownloaded || song?.isCached || song?.hasBlob);
}

function mergeJob(song, jobBySongKey) {
  if (!song?.songKey) return song;
  return { ...song, downloadJob: jobBySongKey.get(song.songKey) || song.downloadJob || null };
}

function playableStatus(song) {
  if (song?.isDownloaded) return 'offline';
  if (song?.isCached || song?.hasBlob) return 'cached';
  if (song?.driveFileId) return 'ready';
  return song?.downloadJob?.status || (song?.isCatalogueOnly ? 'catalogue' : 'missing');
}

function App() {
  const { isAuthenticated, isSyncing, syncStatus, error: authError, login, syncLibrary } = useAuth();
  const player = useAudioPlayer();
  const { toasts, addToast } = useToast();

  const [view, setView] = useState(VIEWS.HOME);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPlaylistKey, setSelectedPlaylistKey] = useState(null);
  const [downloadingKeys, setDownloadingKeys] = useState(new Set());
  const [actionError, setActionError] = useState('');
  const [showQueue, setShowQueue] = useState(false);
  const [pageLimit, setPageLimit] = useState(PAGE_SIZE);
  const [catalogue, setCatalogue] = useState([]);

  const playbackRequestRef = useRef(0);
  const countedPlaybackRef = useRef(new Set());
  const resolvePlayableSongRef = useRef(null);
  const loadAndPlayRef = useRef(null);
  const playNextRef = useRef(null);
  const setPlayerErrorRef = useRef(null);
  const {
    currentSongKey,
    isPlaying,
    loadAndPlay,
    playNext,
    queue,
    queueIndex,
    setPlayerError,
  } = player;

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}unique_songs.json`)
      .then(response => response.json())
      .then(data => {
        const bySongKey = new Map();
        data.forEach((raw, index) => {
          const song = asSongRecord({
            _catalogueId: index,
            artist: raw.artistName || raw.artist,
            track: raw.trackName || raw.track,
            album: raw.album || '',
            isCatalogueOnly: true,
          });
          if (!bySongKey.has(song.songKey)) bySongKey.set(song.songKey, song);
        });
        setCatalogue([...bySongKey.values()]);
      })
      .catch(error => console.error('Failed to load search catalogue:', error));
  }, []);

  const libraryData = useLiveQuery(getLibrarySnapshot, [], EMPTY_LIBRARY);
  const safeLibraryData = libraryData || EMPTY_LIBRARY;
  const allSongs = safeLibraryData.songs;
  const playlists = safeLibraryData.playlists;
  const localDbError = safeLibraryData.error;

  const jobBySongKey = useMemo(() => {
    const map = new Map();
    for (const job of safeLibraryData.downloadJobs || []) {
      const previous = map.get(job.songKey);
      if (!previous || String(job.updatedAt || '') > String(previous.updatedAt || '')) map.set(job.songKey, job);
    }
    return map;
  }, [safeLibraryData.downloadJobs]);

  const allSongsByKey = useMemo(() => {
    return new Map(allSongs.map(song => [song.songKey, mergeJob(song, jobBySongKey)]));
  }, [allSongs, jobBySongKey]);

  const topPlayed = useMemo(() => {
    return [...allSongs]
      .filter(song => (song.playCount || 0) > 0)
      .sort((a, b) => (b.playCount || 0) - (a.playCount || 0))
      .slice(0, 8)
      .map(song => mergeJob(song, jobBySongKey));
  }, [allSongs, jobBySongKey]);

  const availableSongs = useMemo(() => {
    return allSongs.filter(isPlayable).map(song => mergeJob(song, jobBySongKey));
  }, [allSongs, jobBySongKey]);

  const searchResults = useMemo(() => {
    if (!searchQuery || searchQuery.length < 2) return [];
    const q = searchQuery.toLowerCase();
    return catalogue
      .filter(song => song.track.toLowerCase().includes(q) || song.artist.toLowerCase().includes(q))
      .slice(0, 80)
      .map(song => mergeJob(allSongsByKey.get(song.songKey) || song, jobBySongKey));
  }, [catalogue, allSongsByKey, jobBySongKey, searchQuery]);

  const selectedPlaylist = useMemo(() => {
    return playlists.find(playlist => playlist.playlistKey === selectedPlaylistKey) || null;
  }, [playlists, selectedPlaylistKey]);

  const librarySongs = useMemo(() => {
    if (!selectedPlaylistKey) return availableSongs;
    return allSongs
      .filter(song => song.playlistKeys?.includes(selectedPlaylistKey))
      .map(song => mergeJob(song, jobBySongKey));
  }, [allSongs, selectedPlaylistKey, availableSongs, jobBySongKey]);

  // Track whether we have pending jobs that need polling
  const [hasPendingJobs, setHasPendingJobs] = useState(false);

  const refreshDownloadJobs = useCallback(async () => {
    if (!isAuthenticated || !DRIVE_FOLDER_ID || !driveService.isAuthenticated) return;
    try {
      const jobs = await driveService.listDownloadJobs(DRIVE_FOLDER_ID);
      await syncDownloadJobsToDb(jobs);
      // Only keep polling if there are active (queued/downloading) jobs
      const pending = jobs.some(j => j.status === 'queued' || j.status === 'downloading');
      setHasPendingJobs(pending);
    } catch (error) {
      console.error('Failed to refresh Drive jobs:', error);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) return undefined;
    // Initial check — use setTimeout to avoid synchronous setState in effect body
    const mountTimer = window.setTimeout(refreshDownloadJobs, 0);
    // Only poll continuously if there are pending jobs
    const interval = hasPendingJobs
      ? window.setInterval(refreshDownloadJobs, 20000)
      : undefined;
    return () => {
      window.clearTimeout(mountTimer);
      if (interval) window.clearInterval(interval);
    };
  }, [isAuthenticated, refreshDownloadJobs, hasPendingJobs]);

  const queueSongForDownload = useCallback(async (song) => {
    if (!DRIVE_FOLDER_ID) throw new Error('Missing required config: VITE_DRIVE_FOLDER_ID.');
    const result = await driveService.requestSongDownload(song, DRIVE_FOLDER_ID);
    if (result.job) {
      await syncDownloadJobsToDb([result.job]);
      setHasPendingJobs(true); // Start polling to track this job
    }
    return result;
  }, []);

  const ensureLocalSong = useCallback(async (song, playlistName = '') => {
    const normalized = asSongRecord(song);
    const existing = allSongsByKey.get(normalized.songKey);
    if (existing && !song.isCatalogueOnly) return existing;
    const stored = await upsertSongToDb(normalized, playlistName);
    return { ...normalized, ...stored, downloadJob: jobBySongKey.get(normalized.songKey) || null };
  }, [allSongsByKey, jobBySongKey]);

  const resolvePlayableSong = useCallback(async (song, { queueIfMissing = true, showToast = false } = {}) => {
    const localSong = await ensureLocalSong(song, song.playlistName || '');
    let resolved = { ...song, ...localSong, downloadJob: jobBySongKey.get(localSong.songKey) || localSong.downloadJob || null };

    if (resolved.isDownloaded || resolved.isCached || resolved.hasBlob) {
      const cachedAudio = await getCachedSongAudio(resolved.songKey);
      if (cachedAudio) return { ...resolved, ...cachedAudio };
    }

    if (resolved.driveFileId) {
      const metadata = await driveService.getAudioFileMetadata(resolved.driveFileId);
      if (metadata) return resolved;
      await clearSongPlayable(resolved.songKey);
      resolved = {
        ...resolved,
        driveFileId: null,
        isDownloaded: false,
        isCached: false,
        hasBlob: false,
        blob: null,
        cacheSizeBytes: 0,
        cachedAt: null,
      };
    }

    if (DRIVE_FOLDER_ID) {
      const found = await driveService.findSongFile(resolved, DRIVE_FOLDER_ID);
      if (found) {
        await markSongPlayable(resolved.songKey, found.id);
        return { ...resolved, driveFileId: found.id };
      }
    }

    if (queueIfMissing) {
      const result = await queueSongForDownload(resolved);
      const status = result.job?.status || 'queued';
      if (showToast) {
        addToast(result.queued
          ? `Queued "${resolved.track}" for download`
          : `"${resolved.track}" is already ${status}`);
      }
      return null;
    }

    return null;
  }, [addToast, ensureLocalSong, jobBySongKey, queueSongForDownload]);

  useEffect(() => {
    resolvePlayableSongRef.current = resolvePlayableSong;
    loadAndPlayRef.current = loadAndPlay;
    playNextRef.current = playNext;
    setPlayerErrorRef.current = setPlayerError;
  }, [loadAndPlay, playNext, resolvePlayableSong, setPlayerError]);

  useEffect(() => {
    if (queue.length === 0) return undefined;
    const song = queue[queueIndex];
    if (!song) return undefined;

    const requestId = ++playbackRequestRef.current;
    let cancelled = false;

    const playSong = async () => {
      try {
        const resolved = await resolvePlayableSongRef.current(song, { queueIfMissing: true, showToast: false });
        if (cancelled || requestId !== playbackRequestRef.current) return;
        if (resolved) {
          await loadAndPlayRef.current(resolved, driveService.accessToken);
          return;
        }
        setPlayerErrorRef.current(`"${song.track}" is queued for download.`);
        if (queue.some((candidate, index) => index !== queueIndex && isPlayable(candidate))) {
          window.setTimeout(() => {
            if (!cancelled && requestId === playbackRequestRef.current) {
              playNextRef.current({ avoidCurrent: true, stopOnBlocked: true });
            }
          }, 250);
        }
      } catch (error) {
        if (cancelled || requestId !== playbackRequestRef.current) return;
        console.error('Playback preparation failed:', error);
        setPlayerErrorRef.current(errorMessage(error));
      }
    };

    playSong();
    return () => {
      cancelled = true;
    };
  }, [queue, queueIndex]);

  useEffect(() => {
    if (!currentSongKey || !isPlaying) return;
    if (countedPlaybackRef.current.has(currentSongKey)) return;
    countedPlaybackRef.current.add(currentSongKey);
    touchSongPlayed(currentSongKey).catch(error => console.error('Play count update failed:', error));
  }, [currentSongKey, isPlaying]);

  // Streaming is the default. Full audio downloads only happen through the explicit offline button.

  const handlePlaySong = useCallback(async (song, songList) => {
    setActionError('');
    const selectedKey = getSongKey(song);
    const sourceSongs = (songList || [song]).map(asSongRecord).map(item => mergeJob(allSongsByKey.get(item.songKey) || item, jobBySongKey));
    const startIdx = Math.max(0, sourceSongs.findIndex(item => item.songKey === selectedKey));

    try {
      const resolved = await resolvePlayableSong(sourceSongs[startIdx] || song, { queueIfMissing: true, showToast: true });
      if (resolved) {
        const updated = sourceSongs.map(item => item.songKey === selectedKey ? { ...item, ...resolved } : item);
        player.setQueueAndPlay(updated, startIdx);
        return;
      }

      const playable = sourceSongs.filter(isPlayable);
      if (playable.length > 0) {
        player.setQueueAndPlay(playable, 0);
      }
    } catch (error) {
      console.error('Play failed:', error);
      const message = errorMessage(error);
      setActionError(message);
      addToast(message);
    }
  }, [addToast, allSongsByKey, jobBySongKey, player, resolvePlayableSong]);

  const handleDownload = useCallback(async (song) => {
    const selectedKey = getSongKey(song);
    if (downloadingKeys.has(selectedKey)) return;
    if (!DRIVE_FOLDER_ID) {
      setActionError('Missing required config: VITE_DRIVE_FOLDER_ID.');
      return;
    }

    setActionError('');
    setDownloadingKeys(prev => new Set(prev).add(selectedKey));
    try {
      const localSong = await ensureLocalSong(song, song.playlistName || '');
      let fileId = localSong.driveFileId;
      if (fileId) {
        const metadata = await driveService.getAudioFileMetadata(fileId);
        if (!metadata) {
          await clearSongPlayable(localSong.songKey);
          fileId = null;
        }
      }
      if (!fileId) {
        const found = await driveService.findSongFile(localSong, DRIVE_FOLDER_ID);
        if (found) {
          fileId = found.id;
          await markSongPlayable(localSong.songKey, fileId);
        }
      }

      if (fileId) {
        const blob = await driveService.downloadFileAsBlob(fileId);
        await cacheSongBlob(localSong.songKey, blob, fileId, { explicit: true });
        await enforceAudioCacheLimit(AUDIO_CACHE_LIMIT_BYTES);
        addToast(`"${localSong.track}" saved for offline`);
      } else {
        const result = await queueSongForDownload(localSong);
        addToast(result.queued
          ? `Queued "${localSong.track}" for download`
          : `"${localSong.track}" is already ${result.job?.status || 'queued'}`);
      }
    } catch (error) {
      console.error('Download failed:', error);
      const message = errorMessage(error);
      setActionError(message);
      addToast(message);
    } finally {
      setDownloadingKeys(prev => {
        const next = new Set(prev);
        next.delete(selectedKey);
        return next;
      });
    }
  }, [addToast, downloadingKeys, ensureLocalSong, queueSongForDownload]);

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
  const effectivePageLimit = view === VIEWS.LIBRARY ? pageLimit : PAGE_SIZE;

  const navItems = [
    { id: VIEWS.HOME, icon: Home, label: 'Home' },
    { id: VIEWS.SEARCH, icon: Search, label: 'Search' },
    { id: VIEWS.LIBRARY, icon: Library, label: 'Library' },
  ];

  let displaySongs = [];
  if (view === VIEWS.SEARCH) {
    displaySongs = searchResults;
  } else if (view === VIEWS.LIBRARY) {
    displaySongs = librarySongs.slice(0, effectivePageLimit);
  }

  const renderSongCard = (song, list) => (
    <SongCard
      key={song.songKey}
      song={{ ...song, status: playableStatus(song) }}
      onPlay={(selected) => handlePlaySong(selected, list)}
      onDownload={handleDownload}
      isCurrentSong={player.currentSongKey === song.songKey}
      isDownloading={downloadingKeys.has(song.songKey)}
    />
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar__logo">
          <span>♪</span> Sisic Music
        </div>

        <nav className="sidebar__nav" aria-label="Main navigation">
          {navItems.map(item => (
            <button
              key={item.id}
              className={`sidebar__nav-item ${view === item.id ? 'sidebar__nav-item--active' : ''}`}
              onClick={() => { setView(item.id); setSelectedPlaylistKey(null); setSearchQuery(''); setPageLimit(PAGE_SIZE); }}
            >
              <item.icon size={20} />
              {item.label}
            </button>
          ))}
        </nav>

        {playlists.length > 0 && (
          <>
            <div className="sidebar__section-label">Playlists</div>
            <div>
              {playlists.map(playlist => (
                <button
                  key={playlist.playlistKey}
                  className={`playlist-item ${selectedPlaylistKey === playlist.playlistKey ? 'playlist-item--active' : ''}`}
                  onClick={() => { setSelectedPlaylistKey(playlist.playlistKey); setView(VIEWS.LIBRARY); setPageLimit(PAGE_SIZE); }}
                >
                  {playlist.name}
                </button>
              ))}
            </div>
          </>
        )}
      </aside>

      <main className="main-view">
        <SyncBanner
          isSyncing={isSyncing}
          syncStatus={bannerStatus}
          error={Boolean(bannerError)}
          onSync={syncLibrary}
          actionLabel={localDbError ? 'Reset local cache' : ''}
          onAction={localDbError ? handleResetLocalCache : undefined}
        />

        {view === VIEWS.HOME && (
          <>
            <header className="main-view__header">
              <h1 className="main-view__title">Good evening</h1>
            </header>

            {playlists.length > 0 && (
              <section className="home-section">
                <h2 className="home-section__title">Your Playlists</h2>
                <div className="playlist-grid">
                  {playlists.filter(playlist => playlist.name !== 'Listening History').slice(0, 12).map(playlist => {
                    const hue = playlist.name.charCodeAt(0) % 360;
                    return (
                      <button
                        key={playlist.playlistKey}
                        className="playlist-card"
                        onClick={() => { setSelectedPlaylistKey(playlist.playlistKey); setView(VIEWS.LIBRARY); setPageLimit(PAGE_SIZE); }}
                      >
                        <div
                          className="playlist-card__art"
                          style={{ background: `linear-gradient(135deg, hsl(${hue}, 60%, 30%), hsl(${(hue + 80) % 360}, 50%, 18%))` }}
                        />
                        <div className="playlist-card__info">
                          <span className="playlist-card__name">{playlist.name}</span>
                          <span className="playlist-card__count">{playlist.count} songs</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {topPlayed.length > 0 && (
              <section className="home-section">
                <h2 className="home-section__title">
                  <TrendingUp size={18} style={{ marginRight: 8, verticalAlign: 'middle' }} />
                  Most Played
                </h2>
                <div className="songs-grid">
                  {topPlayed.map(song => renderSongCard(song, topPlayed))}
                </div>
              </section>
            )}

            {availableSongs.length > 0 && (
              <section className="home-section">
                <h2 className="home-section__title">Ready to Play</h2>
                <div className="songs-grid">
                  {availableSongs.slice(0, 8).map(song => renderSongCard(song, availableSongs))}
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

        {view === VIEWS.SEARCH && (
          <>
            <header className="main-view__header">
              <h1 className="main-view__title">Search</h1>
              <div className="search-box">
                <Search size={18} className="search-box__icon" />
                <input
                  type="search"
                  placeholder="Search songs, artists"
                  value={searchQuery}
                  onChange={event => setSearchQuery(event.target.value)}
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
                {displaySongs.map(song => renderSongCard(song, searchResults))}
              </div>
            )}
          </>
        )}

        {view === VIEWS.LIBRARY && (
          <>
            <header className="main-view__header">
              <h1 className="main-view__title">{selectedPlaylist?.name || 'Your Library'}</h1>
              <div className="search-box">
                <Search size={18} className="search-box__icon" />
                <input
                  type="search"
                  placeholder="Filter"
                  value={searchQuery}
                  onChange={event => setSearchQuery(event.target.value)}
                  autoComplete="off"
                />
              </div>
            </header>

            {(() => {
              const filtered = searchQuery.length >= 2
                ? librarySongs.filter(song => {
                    const q = searchQuery.toLowerCase();
                    return song.track.toLowerCase().includes(q) || song.artist.toLowerCase().includes(q);
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
                    {shown.map(song => renderSongCard(song, filtered))}
                  </div>
                  {hasMore && (
                    <button className="load-more-btn" onClick={() => setPageLimit(limit => limit + PAGE_SIZE)}>
                      Show more ({filtered.length - pageLimit} remaining)
                    </button>
                  )}
                </>
              );
            })()}
          </>
        )}
      </main>

      {showQueue && <QueuePanel player={player} jobBySongKey={jobBySongKey} onClose={() => setShowQueue(false)} />}
      <PlayerBar player={player} onToggleQueue={() => setShowQueue(open => !open)} />
      <ToastContainer toasts={toasts} />

      <nav className="mobile-nav" aria-label="Mobile navigation">
        {navItems.map(item => (
          <button
            key={item.id}
            className={`mobile-nav__btn ${view === item.id ? 'mobile-nav__btn--active' : ''}`}
            onClick={() => { setView(item.id); setSelectedPlaylistKey(null); setSearchQuery(''); }}
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
