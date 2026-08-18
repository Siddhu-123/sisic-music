import React, { lazy, Suspense, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { BarChart3, Home, Search, Library, Music2, RefreshCw, TrendingUp, X, FolderOpen, HardDriveDownload, FileDown, Sliders, Sparkles, Compass } from 'lucide-react';
import {
  AUDIO_CACHE_LIMIT_BYTES,
  addSongToPlaylist,
  cacheSongBlob,
  clearSongPlayable,
  enqueueSyncOutbox,
  enforceAudioCacheLimit,
  getCachedSongAudio,
  getLibrarySnapshot,
  getPlaylistSnapshotForDrive,
  markSongPlayable,
  removeSongFromPlaylist,
  resetLocalDatabase,
  recordPlaybackEvent,
  syncDownloadJobsToDb,
  touchSongPlayed,
  syncPlaylistIndexToDb,
  updateSongPipelineStatus,
  updateSyncOutbox,
  upsertSongToDb,
} from './db.js';
import { driveService } from './services/GoogleDriveService.js';
import { useAudioPlayer } from './hooks/useAudioPlayer.js';
import { useAuth, DRIVE_FOLDER_ID } from './hooks/useAuth.js';
import { AsyncArtworkImage, DownloadStatusPanel, ImportStatusPanel, PlayerBar, SongCard, SongInfoPanel, SongReviewPanel, LoginScreen, SyncBanner } from './components/Components.jsx';
import { ToastContainer } from './components/Toast.jsx';
import { useToast } from './hooks/useToast.js';
import { useDialogFocus } from './hooks/useDialogFocus.js';
import { asSongRecord, getSongKey, normalizeText } from './songIdentity.js';
import { collectAudioFiles, importAudioFiles, queueCachedLocalImports } from './services/importService.js';
import './App.css';

const QueuePanel = lazy(() => import('./components/QueuePanel.jsx').then(module => ({ default: module.QueuePanel })));
const ConstellationView = lazy(() => import('./components/views/ConstellationView.jsx').then(module => ({ default: module.ConstellationView })));
const EqualizerModal = lazy(() => import('./components/EqualizerModal.jsx').then(module => ({ default: module.EqualizerModal })));
const RecommendationsModal = lazy(() => import('./components/RecommendationsModal.jsx').then(module => ({ default: module.RecommendationsModal })));
const TasteProfileModal = lazy(() => import('./components/TasteProfileModal.jsx').then(module => ({ default: module.TasteProfileModal })));

const VIEWS = { HOME: 'home', SEARCH: 'search', LIBRARY: 'library', DOWNLOADS: 'downloads', CONSTELLATION: 'constellation' };
const EMPTY_LIBRARY = { songs: [], playlists: [], downloadJobs: [], importJobs: [], embeddingJobs: [], syncOutbox: [], playbackEvents: [], error: '' };
const PAGE_SIZE = 50;
const AUTO_QUEUE_LIMIT = 10;
const LISTENING_HISTORY_KEY = 'listening history';

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown browser storage error.');
}

function scheduleIdleWork(callback, timeout = 1200) {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(callback, { timeout });
    return () => window.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(callback, Math.min(timeout, 250));
  return () => window.clearTimeout(id);
}

function isSyncRetryReady(operation) {
  if (!operation.nextAttemptAt) return true;
  const retryAt = Date.parse(operation.nextAttemptAt);
  return !Number.isFinite(retryAt) || retryAt <= Date.now();
}

function syncRetryDelayMs(attempts) {
  return Math.min(5 * 60 * 1000, 30 * 1000 * (2 ** Math.max(0, attempts - 1)));
}

function formatBytes(bytes = 0) {
  if (!bytes) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes) || 0;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value >= 10 || unitIndex < 2 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function currentGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function isPlayable(song) {
  return Boolean(song?.driveFileId || song?.isDownloaded || song?.isCached || song?.hasBlob);
}

function buildAnalyticsExport({ songs = [], playlists = [], downloadJobs = [], importJobs = [], embeddingJobs = [], playbackEvents = [], drivePlaybackEvents = [], syncOutbox = [] }) {
  const queuedEvents = syncOutbox
    .filter(item => item.entityType === 'playback-event' && item.payload?.id)
    .map(item => item.payload);
  const eventsById = new Map([...drivePlaybackEvents, ...playbackEvents, ...queuedEvents].map(event => [event.id || event.eventId, event]));
  const events = [...eventsById.values()].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  const starts = events.filter(event => ['playback-start', 'playback-resume'].includes(event.eventType));
  const listenedSeconds = events
    .filter(event => ['playback-complete', 'playback-short-ended', 'playback-pause', 'playback-stop', 'user-skip', 'playback-stream-error'].includes(event.eventType))
    .reduce((total, event) => total + Math.max(0, Number(event.positionSeconds) || 0), 0);
  const songByKey = new Map(songs.map(song => [song.songKey, song]));
  const countBy = (items, key) => items.reduce((counts, item) => {
    const value = String(item[key] || 'Unknown').trim() || 'Unknown';
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
  const artistListening = {};
  const artistListeningSeconds = {};
  const startsBySong = {};
  for (const event of starts) {
    const artist = event.artist || songByKey.get(event.songKey)?.artist || 'Unknown';
    artistListening[artist] = (artistListening[artist] || 0) + 1;
    startsBySong[event.songKey] = (startsBySong[event.songKey] || 0) + 1;
  }
  for (const event of events.filter(item => ['playback-complete', 'playback-short-ended', 'playback-pause', 'playback-stop', 'user-skip', 'playback-stream-error'].includes(item.eventType))) {
    const artist = event.artist || songByKey.get(event.songKey)?.artist || 'Unknown';
    artistListeningSeconds[artist] = (artistListeningSeconds[artist] || 0) + Math.max(0, Number(event.positionSeconds) || 0);
  }

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    songs: songs.map(song => ({ ...song })),
    playlists: playlists.map(playlist => ({ ...playlist })),
    downloadJobs: downloadJobs.map(job => ({ ...job })),
    importJobs: importJobs.map(job => ({ ...job })),
    embeddingJobs: embeddingJobs.map(job => ({ ...job })),
    metrics: {
      totalSongs: songs.length,
      totalArtists: new Set(songs.map(song => song.artist).filter(Boolean)).size,
      totalPlayCount: songs.reduce((total, song) => total + (Number(song.playCount) || 0), 0),
      totalPlaybackEvents: events.length,
      totalPlaybackStarts: starts.length,
      replayCount: Object.values(startsBySong).reduce((total, count) => total + Math.max(0, count - 1), 0),
      skipCount: events.filter(event => event.eventType === 'user-skip').length,
      estimatedListeningSeconds: Math.round(listenedSeconds),
      estimatedListeningMinutes: Math.round(listenedSeconds / 60),
      uniquePlayedSongs: new Set(starts.map(event => event.songKey).filter(Boolean)).size,
      uniquePlayedArtists: new Set(starts.map(event => event.artist || songByKey.get(event.songKey)?.artist).filter(Boolean)).size,
      playbackEventTypes: countBy(events, 'eventType'),
      topArtistsByStarts: Object.entries(artistListening)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 25)
        .map(([artist, plays]) => ({ artist, plays })),
      topArtistsByListeningSeconds: Object.entries(artistListeningSeconds)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 25)
        .map(([artist, seconds]) => ({ artist, seconds: Math.round(seconds) })),
      replaysBySong: Object.entries(startsBySong)
        .map(([songKey, count]) => ({ songKey, track: songByKey.get(songKey)?.track || '', artist: songByKey.get(songKey)?.artist || '', plays: count, replays: Math.max(0, count - 1) }))
        .filter(item => item.replays > 0)
        .sort((a, b) => b.replays - a.replays),
    },
    playbackEvents: events,
  };
}

function mergeJob(song, jobBySongKey) {
  if (!song?.songKey) return song;
  const job = jobBySongKey.get(song.songKey) || song.downloadJob || null;
  if (!job) return { ...song, downloadJob: null };
  return {
    ...song,
    sourceUrl: job.sourceUrl || song.sourceUrl || '',
    qualityStatus: job.qualityStatus || song.qualityStatus || '',
    downloadJob: job,
  };
}

function playableStatus(song) {
  if (song?.isDeleted) return 'deleted';
  if (song?.isDownloaded) return 'offline';
  if (song?.isCached || song?.hasBlob) return 'cached';
  if (song?.driveFileId) return 'ready';
  return song?.downloadJob?.status || (song?.isCatalogueOnly ? 'catalogue' : 'missing');
}

function searchCatalogueSongs(searchQuery, catalogueSearchIndex, allSongsByKey, jobBySongKey) {
  if (!searchQuery || searchQuery.length < 2) return [];
  const tokens = normalizeText(searchQuery).split(' ').filter(token => token.length >= 2);
  if (tokens.length === 0) return [];
  let matches = null;
  for (const token of tokens) {
    const keys = catalogueSearchIndex.tokenToKeys.get(token);
    if (!keys) return [];
    matches = matches ? new Set([...matches].filter(key => keys.has(key))) : new Set(keys);
  }
  return [...(matches || [])]
    .map(key => catalogueSearchIndex.byKey.get(key))
    .filter(Boolean)
    .slice(0, 80)
    .map(song => mergeJob(allSongsByKey.get(song.songKey) || song, jobBySongKey));
}

function App() {
  const { isAuthenticated, hasAuthorizedSession, isAuthorizing, isSyncing, syncStatus, error: authError, login, syncLibrary, setupStatus } = useAuth();
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
  const [catalogueLoading, setCatalogueLoading] = useState(false);
  const [driveIndexSongs, setDriveIndexSongs] = useState([]);
  const [driveDeletedSongs, setDriveDeletedSongs] = useState([]);
  const [drivePlaybackEvents, setDrivePlaybackEvents] = useState([]);
  const [driveQuota, setDriveQuota] = useState(null);
  const [showStoragePanel, setShowStoragePanel] = useState(false);
  const [playlistPicker, setPlaylistPicker] = useState(null);
  const [playlistQuery, setPlaylistQuery] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [songInfo, setSongInfo] = useState(null);
  const [reviewSong, setReviewSong] = useState(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [isEqOpen, setIsEqOpen] = useState(false);
  const [recommendationTarget, setRecommendationTarget] = useState(null);
  const [isTasteProfileOpen, setIsTasteProfileOpen] = useState(false);
  const [syncRetryTick, setSyncRetryTick] = useState(0);
  const [hasPendingJobs, setHasPendingJobs] = useState(false);
  const stagedLocalImportKeysRef = useRef(new Set());
  const catalogueLoadStartedRef = useRef(false);
  const fileInputRef = useRef(null);
  const storageDialogRef = useDialogFocus(showStoragePanel, () => setShowStoragePanel(false));
  const playlistDialogRef = useDialogFocus(Boolean(playlistPicker), () => setPlaylistPicker(null), { canClose: !playlistPicker?.busy });

  const playbackRequestRef = useRef(0);
  const countedPlaybackRef = useRef(new Set());
  const autoQueuedSongKeysRef = useRef(new Set());
  const activeQueueSongRef = useRef(null);
  const queueRef = useRef([]);
  const resolvePlayableSongRef = useRef(null);
  const loadAndPlayRef = useRef(null);
  const playNextRef = useRef(null);
  const setPlayerErrorRef = useRef(null);
  const {
    currentSongKey,
    isPlaying,
    loadAndPlay,
    playNext,
    playbackEvent,
    queue,
    queueIndex,
    resumeOnRestore,
    resumePosition,
    setPlayerError,
  } = player;
  const activeQueueSong = queue[queueIndex] || null;
  const activeQueueSongKey = activeQueueSong?.songKey || activeQueueSong?.id || '';
  const queueIndexRef = useRef(queueIndex);
  const resumeOnRestoreRef = useRef(resumeOnRestore);
  const resumePositionRef = useRef(resumePosition);

  useEffect(() => {
    if (![VIEWS.SEARCH, VIEWS.DOWNLOADS].includes(view) || catalogue.length || catalogueLoadStartedRef.current) return undefined;
    let cancelled = false;
    catalogueLoadStartedRef.current = true;
    const loadCatalogue = async () => {
      setCatalogueLoading(true);
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}unique_songs.json`);
        if (!response.ok) throw new Error(`Catalogue request failed: ${response.status}`);
        const data = await response.json();
        if (cancelled) return;
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
      } catch (error) {
        if (!cancelled) console.error('Failed to load search catalogue:', error);
      } finally {
        if (!cancelled) setCatalogueLoading(false);
      }
    };
    const cancel = scheduleIdleWork(loadCatalogue, view === VIEWS.SEARCH ? 150 : 1200);
    return () => {
      cancelled = true;
      cancel();
      if (!catalogue.length) catalogueLoadStartedRef.current = false;
    };
  }, [catalogue.length, view]);

  useEffect(() => {
    queueRef.current = queue;
    queueIndexRef.current = queueIndex;
    activeQueueSongRef.current = activeQueueSong;
    resumeOnRestoreRef.current = resumeOnRestore;
    resumePositionRef.current = resumePosition;
  }, [activeQueueSong, queue, queueIndex, resumeOnRestore, resumePosition]);

  const libraryData = useLiveQuery(getLibrarySnapshot, [], EMPTY_LIBRARY);
  const safeLibraryData = libraryData || EMPTY_LIBRARY;
  const allSongs = safeLibraryData.songs;
  const playlists = safeLibraryData.playlists;
  const localDbError = safeLibraryData.error;
  const importJobs = useMemo(() => safeLibraryData.importJobs || [], [safeLibraryData.importJobs]);
  const embeddingJobs = useMemo(() => safeLibraryData.embeddingJobs || [], [safeLibraryData.embeddingJobs]);
  const syncOutbox = useMemo(() => safeLibraryData.syncOutbox || [], [safeLibraryData.syncOutbox]);
  const playbackEvents = useMemo(() => safeLibraryData.playbackEvents || [], [safeLibraryData.playbackEvents]);

  const runImport = useCallback(async (files = []) => {
    const audioFiles = files.filter(file => file?.name);
    if (!audioFiles.length) {
      addToast('No supported audio files found.');
      return;
    }
    setIsImporting(true);
    try {
      const results = await importAudioFiles(audioFiles, {
        driveService: isAuthenticated && DRIVE_FOLDER_ID ? driveService : null,
        driveFolderId: DRIVE_FOLDER_ID,
      });
      const completed = results.filter(result => result.status === 'complete').length;
      const duplicates = results.filter(result => result.status === 'duplicate').length;
      const failed = results.filter(result => result.status === 'failed').length;
      const driveQueued = results.filter(result => result.driveJob?.jobId).length;
      const localOnly = Math.max(0, completed - driveQueued);
      const driveJobs = results.map(result => result.driveJob).filter(job => job?.jobId);
      if (driveJobs.length) {
        await syncDownloadJobsToDb(driveJobs);
        setHasPendingJobs(true);
      }
      addToast(`Imported ${completed}${driveQueued ? ` · ${driveQueued} queued for Mac upload` : ''}${localOnly ? ` · ${localOnly} local-only` : ''}${duplicates ? ` · ${duplicates} duplicate${duplicates === 1 ? '' : 's'}` : ''}${failed ? ` · ${failed} failed` : ''}`);
    } catch (error) {
      const message = errorMessage(error);
      setActionError(message);
      addToast(`Import failed: ${message}`);
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [addToast, isAuthenticated]);

  const handleImportInput = useCallback(async event => {
    await runImport([...event.target.files]);
  }, [runImport]);

  const handleDrop = useCallback(async event => {
    event.preventDefault();
    const items = event.dataTransfer?.items?.length
      ? [...event.dataTransfer.items]
      : [...(event.dataTransfer?.files || [])];
    const files = await collectAudioFiles(items);
    await runImport(files);
  }, [runImport]);

  useEffect(() => {
    if (!embeddingJobs.length) return undefined;
    let cancelled = false;
    const cancel = scheduleIdleWork(() => {
      if (!cancelled) {
        import('./services/embeddingService.js')
          .then(({ processPendingEmbeddingJobs }) => processPendingEmbeddingJobs({ limit: 2 }))
          .catch(error => console.warn('Embedding queue processing failed:', error));
      }
    }, 1800);
    return () => {
      cancelled = true;
      cancel();
    };
  }, [embeddingJobs]);

  useEffect(() => {
    if (!isAuthenticated) return undefined;
    const retryTimes = syncOutbox
      .filter(item => item.status === 'queued' && item.nextAttemptAt)
      .map(item => Date.parse(item.nextAttemptAt))
      .filter(Number.isFinite);
    if (!retryTimes.length) return undefined;
    const delay = Math.max(1000, Math.min(...retryTimes) - Date.now());
    const timer = window.setTimeout(() => setSyncRetryTick(value => value + 1), delay);
    return () => window.clearTimeout(timer);
  }, [isAuthenticated, syncOutbox]);

  useEffect(() => {
    if (!isAuthenticated || !DRIVE_FOLDER_ID || !driveService.isAuthenticated) return undefined;
    const pending = syncOutbox
      .filter(item => item.status === 'queued' && isSyncRetryReady(item))
      .slice(0, 3);
    if (!pending.length) return undefined;
    let cancelled = false;
    const flushSyncOutbox = async () => {
      for (const operation of pending) {
        if (cancelled) return;
        await updateSyncOutbox(operation.opId, { status: 'processing' });
        try {
          if (operation.entityType === 'playback-event') {
            await driveService.appendPlaybackLog(DRIVE_FOLDER_ID, operation.payload);
          } else {
            await driveService.mutateJsonIndex(DRIVE_FOLDER_ID, 'sisic-imports.json', 'imports', [], imports => {
              const byKey = new Map(imports.filter(item => item.entityKey).map(item => [item.entityKey, item]));
              byKey.set(operation.entityKey, {
                ...operation.payload,
                entityKey: operation.entityKey,
                updatedAt: new Date().toISOString(),
              });
              return [...byKey.values()].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
            });
          }
          await updateSyncOutbox(operation.opId, { status: 'done', error: '' });
          if (operation.entityType === 'song') {
            await updateSongPipelineStatus(operation.entityKey, { syncStatus: 'done' });
          }
        } catch (error) {
          const attempts = Number(operation.attempts || 0) + 1;
          await updateSyncOutbox(operation.opId, {
            status: 'queued',
            attempts,
            error: errorMessage(error),
            nextAttemptAt: new Date(Date.now() + syncRetryDelayMs(attempts)).toISOString(),
          });
          if (operation.entityType === 'song') {
            await updateSongPipelineStatus(operation.entityKey, { syncStatus: 'queued' });
          }
        }
      }
    };
    flushSyncOutbox();
    return () => { cancelled = true; };
  }, [isAuthenticated, syncOutbox, syncRetryTick]);

  const visiblePlaylists = useMemo(() => {
    return playlists.filter(playlist => playlist.playlistKey !== LISTENING_HISTORY_KEY);
  }, [playlists]);

  const visiblePlaylistKeySet = useMemo(() => {
    return new Set(visiblePlaylists.map(playlist => playlist.playlistKey));
  }, [visiblePlaylists]);

  const likedPlaylist = useMemo(() => visiblePlaylists.find(playlist => normalizeText(playlist.name) === 'liked songs'), [visiblePlaylists]);

  const jobBySongKey = useMemo(() => {
    const map = new Map();
    for (const job of safeLibraryData.downloadJobs || []) {
      const previous = map.get(job.songKey);
      if (!previous || String(job.updatedAt || '') > String(previous.updatedAt || '')) map.set(job.songKey, job);
    }
    return map;
  }, [safeLibraryData.downloadJobs]);

  const allSongsByKey = useMemo(() => {
    const byKey = new Map(allSongs.map(song => [song.songKey, mergeJob(song, jobBySongKey)]));
    for (const indexedSong of driveIndexSongs) {
      const normalized = asSongRecord(indexedSong);
      const local = byKey.get(normalized.songKey);
      byKey.set(normalized.songKey, mergeJob({
        ...normalized,
        ...local,
        driveFileId: indexedSong.driveFileId || local?.driveFileId || null,
      }, jobBySongKey));
    }
    return byKey;
  }, [allSongs, driveIndexSongs, jobBySongKey]);

  const topPlayed = useMemo(() => {
    return [...allSongs]
      .filter(song => (song.playCount || 0) > 0)
      .sort((a, b) => (b.playCount || 0) - (a.playCount || 0))
      .slice(0, 8)
      .map(song => mergeJob(allSongsByKey.get(song.songKey) || song, jobBySongKey));
  }, [allSongs, allSongsByKey, jobBySongKey]);

  const driveSongKeySet = useMemo(() => {
    return new Set(driveIndexSongs.filter(song => song.driveFileId).map(song => song.songKey).filter(Boolean));
  }, [driveIndexSongs]);

  const deletedSongKeySet = useMemo(() => {
    return new Set(driveDeletedSongs.map(song => song.songKey).filter(Boolean));
  }, [driveDeletedSongs]);

  const driveReadySongs = useMemo(() => {
    return driveIndexSongs
      .filter(song => song.songKey && song.driveFileId)
      .map(indexedSong => {
        const normalized = asSongRecord({
          ...indexedSong,
          track: indexedSong.track,
          artist: indexedSong.artist,
          driveFileId: indexedSong.driveFileId,
        });
        const local = allSongsByKey.get(normalized.songKey);
        return mergeJob({
          ...normalized,
          ...local,
          driveFileId: indexedSong.driveFileId || local?.driveFileId || null,
        }, jobBySongKey);
      })
      .sort((a, b) => (a.track || '').localeCompare(b.track || ''));
  }, [allSongsByKey, driveIndexSongs, jobBySongKey]);

  const availableSongs = driveReadySongs;

  const catalogueByKey = useMemo(() => new Map(catalogue.map(song => [song.songKey, song])), [catalogue]);

  const downloadQueueSongs = useMemo(() => {
    return [...jobBySongKey.values()]
      .filter(job => job.status === 'queued' || job.status === 'downloading')
      .filter(job => !driveSongKeySet.has(job.songKey) || job.replacementForFileId)
      .map(job => mergeJob(allSongsByKey.get(job.songKey) || catalogueByKey.get(job.songKey) || asSongRecord(job), jobBySongKey))
      .sort((a, b) => String(a.downloadJob?.updatedAt || '').localeCompare(String(b.downloadJob?.updatedAt || '')));
  }, [allSongsByKey, catalogueByKey, driveSongKeySet, jobBySongKey]);

  const manualImportSongs = useMemo(() => {
    return [...jobBySongKey.values()]
      .filter(job => job.status === 'failed' || job.status === 'error' || job.status === 'blocked')
      .filter(job => !driveSongKeySet.has(job.songKey))
      .map(job => mergeJob(allSongsByKey.get(job.songKey) || catalogueByKey.get(job.songKey) || asSongRecord(job), jobBySongKey))
      .sort((a, b) => (a.track || '').localeCompare(b.track || ''));
  }, [allSongsByKey, catalogueByKey, driveSongKeySet, jobBySongKey]);

  const notQueuedSongs = useMemo(() => {
    return allSongs
      .map(song => mergeJob(allSongsByKey.get(song.songKey) || song, jobBySongKey))
      .filter(song => !driveSongKeySet.has(song.songKey))
      .filter(song => !deletedSongKeySet.has(song.songKey))
      .filter(song => !isPlayable(song))
      .filter(song => !song.downloadJob || (song.downloadJob.status === 'done' && !song.downloadJob.uploadedFileId))
      .sort((a, b) => (a.track || '').localeCompare(b.track || ''));
  }, [allSongs, allSongsByKey, deletedSongKeySet, driveSongKeySet, jobBySongKey]);

  const readyFolderSongs = useMemo(() => {
    return driveReadySongs.filter(song => !song.playlistKeys?.some(key => visiblePlaylistKeySet.has(key)));
  }, [driveReadySongs, visiblePlaylistKeySet]);

  const missingRequiredSongs = useMemo(() => {
    return allSongs
      .filter(song => song.playlistKeys?.some(key => visiblePlaylistKeySet.has(key)))
      .filter(song => !driveSongKeySet.has(song.songKey))
      .filter(song => !deletedSongKeySet.has(song.songKey));
  }, [allSongs, deletedSongKeySet, driveSongKeySet, visiblePlaylistKeySet]);

  const deletedRequiredSongs = useMemo(() => {
    return allSongs
      .filter(song => song.playlistKeys?.some(key => visiblePlaylistKeySet.has(key)))
      .filter(song => deletedSongKeySet.has(song.songKey));
  }, [allSongs, deletedSongKeySet, visiblePlaylistKeySet]);

  const driveFolderUsedBytes = useMemo(() => {
    return driveIndexSongs.reduce((sum, song) => sum + (Number(song.size) || 0), 0);
  }, [driveIndexSongs]);

  const largestReadySongs = useMemo(() => {
    return [...driveReadySongs]
      .sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0))
      .slice(0, 8);
  }, [driveReadySongs]);

  const librarySummary = useMemo(() => ({
    totalSongs: allSongs.length,
    readySongs: driveReadySongs.length,
    downloadedSongs: allSongs.filter(s => s.isDownloaded).length,
    playlistCount: visiblePlaylists.length,
  }), [allSongs, driveReadySongs.length, visiblePlaylists.length]);

  const catalogueSearchIndex = useMemo(() => {
    const byKey = new Map();
    const tokenToKeys = new Map();
    for (const song of catalogue) {
      byKey.set(song.songKey, song);
      const tokens = new Set(normalizeText(`${song.artist} ${song.track}`).split(' ').filter(token => token.length >= 2));
      for (const token of tokens) {
        const prefixes = new Set([token]);
        for (let length = 2; length <= Math.min(6, token.length); length++) prefixes.add(token.slice(0, length));
        for (const prefix of prefixes) {
          if (!tokenToKeys.has(prefix)) tokenToKeys.set(prefix, new Set());
          tokenToKeys.get(prefix).add(song.songKey);
        }
      }
    }
    return { byKey, tokenToKeys };
  }, [catalogue]);

  const searchResults = useMemo(() => {
    return searchCatalogueSongs(searchQuery, catalogueSearchIndex, allSongsByKey, jobBySongKey);
  }, [allSongsByKey, catalogueSearchIndex, jobBySongKey, searchQuery]);

  const selectedPlaylist = useMemo(() => {
    return visiblePlaylists.find(playlist => playlist.playlistKey === selectedPlaylistKey) || null;
  }, [visiblePlaylists, selectedPlaylistKey]);

  const librarySongs = useMemo(() => {
    if (!selectedPlaylistKey) return driveReadySongs;
    return allSongs
      .filter(song => song.playlistKeys?.includes(selectedPlaylistKey))
      .map(song => mergeJob(allSongsByKey.get(song.songKey) || song, jobBySongKey));
  }, [allSongs, allSongsByKey, driveReadySongs, selectedPlaylistKey, jobBySongKey]);

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
    if (!isAuthenticated || !DRIVE_FOLDER_ID || !driveService.isAuthenticated) return undefined;
    const candidates = allSongs.filter(song => (
      song.sourceType === 'local-import'
      && !song.driveFileId
      && !song.driveImportJobId
      && !stagedLocalImportKeysRef.current.has(song.songKey)
    ));
    if (!candidates.length) return undefined;
    let cancelled = false;
    candidates.forEach(song => stagedLocalImportKeysRef.current.add(song.songKey));
    const stageImports = async () => {
      try {
        const results = await queueCachedLocalImports(candidates, { driveService, driveFolderId: DRIVE_FOLDER_ID });
        if (cancelled || !results.length) return;
        const jobs = results.map(result => result.job).filter(job => job?.jobId);
        await syncDownloadJobsToDb(jobs);
        setHasPendingJobs(jobs.some(job => job.status === 'queued' || job.status === 'downloading'));
        const newlyQueued = results.filter(result => !result.existing).length;
        if (newlyQueued) addToast(`Queued ${newlyQueued} existing import${newlyQueued === 1 ? '' : 's'} for Mac upload`);
      } catch (error) {
        candidates.forEach(song => stagedLocalImportKeysRef.current.delete(song.songKey));
        console.error('Failed to stage cached local imports:', error);
      }
    };
    const cancel = scheduleIdleWork(stageImports, 1800);
    return () => {
      cancelled = true;
      cancel();
    };
  }, [addToast, allSongs, isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated || !DRIVE_FOLDER_ID || !driveService.isAuthenticated) return undefined;
    let cancelled = false;

    const loadIndexes = async () => {
      try {
        const result = await driveService.loadDriveIndexes(DRIVE_FOLDER_ID);
        if (cancelled) return;
        setDriveIndexSongs(result.songs || []);
        setDriveDeletedSongs(result.deleted || []);
        setDrivePlaybackEvents(result.playbackEvents || []);
        setDriveQuota(result.quota || null);
        await syncDownloadJobsToDb(result.jobs || []);
        await syncPlaylistIndexToDb(result.playlists || []);
        setHasPendingJobs((result.jobs || []).some(job => job.status === 'queued' || job.status === 'downloading'));
      } catch (error) {
        console.error('Drive index load failed:', error);
      }
    };

    const cancel = scheduleIdleWork(loadIndexes, 1800);
    return () => {
      cancelled = true;
      cancel();
    };
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated || !hasPendingJobs) return undefined;
    const interval = window.setInterval(refreshDownloadJobs, isPlaying ? 60000 : 20000);
    return () => {
      window.clearInterval(interval);
    };
  }, [isAuthenticated, refreshDownloadJobs, hasPendingJobs, isPlaying]);

  const queueSongForDownload = useCallback(async (song, options = {}) => {
    if (!DRIVE_FOLDER_ID) throw new Error('Missing required config: VITE_DRIVE_FOLDER_ID.');
    const result = await driveService.requestSongDownload(song, DRIVE_FOLDER_ID, '', options);
    if (result.job) {
      await syncDownloadJobsToDb([result.job]);
      if (!result.blocked) setHasPendingJobs(true); // Start polling to track this job
    }
    return result;
  }, []);

  const queueSongReplacement = useCallback(async (song, sourceUrl = '', reviewAction = 'reject-video') => {
    if (!DRIVE_FOLDER_ID) throw new Error('Missing required config: VITE_DRIVE_FOLDER_ID.');
    const result = await driveService.requestSongDownload(song, DRIVE_FOLDER_ID, sourceUrl, {
      allowRedownload: true,
      replaceExisting: true,
      replacementForFileId: song.driveFileId || '',
      reviewAction,
    });
    if (result.job) {
      await syncDownloadJobsToDb([result.job]);
      setHasPendingJobs(true);
    }
    return result;
  }, []);

  const handleQueueDownload = useCallback(async (song, { allowRedownload = false } = {}) => {
    try {
      const result = await queueSongForDownload(song, { allowRedownload });
      if (result.blocked) {
        addToast(`"${song.track}" is blocked by deleted history.`);
      } else if (result.queued) {
        addToast(`Queued "${song.track}" for the Mac worker`);
      } else {
        addToast(`"${song.track}" is already ${result.job?.status || 'queued'}`);
      }
    } catch (error) {
      const message = errorMessage(error);
      setActionError(message);
      addToast(message);
    }
  }, [addToast, queueSongForDownload]);

  const handleApproveSongReview = useCallback(async song => {
    if (!DRIVE_FOLDER_ID) return;
    setReviewBusy(true);
    try {
      const updated = await driveService.updateSongReview(DRIVE_FOLDER_ID, song, 'approved-studio');
      setDriveIndexSongs(prev => prev.map(item => item.songKey === song.songKey ? { ...item, ...updated } : item));
      setReviewSong(prev => prev ? { ...prev, ...updated } : prev);
      addToast(`Marked "${song.track}" as the correct studio song`);
    } catch (error) {
      const message = errorMessage(error);
      setActionError(message);
      addToast(message);
    } finally {
      setReviewBusy(false);
    }
  }, [addToast]);

  const handleRetryStudioReview = useCallback(async song => {
    setReviewBusy(true);
    try {
      const result = await queueSongReplacement(song);
      if (result.queued) {
        addToast(`Queued a studio replacement for "${song.track}"`);
        setReviewSong(null);
      } else {
        addToast(`Replacement is already ${result.job?.status || 'queued'}`);
      }
    } catch (error) {
      const message = errorMessage(error);
      setActionError(message);
      addToast(message);
    } finally {
      setReviewBusy(false);
    }
  }, [addToast, queueSongReplacement]);

  const handleYoutubeReplacement = useCallback(async (song, sourceUrl) => {
    let parsed;
    try {
      parsed = new URL(sourceUrl.trim());
    } catch {
      addToast('Enter a valid YouTube URL.');
      return;
    }
    if (!['youtube.com', 'www.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be'].includes(parsed.hostname.toLowerCase())) {
      addToast('The replacement link must be from YouTube.');
      return;
    }
    setReviewBusy(true);
    try {
      const result = await queueSongReplacement(song, parsed.toString(), 'explicit-youtube-link');
      if (result.queued) {
        addToast(`Queued the YouTube replacement for "${song.track}"`);
        setReviewSong(null);
      } else {
        addToast(`Replacement is already ${result.job?.status || 'queued'}`);
      }
    } catch (error) {
      const message = errorMessage(error);
      setActionError(message);
      addToast(message);
    } finally {
      setReviewBusy(false);
    }
  }, [addToast, queueSongReplacement]);

  useEffect(() => {
    if (!isAuthenticated || !DRIVE_FOLDER_ID || !driveService.isAuthenticated || missingRequiredSongs.length === 0) return undefined;
    let cancelled = false;

    const enqueueMissingPlaylistSongs = async () => {
      const candidates = missingRequiredSongs
        .filter(song => {
          if (autoQueuedSongKeysRef.current.has(song.songKey)) return false;
          const job = jobBySongKey.get(song.songKey);
          return !['queued', 'downloading', 'done', 'blocked'].includes(job?.status);
        })
        .slice(0, isPlaying ? Math.min(5, AUTO_QUEUE_LIMIT) : AUTO_QUEUE_LIMIT);

      if (candidates.length === 0) return;
      let queuedCount = 0;
      for (const song of candidates) {
        if (cancelled) return;
        autoQueuedSongKeysRef.current.add(song.songKey);
        try {
          const result = await queueSongForDownload(song, { auto: true });
          if (result.queued) queuedCount++;
        } catch (error) {
          console.error('Playlist readiness queue failed:', song.songKey, error);
        }
      }
      if (!cancelled && queuedCount > 0) {
        addToast(`Queued ${queuedCount} missing playlist song${queuedCount === 1 ? '' : 's'}`);
      }
    };

    const cancel = scheduleIdleWork(enqueueMissingPlaylistSongs, 2200);
    return () => {
      cancelled = true;
      cancel();
    };
  }, [addToast, isAuthenticated, isPlaying, jobBySongKey, missingRequiredSongs, queueSongForDownload]);

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
        if (found.similarity?.confidence === 'medium') {
          const confirmed = window.confirm(
            `Use this Drive file for "${resolved.track}" by ${resolved.artist}?\n\nMatched file: ${found.name}\nConfidence: ${(found.similarity.score * 100).toFixed(0)}%`
          );
          if (!confirmed) return null;
        }
        if (found.similarity?.confidence && found.similarity.confidence !== 'exact') {
          await driveService.confirmSongIndexMatch(DRIVE_FOLDER_ID, resolved, found);
        }
        await markSongPlayable(resolved.songKey, found.id);
        setDriveIndexSongs(prev => {
          if (prev.some(item => item.songKey === resolved.songKey)) return prev;
          return [...prev, {
            songKey: resolved.songKey,
            artist: resolved.artist,
            track: resolved.track,
            album: resolved.album || '',
            driveFileId: found.id,
            filename: found.name,
            mimeType: found.mimeType || 'audio/mpeg',
            size: Number(found.size || 0),
            updatedAt: new Date().toISOString(),
          }];
        });
        return { ...resolved, driveFileId: found.id };
      }
    }

    if (queueIfMissing) {
      const result = await queueSongForDownload(resolved);
      const status = result.job?.status || 'queued';
      if (showToast) {
        addToast(result.blocked
          ? `"${resolved.track}" was previously deleted. Use Download to restore it.`
          : result.queued
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
    if (!isAuthenticated || !activeQueueSongKey) return undefined;
    const song = activeQueueSongRef.current;
    if (!song) return undefined;

    const requestId = ++playbackRequestRef.current;
    let cancelled = false;

    const playSong = async () => {
      try {
        const resolved = await resolvePlayableSongRef.current(song, { queueIfMissing: true, showToast: false });
        if (cancelled || requestId !== playbackRequestRef.current) return;
        if (resolved) {
          await loadAndPlayRef.current(resolved, driveService.accessToken, {
            autoplay: resumeOnRestoreRef.current,
            startAt: resumePositionRef.current,
          });
          return;
        }
        setPlayerErrorRef.current(`"${song.track}" is queued for download.`);
        if (queueRef.current.some((candidate, index) => index !== queueIndexRef.current && isPlayable(candidate))) {
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
  }, [activeQueueSongKey, isAuthenticated]);

  useEffect(() => {
    if (!currentSongKey || !isPlaying) return;
    if (countedPlaybackRef.current.has(currentSongKey)) return;
    countedPlaybackRef.current.add(currentSongKey);
    touchSongPlayed(currentSongKey).catch(error => console.error('Play count update failed:', error));
  }, [currentSongKey, isPlaying]);

  useEffect(() => {
    if (!playbackEvent) return;
    if (playbackEvent.eventType === 'unexpected-playback-skip' || playbackEvent.eventType === 'playback-short-ended') {
      console.warn('Playback anomaly:', playbackEvent);
    }
    const syncPlaybackEvent = async () => {
      await recordPlaybackEvent(playbackEvent);
      if (!isAuthenticated || !DRIVE_FOLDER_ID || !driveService.isAuthenticated) {
        await enqueueSyncOutbox({
          entityType: 'playback-event',
          entityKey: playbackEvent.id,
          payload: playbackEvent,
        });
        return;
      }
      try {
        await driveService.appendPlaybackLog(DRIVE_FOLDER_ID, playbackEvent);
      } catch (error) {
        await enqueueSyncOutbox({
          entityType: 'playback-event',
          entityKey: playbackEvent.id,
          payload: playbackEvent,
          error: errorMessage(error),
        });
        console.warn('Playback log write failed; queued for retry:', error);
      }
    };
    syncPlaybackEvent().catch(error => console.warn('Playback telemetry queue failed:', error));
  }, [isAuthenticated, playbackEvent]);

  const handleExportData = useCallback(() => {
    const exportData = buildAnalyticsExport({
      songs: allSongs,
      playlists,
      downloadJobs: safeLibraryData.downloadJobs || [],
      importJobs,
      embeddingJobs,
      playbackEvents,
      drivePlaybackEvents,
      syncOutbox,
    });
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `sisic-music-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    addToast(`Exported ${exportData.songs.length} songs and ${exportData.playbackEvents.length} playback events`);
  }, [addToast, allSongs, drivePlaybackEvents, embeddingJobs, importJobs, playbackEvents, playlists, safeLibraryData.downloadJobs, syncOutbox]);

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

      if (player.currentSong) {
        const queuedSong = mergeJob(allSongsByKey.get(selectedKey) || sourceSongs[startIdx] || song, jobBySongKey);
        player.enqueueNext(queuedSong);
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
        // Artwork is an explicit-download dependency: store bytes for offline
        // use, while ordinary browsing can continue using remote artwork URLs.
        import('./services/artworkService.js')
          .then(({ cacheSongArtwork }) => cacheSongArtwork(localSong))
          .catch(error => console.debug('Offline artwork cache skipped:', error));
        if (deletedSongKeySet.has(localSong.songKey)) {
          await driveService.removeDeletedSong(DRIVE_FOLDER_ID, localSong);
          setDriveDeletedSongs(prev => prev.filter(item => item.songKey !== localSong.songKey));
        }
        addToast(`"${localSong.track}" saved for offline`);
      } else {
        const result = await queueSongForDownload(localSong, { allowRedownload: true });
        setDriveDeletedSongs(prev => prev.filter(item => item.songKey !== localSong.songKey));
        addToast(result.blocked
          ? `"${localSong.track}" is blocked by deleted history`
          : result.queued
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
  }, [addToast, deletedSongKeySet, downloadingKeys, ensureLocalSong, queueSongForDownload]);

  const persistPlaylistIndex = useCallback(async () => {
    if (!DRIVE_FOLDER_ID || !driveService.isAuthenticated) return;
    const playlistsForDrive = await getPlaylistSnapshotForDrive({
      excludePlaylistKeys: [LISTENING_HISTORY_KEY],
    });
    await driveService.writePlaylistIndex(DRIVE_FOLDER_ID, playlistsForDrive);
  }, []);

  const openPlaylistPicker = useCallback((song) => {
    setPlaylistQuery('');
    setPlaylistPicker({
      song,
      selectedKeys: [],
      newPlaylistName: '',
      busy: false,
    });
  }, []);

  const pickerPlaylists = useMemo(() => {
    const query = normalizeText(playlistQuery);
    return query ? visiblePlaylists.filter(playlist => normalizeText(playlist.name).includes(query)) : visiblePlaylists;
  }, [playlistQuery, visiblePlaylists]);

  const handlePlaylistPickerConfirm = useCallback(async () => {
    if (!playlistPicker?.song) return;
    const selectedNames = visiblePlaylists
      .filter(playlist => playlistPicker.selectedKeys.includes(playlist.playlistKey))
      .map(playlist => playlist.name);
    const newName = playlistPicker.newPlaylistName.trim();
    const targetNames = [...selectedNames, ...(newName ? [newName] : [])];

    if (targetNames.length === 0) {
      addToast('Choose at least one playlist');
      return;
    }

    setPlaylistPicker(prev => prev ? { ...prev, busy: true } : prev);
    try {
      const localSong = await ensureLocalSong(playlistPicker.song, '');
      for (const playlistName of targetNames) {
        await addSongToPlaylist(localSong, playlistName, 'sisic');
      }
      await persistPlaylistIndex();
      if (!localSong.driveFileId && !driveSongKeySet.has(localSong.songKey)) {
        const result = await queueSongForDownload(localSong, { allowRedownload: deletedSongKeySet.has(localSong.songKey) });
        if (result.queued) addToast(`Queued "${localSong.track}" for download`);
      }
      setPlaylistPicker(null);
      addToast(`Added "${localSong.track}" to ${targetNames.length} playlist${targetNames.length === 1 ? '' : 's'}`);
    } catch (error) {
      console.error('Playlist update failed:', error);
      const message = errorMessage(error);
      setActionError(message);
      addToast(message);
      setPlaylistPicker(prev => prev ? { ...prev, busy: false } : prev);
    }
  }, [
    addToast,
    deletedSongKeySet,
    driveSongKeySet,
    ensureLocalSong,
    persistPlaylistIndex,
    playlistPicker,
    queueSongForDownload,
    visiblePlaylists,
  ]);

  const handleToggleLike = useCallback(async song => {
    const localSong = await ensureLocalSong(song, 'Liked Songs');
    const existingLiked = likedPlaylist && song.playlistKeys?.includes(likedPlaylist.playlistKey);
    if (existingLiked) {
      await removeSongFromPlaylist(localSong.songKey, likedPlaylist.playlistKey);
      await persistPlaylistIndex();
      addToast(`Removed "${localSong.track}" from liked songs`);
    } else {
      await addSongToPlaylist(localSong, 'Liked Songs', 'sisic');
      await persistPlaylistIndex();
      addToast(`Liked "${localSong.track}"`);
    }
  }, [addToast, ensureLocalSong, likedPlaylist, persistPlaylistIndex]);

  const handleDeleteReadySong = useCallback(async (song) => {
    if (!DRIVE_FOLDER_ID) {
      setActionError('Missing required config: VITE_DRIVE_FOLDER_ID.');
      return;
    }
    const confirmed = window.confirm(`Delete "${song.track}" from Drive and keep it in deleted history?`);
    if (!confirmed) return;

    try {
      const deletedEntry = await driveService.deleteReadySong(DRIVE_FOLDER_ID, song);
      await clearSongPlayable(song.songKey);
      setDriveIndexSongs(prev => prev.filter(item => item.songKey !== song.songKey && item.driveFileId !== song.driveFileId));
      setDriveDeletedSongs(prev => {
        const next = prev.filter(item => item.songKey !== deletedEntry.songKey);
        return [deletedEntry, ...next];
      });
      if (player.currentSongKey === song.songKey) player.stop();
      addToast(`Deleted "${song.track}" from Drive`);
    } catch (error) {
      console.error('Ready delete failed:', error);
      const message = errorMessage(error);
      setActionError(message);
      addToast(message);
    }
  }, [addToast, player]);

  const handleReconcileDriveIndex = useCallback(async () => {
    if (!DRIVE_FOLDER_ID) return;
    try {
      const result = await driveService.syncSongIndex(DRIVE_FOLDER_ID);
      setDriveIndexSongs(result.songs || []);
      addToast(`Reconciled ${result.songs?.length || 0} Drive songs`);
    } catch (error) {
      console.error('Drive reconciliation failed:', error);
      const message = errorMessage(error);
      setActionError(message);
      addToast(message);
    }
  }, [addToast]);

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

  if (!isAuthenticated && !hasAuthorizedSession) {
    return <LoginScreen onLogin={login} error={authError} busy={isAuthorizing} setupStatus={setupStatus} />;
  }

  const bannerError = authError || actionError || player.error || localDbError;
  const bannerStatus = bannerError || syncStatus;
  const effectivePageLimit = view === VIEWS.LIBRARY ? pageLimit : PAGE_SIZE;

  const navItems = [
    { id: VIEWS.HOME, icon: Home, label: 'Home' },
    { id: VIEWS.SEARCH, icon: Search, label: 'Search' },
    { id: VIEWS.LIBRARY, icon: Library, label: 'Ready' },
    { id: VIEWS.DOWNLOADS, icon: HardDriveDownload, label: 'Downloads' },
    { id: VIEWS.CONSTELLATION, icon: Sparkles, label: 'Galaxy' },
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
      song={{ ...song, isDeleted: deletedSongKeySet.has(song.songKey), status: playableStatus({ ...song, isDeleted: deletedSongKeySet.has(song.songKey) }) }}
      onPlay={(selected) => handlePlaySong(selected, list)}
      onDownload={handleDownload}
      onAddToQueue={(selected) => { player.addToQueue(selected); addToast(`Added "${selected.track}" to queue`); }}
      onPlayNext={(selected) => { player.enqueueNext(selected); addToast(`Playing "${selected.track}" next`); }}
      onAddToPlaylist={openPlaylistPicker}
      onToggleLike={handleToggleLike}
      isLiked={Boolean(likedPlaylist && song.playlistKeys?.includes(likedPlaylist.playlistKey))}
      onReview={setReviewSong}
      onInfo={setSongInfo}
      onMoreLikeThis={(selected) => setRecommendationTarget(selected)}
      onDeleteReady={!selectedPlaylistKey && view === VIEWS.LIBRARY ? handleDeleteReadySong : undefined}
      isReadyLoose={!selectedPlaylistKey && view === VIEWS.LIBRARY}
      isCurrentSong={player.currentSongKey === song.songKey}
      isDownloading={downloadingKeys.has(song.songKey)}
    />
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button
          type="button"
          className="sidebar__logo"
          onClick={() => { setView(VIEWS.HOME); setSelectedPlaylistKey(null); setSearchQuery(''); setPageLimit(PAGE_SIZE); }}
          aria-label="Go to Sisic Music home"
        >
          <span>♪</span> Sisic Music
        </button>

        <nav className="sidebar__nav" aria-label="Main navigation">
          {navItems.map(item => (
            <button
              key={item.id}
              className={`sidebar__nav-item ${view === item.id ? 'sidebar__nav-item--active' : ''}`}
              onClick={() => { setView(item.id); setSelectedPlaylistKey(null); setSearchQuery(''); setPageLimit(PAGE_SIZE); }}
              aria-current={view === item.id ? 'page' : undefined}
            >
              <item.icon size={20} />
              {item.label}
            </button>
          ))}
          <button
            className="sidebar__nav-item"
            onClick={() => setIsTasteProfileOpen(true)}
            aria-label="View personal taste profile"
          >
            <Compass size={20} />
            Taste Profile
          </button>
          <button
            className="sidebar__nav-item"
            onClick={() => setIsEqOpen(true)}
            aria-label="Open audio equalizer"
          >
            <Sliders size={20} />
            Equalizer
          </button>
        </nav>

        <button className="sidebar__import-btn" onClick={() => fileInputRef.current?.click()} disabled={isImporting}>
          <FolderOpen size={18} />
          {isImporting ? 'Importing…' : 'Import music'}
        </button>
        <input
          ref={fileInputRef}
          className="import-input"
          type="file"
          accept="audio/*,.aac,.aiff,.flac,.m4a,.mp3,.ogg,.opus,.wav"
          multiple
          onChange={handleImportInput}
        />

        {visiblePlaylists.length > 0 && (
          <div className="sidebar__playlists">
            <div className="sidebar__section-label">Playlists</div>
            <div className="sidebar__playlist-list">
              {visiblePlaylists.map(playlist => (
                <button
                  key={playlist.playlistKey}
                  className={`playlist-item ${selectedPlaylistKey === playlist.playlistKey ? 'playlist-item--active' : ''}`}
                  onClick={() => { setSelectedPlaylistKey(playlist.playlistKey); setView(VIEWS.LIBRARY); setPageLimit(PAGE_SIZE); }}
                >
                  {playlist.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </aside>

      <main className="main-view" onDragOver={event => event.preventDefault()} onDrop={handleDrop}>
        <SyncBanner
          isSyncing={isSyncing}
          syncStatus={bannerStatus}
          error={Boolean(bannerError)}
          onSync={syncLibrary}
          actionLabel={!isAuthenticated ? 'Reconnect Drive' : localDbError ? 'Reset local cache' : ''}
          onAction={!isAuthenticated ? login : localDbError ? handleResetLocalCache : undefined}
          actionDisabled={isAuthorizing}
        />
        <ImportStatusPanel jobs={importJobs} embeddingJobs={embeddingJobs} />

        <section className="drive-summary" aria-label="Drive storage summary">
          <div>
            <span className="drive-summary__label">Drive folder</span>
            <strong>{formatBytes(driveFolderUsedBytes)}</strong>
          </div>
          <div>
            <span className="drive-summary__label">Ready</span>
            <strong>{driveReadySongs.length.toLocaleString()} songs</strong>
          </div>
          <div className={missingRequiredSongs.length > 0 ? 'drive-summary__warn' : ''}>
            <span className="drive-summary__label">Playlist coverage</span>
            <strong>{missingRequiredSongs.length.toLocaleString()} missing</strong>
          </div>
          <div className={deletedRequiredSongs.length > 0 ? 'drive-summary__warn' : ''}>
            <span className="drive-summary__label">Deleted history</span>
            <strong>{driveDeletedSongs.length.toLocaleString()} songs</strong>
          </div>
          <div>
            <span className="drive-summary__label">Account free</span>
            <strong>{driveQuota?.limitBytes > 0 ? formatBytes(Math.max(0, driveQuota.limitBytes - driveQuota.usageBytes)) : '—'}</strong>
          </div>
          <button className="drive-summary__button" onClick={() => setShowStoragePanel(true)}>
            <BarChart3 size={16} />
            <span>Storage</span>
          </button>
          <button className="drive-summary__button" onClick={handleExportData} title="Export songs, playlists, metrics, and playback history">
            <FileDown size={16} />
            <span>Export</span>
          </button>
        </section>

        {view === VIEWS.HOME && (
          <>
            <header className="main-view__header">
              <h1 className="main-view__title">{currentGreeting()}</h1>
            </header>

            {visiblePlaylists.length > 0 && (
              <section className="home-section">
                <h2 className="home-section__title">Your Playlists</h2>
                <div className="playlist-grid">
                  {visiblePlaylists.slice(0, 12).map(playlist => {
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

        {view === VIEWS.DOWNLOADS && (
          <>
            <header className="main-view__header">
              <h1 className="main-view__title">Downloads</h1>
            </header>
            <DownloadStatusPanel
              readyCount={driveReadySongs.length}
              queuedSongs={downloadQueueSongs}
              manualSongs={manualImportSongs}
              notQueuedSongs={notQueuedSongs}
              onRetry={song => handleQueueDownload(song, { allowRedownload: true })}
              onQueue={song => handleQueueDownload(song)}
              onImport={() => fileInputRef.current?.click()}
            />
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
                <p>{catalogueLoading ? 'Loading your searchable catalogue…' : `Find any of your ${catalogue.length.toLocaleString()} songs by name or artist`}</p>
              </div>
            ) : catalogueLoading ? (
              <div className="empty-state" role="status">
                <Search size={48} color="var(--text-muted)" />
                <h3>Loading catalogue</h3>
                <p>Preparing search results…</p>
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
              <h1 className="main-view__title">{selectedPlaylist?.name || 'Ready'}</h1>
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
                  <p>{selectedPlaylist ? 'This playlist is empty' : 'No Drive-ready songs yet'}</p>
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

        {view === VIEWS.CONSTELLATION && (
          <Suspense fallback={<div className="view-loading" role="status">Loading music clusters…</div>}>
            <ConstellationView
              songs={allSongs}
              currentSong={player.currentSong}
              onPlaySong={(song) => handlePlaySong(song, allSongs)}
              onAddToQueue={(song) => { player.addToQueue(song); addToast(`Added "${song.track}" to queue`); }}
            />
          </Suspense>
        )}
      </main>

      {showStoragePanel && (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowStoragePanel(false)}>
          <section ref={storageDialogRef} className="storage-panel" role="dialog" aria-modal="true" aria-label="Storage dashboard" tabIndex={-1} onClick={event => event.stopPropagation()}>
            <div className="panel-header">
              <h2>Storage</h2>
              <button data-dialog-autofocus className="icon-btn" onClick={() => setShowStoragePanel(false)} aria-label="Close storage dashboard">
                <X size={18} />
              </button>
            </div>
            <div className="storage-metrics">
              <div><span>Folder used</span><strong>{formatBytes(driveFolderUsedBytes)}</strong></div>
              <div><span>Account used</span><strong>{formatBytes(driveQuota?.usageBytes || 0)}</strong></div>
              <div><span>Account free</span><strong>{driveQuota?.limitBytes ? formatBytes(Math.max(0, driveQuota.limitBytes - driveQuota.usageBytes)) : 'Unknown'}</strong></div>
              <div><span>Ready loose</span><strong>{readyFolderSongs.length.toLocaleString()}</strong></div>
              <div><span>Missing playlists</span><strong>{missingRequiredSongs.length.toLocaleString()}</strong></div>
              <div><span>Deleted blocked</span><strong>{deletedRequiredSongs.length.toLocaleString()}</strong></div>
            </div>
            <div className="panel-actions">
              <button className="panel-action-btn" onClick={handleReconcileDriveIndex}>
                <RefreshCw size={16} />
                <span>Reconcile</span>
              </button>
              <button className="panel-action-btn" onClick={handleExportData}>
                <FileDown size={16} />
                <span>Export full data</span>
              </button>
            </div>
            {largestReadySongs.length > 0 && (
              <div className="storage-list">
                <h3>Largest Ready Songs</h3>
                {largestReadySongs.map(song => (
                  <button key={song.songKey} type="button" className="storage-list__row" onClick={() => setSongInfo(song)}>
                    <span>{song.track}<small>{song.artist}</small></span>
                    <em>{formatBytes(song.size)}</em>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {playlistPicker && (
        <div className="modal-backdrop" role="presentation" onClick={() => !playlistPicker.busy && setPlaylistPicker(null)}>
          <section ref={playlistDialogRef} className="playlist-picker" role="dialog" aria-modal="true" aria-label="Choose playlist" tabIndex={-1} onClick={event => event.stopPropagation()}>
            <div className="panel-header">
              <div>
                <span className="playlist-picker__eyebrow">Organize your library</span>
                <h2>Add to playlist</h2>
              </div>
              <button data-dialog-autofocus className="icon-btn" onClick={() => setPlaylistPicker(null)} aria-label="Close playlist picker" disabled={playlistPicker.busy}>
                <X size={18} />
              </button>
            </div>
            <div className="playlist-picker__song">
              <AsyncArtworkImage song={playlistPicker.song} className="playlist-picker__song-art" fallbackSize={18} size={100} sizes="52px" />
              <div>
                <strong>{playlistPicker.song.track}</strong>
                <span>{playlistPicker.song.artist}</span>
              </div>
            </div>
            <div className="playlist-picker__toolbar">
              <input
                className="playlist-picker__search"
                type="search"
                placeholder="Find a playlist"
                value={playlistQuery}
                onChange={event => setPlaylistQuery(event.target.value)}
                disabled={playlistPicker.busy}
                aria-label="Find a playlist"
              />
              <span>{playlistPicker.selectedKeys.length} selected</span>
            </div>
            <div className="playlist-picker__bulk-actions">
              <button type="button" onClick={() => setPlaylistPicker(prev => prev ? { ...prev, selectedKeys: [...new Set([...prev.selectedKeys, ...pickerPlaylists.map(item => item.playlistKey)])] } : prev)} disabled={playlistPicker.busy || pickerPlaylists.length === 0}>Select visible</button>
              <button type="button" onClick={() => setPlaylistPicker(prev => prev ? { ...prev, selectedKeys: [] } : prev)} disabled={playlistPicker.busy || playlistPicker.selectedKeys.length === 0}>Clear</button>
            </div>
            <div className="playlist-picker__list">
              {pickerPlaylists.map(playlist => (
                <label key={playlist.playlistKey} className="playlist-picker__option">
                  <input
                    type="checkbox"
                    checked={playlistPicker.selectedKeys.includes(playlist.playlistKey)}
                    onChange={event => {
                      setPlaylistPicker(prev => {
                        if (!prev) return prev;
                        const selected = new Set(prev.selectedKeys);
                        if (event.target.checked) selected.add(playlist.playlistKey);
                        else selected.delete(playlist.playlistKey);
                        return { ...prev, selectedKeys: [...selected] };
                      });
                    }}
                  />
                  <span>{playlist.name}</span>
                </label>
              ))}
              {pickerPlaylists.length === 0 && <p className="playlist-picker__empty">No matching playlists. Create one below.</p>}
            </div>
            <input
              className="playlist-picker__new"
              type="text"
              placeholder="Create a new playlist"
              value={playlistPicker.newPlaylistName}
              onChange={event => setPlaylistPicker(prev => prev ? { ...prev, newPlaylistName: event.target.value } : prev)}
              disabled={playlistPicker.busy}
            />
            <button className="btn-primary playlist-picker__save" onClick={handlePlaylistPickerConfirm} disabled={playlistPicker.busy}>
              {playlistPicker.busy ? 'Saving...' : `Save${playlistPicker.selectedKeys.length ? ` · ${playlistPicker.selectedKeys.length}` : ''}`}
            </button>
          </section>
        </div>
      )}

      {showQueue && (
        <Suspense fallback={<div className="queue-loading" role="status">Loading queue…</div>}>
          <QueuePanel player={player} jobBySongKey={jobBySongKey} onClose={() => setShowQueue(false)} onRetry={handleDownload} />
        </Suspense>
      )}
      {songInfo && (
        <SongInfoPanel
          song={songInfo}
          onClose={() => setSongInfo(null)}
          onPlay={song => handlePlaySong(song, [song])}
          onPlayNext={song => { player.enqueueNext(song); addToast(`Playing "${song.track}" next`); }}
          onAddToQueue={song => { player.addToQueue(song); addToast(`Added "${song.track}" to queue`); }}
          onAddToPlaylist={openPlaylistPicker}
          onReview={song => { setSongInfo(null); setReviewSong(song); }}
          onDelete={handleDeleteReadySong}
          onDownload={handleDownload}
          isDownloading={downloadingKeys.has(songInfo.songKey)}
        />
      )}
      {reviewSong && (
        <SongReviewPanel
          song={reviewSong}
          onClose={() => setReviewSong(null)}
          onApprove={handleApproveSongReview}
          onRetryStudio={handleRetryStudioReview}
          onUseYoutubeLink={handleYoutubeReplacement}
          busy={reviewBusy}
        />
      )}
      <PlayerBar
        player={player}
        onToggleQueue={() => setShowQueue(open => !open)}
        onOpenSongInfo={setSongInfo}
        onAddToPlaylist={openPlaylistPicker}
        onDelete={handleDeleteReadySong}
        onReview={setReviewSong}
        onDownload={handleDownload}
        onPlayNext={song => { player.enqueueNext(song); addToast(`Playing "${song.track}" next`); }}
        onAddToQueue={song => { player.addToQueue(song); addToast(`Added "${song.track}" to queue`); }}
        onOpenEqualizer={() => setIsEqOpen(true)}
        onMoreLikeThis={song => setRecommendationTarget(song)}
      />
      <ToastContainer toasts={toasts} />

      {isEqOpen && (
        <Suspense fallback={null}>
          <EqualizerModal
            isOpen
            onClose={() => setIsEqOpen(false)}
            eqPreset={player.eqPreset}
            eqGains={player.eqGains}
            onSetPreset={player.setEqPreset}
            onSetGain={player.setBandGain}
          />
        </Suspense>
      )}

      {recommendationTarget && (
        <Suspense fallback={null}>
          <RecommendationsModal
            isOpen
            onClose={() => setRecommendationTarget(null)}
            targetSong={recommendationTarget}
            librarySongs={allSongs}
            onPlaySong={song => handlePlaySong(song, allSongs)}
            onAddToQueue={song => { player.addToQueue(song); addToast(`Added "${song.track}" to queue`); }}
          />
        </Suspense>
      )}

      {isTasteProfileOpen && (
        <Suspense fallback={null}>
          <TasteProfileModal
            isOpen
            onClose={() => setIsTasteProfileOpen(false)}
            librarySummary={librarySummary}
            songs={allSongs}
          />
        </Suspense>
      )}

      <nav className="mobile-nav" aria-label="Mobile navigation">
        {navItems.map(item => (
          <button
            key={item.id}
            className={`mobile-nav__btn ${view === item.id ? 'mobile-nav__btn--active' : ''}`}
            onClick={() => { setView(item.id); setSelectedPlaylistKey(null); setSearchQuery(''); }}
            aria-current={view === item.id ? 'page' : undefined}
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
