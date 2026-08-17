import { useState, useRef, useEffect, useCallback } from 'react';
import {
  dedupeQueue,
  insertAfter,
  insertAtEnd,
  previousQueueIndex,
  queueItemKey,
  removeAt,
  reorderQueue,
  restoreQueueState,
  serializeQueueState,
} from '../queueManager';

const MIN_CACHED_AUDIO_BYTES = 16 * 1024;
const QUEUE_STORAGE_KEY = 'sisic:queue-state:v1';
let streamWorkerReadyPromise = null;

function appBaseUrl() {
  return new URL(import.meta.env.BASE_URL || './', window.location.href);
}

function driveStreamUrl(fileId) {
  return new URL(`stream/${encodeURIComponent(fileId)}`, appBaseUrl()).toString();
}

function waitForController() {
  if (navigator.serviceWorker.controller) return Promise.resolve(navigator.serviceWorker.controller);
  return new Promise(resolve => {
    const timeout = window.setTimeout(() => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      resolve(navigator.serviceWorker.controller);
    }, 1200);
    function onControllerChange() {
      window.clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      resolve(navigator.serviceWorker.controller);
    }
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
  });
}

async function ensureDriveStreamWorker(accessToken) {
  if (!accessToken || !('serviceWorker' in navigator)) return false;
  if (!streamWorkerReadyPromise) {
    const base = appBaseUrl();
    streamWorkerReadyPromise = navigator.serviceWorker
      .register(new URL('stream-sw.js', base), { scope: base.pathname })
      .then(async registration => {
        await registration.update();
        return navigator.serviceWorker.ready;
      });
  }
  const registration = await streamWorkerReadyPromise;
  const worker = navigator.serviceWorker.controller
    || registration.active
    || await waitForController();
  if (!worker) return false;
  worker.postMessage({ type: 'SISIC_DRIVE_TOKEN', accessToken });
  return true;
}

function hasUsableCachedAudio(song) {
  return Boolean(
    song.blob
    && (song.isDownloaded || song.isCached || song.hasBlob)
    && (!song.blob.size || song.blob.size >= MIN_CACHED_AUDIO_BYTES)
  );
}

function isQueueReady(song) {
  return Boolean(song?.driveFileId || song?.isDownloaded || song?.isCached || song?.hasBlob);
}

function smartRandomIndex(songs, currentIndex, playedInSession, failedSongKeys, avoidCurrent = false) {
  if (songs.length <= 1) return avoidCurrent ? -1 : 0;

  const weights = songs.map((song, i) => {
    if (i === currentIndex) return 0;
    if (!isQueueReady(song)) return 0;
    if (song.songKey && failedSongKeys.has(song.songKey)) return 0;
    const playCount = song.playCount || 0;
    let weight = 1 + Math.log(1 + playCount);
    if (playedInSession.has(song.songKey || song.id)) weight *= 0.15;
    return weight;
  });

  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight === 0) return nextUnfailedIndex(songs, currentIndex, failedSongKeys, avoidCurrent);

  let random = Math.random() * totalWeight;
  for (let i = 0; i < weights.length; i++) {
    random -= weights[i];
    if (random <= 0) return i;
  }
  return 0;
}

function nextUnfailedIndex(songs, currentIndex, failedSongKeys, avoidCurrent = false, repeatMode = 'off') {
  if (songs.length === 0) return -1;
  const maxSteps = repeatMode === 'all'
    ? (avoidCurrent ? songs.length - 1 : songs.length)
    : Math.max(0, songs.length - currentIndex - 1);
  for (let step = 1; step <= maxSteps; step++) {
    const rawNext = currentIndex + step;
    if (rawNext >= songs.length && repeatMode !== 'all') break;
    const next = rawNext % songs.length;
    const key = songs[next]?.songKey;
    if (isQueueReady(songs[next]) && (!key || !failedSongKeys.has(key))) return next;
  }
  return isQueueReady(songs[currentIndex]) && !avoidCurrent ? currentIndex : -1;
}

function shuffleArray(arr) {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function readPersistedQueueState() {
  if (typeof window === 'undefined') return null;
  try {
    return restoreQueueState(window.localStorage.getItem(QUEUE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function useAudioPlayer() {
  const audioRef = useRef(new Audio());
  const [restoredInitialState] = useState(() => readPersistedQueueState());
  const [currentSong, setCurrentSong] = useState(null);
  const [queue, setQueue] = useState(() => restoredInitialState?.queue || []);
  const [queueIndex, setQueueIndex] = useState(() => restoredInitialState?.queueIndex || 0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [error, setError] = useState('');
  const [shuffleMode, setShuffleMode] = useState('off');
  const [repeatMode, setRepeatMode] = useState(() => restoredInitialState?.repeatMode || 'off');
  const [resumeOnRestore, setResumeOnRestore] = useState(() => Boolean(restoredInitialState?.isPlaying));
  const [resumePosition, setResumePosition] = useState(() => restoredInitialState?.positionSeconds || 0);
  const [playbackEvent, setPlaybackEvent] = useState(null);
  const blobUrlRef = useRef(null);
  const playedInSessionRef = useRef(new Set());
  const failedSongKeysRef = useRef(new Set());
  const originalQueueRef = useRef([]);
  const loadRequestRef = useRef(0);
  const queueRef = useRef(restoredInitialState?.queue || []);
  const queueIndexRef = useRef(restoredInitialState?.queueIndex || 0);
  const repeatModeRef = useRef(restoredInitialState?.repeatMode || 'off');
  const lastPersistedAtRef = useRef(0);

  useEffect(() => {
    queueRef.current = queue;
    queueIndexRef.current = queueIndex;
    repeatModeRef.current = repeatMode;
  }, [queue, queueIndex, repeatMode]);

  const persistQueueState = useCallback(() => {
    try {
      window.localStorage.setItem(QUEUE_STORAGE_KEY, serializeQueueState({
        queue: queueRef.current,
        queueIndex: queueIndexRef.current,
        repeatMode: repeatModeRef.current,
        shuffleMode,
        positionSeconds: audioRef.current.currentTime || 0,
        isPlaying,
      }));
    } catch (error) {
      console.warn('Queue persistence failed:', error);
    }
  }, [isPlaying, shuffleMode]);

  useEffect(() => {
    persistQueueState();
  }, [isPlaying, persistQueueState, queue, queueIndex, repeatMode]);

  useEffect(() => {
    const persistOnExit = () => persistQueueState();
    window.addEventListener('beforeunload', persistOnExit);
    document.addEventListener('visibilitychange', persistOnExit);
    return () => {
      window.removeEventListener('beforeunload', persistOnExit);
      document.removeEventListener('visibilitychange', persistOnExit);
    };
  }, [persistQueueState]);

  const emitPlaybackEvent = useCallback((event) => {
    setPlaybackEvent({
      ...event,
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      createdAt: new Date().toISOString(),
    });
  }, []);

  const clearSource = useCallback(() => {
    loadRequestRef.current += 1;
    const audio = audioRef.current;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    setIsPlaying(false);
    setProgress(0);
    setDuration(0);
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }, []);

  const setPlayerError = useCallback((message) => {
    setError(message || '');
  }, []);

  const loadAndPlay = useCallback(async (song, accessToken, options = {}) => {
    const { autoplay = true, startAt = 0 } = options;
    const requestId = ++loadRequestRef.current;
    const isLatestRequest = () => requestId === loadRequestRef.current;
    const audio = audioRef.current;
    setError('');

    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }

    audio.pause();
    audio.removeAttribute('src');
    audio.load();

    if (song.driveFileId && accessToken) {
      const canProxyStream = await ensureDriveStreamWorker(accessToken);
      if (!isLatestRequest()) return false;
      if (!canProxyStream && hasUsableCachedAudio(song)) {
        const url = URL.createObjectURL(song.blob);
        blobUrlRef.current = url;
        audio.src = url;
        setCurrentSong(song);
      } else if (!canProxyStream) {
        clearSource();
        setCurrentSong(null);
        setError('Drive stream worker is not ready. Refresh and try again.');
        return false;
      } else {
        audio.preload = 'metadata';
        audio.src = driveStreamUrl(song.driveFileId);
        setCurrentSong(song);
      }
    } else if (hasUsableCachedAudio(song)) {
      const url = URL.createObjectURL(song.blob);
      blobUrlRef.current = url;
      audio.src = url;
      setCurrentSong(song);
    } else {
      clearSource();
      setCurrentSong(null);
      setError(
        song.driveFileId
          ? 'Google Drive sign-in is required before this song can stream.'
          : `"${song.track}" is queued for download.`
      );
      return false;
    }

    audio.volume = volume;
    const restoreSeconds = Math.max(0, Number(startAt) || 0);
    if (restoreSeconds > 0) {
      const applyRestorePosition = () => {
        if (isLatestRequest() && Number.isFinite(audio.duration) && audio.duration > restoreSeconds) {
          audio.currentTime = Math.min(restoreSeconds, Math.max(0, audio.duration - 0.25));
        }
      };
      if (audio.readyState >= 1) applyRestorePosition();
      else audio.addEventListener('loadedmetadata', applyRestorePosition, { once: true });
      setResumePosition(0);
    }
    if (song.songKey || song.id) playedInSessionRef.current.add(song.songKey || song.id);

    await new Promise(resolve => setTimeout(resolve, 50));
    if (!isLatestRequest()) return false;

    if (!autoplay) return true;

    try {
      await audio.play();
      if (song.songKey) failedSongKeysRef.current.delete(song.songKey);
      emitPlaybackEvent({
        eventType: 'playback-start',
        songKey: song.songKey || '',
        artist: song.artist || '',
        track: song.track || '',
        driveFileId: song.driveFileId || '',
        positionSeconds: Number(audio.currentTime || 0),
        durationSeconds: Number(audio.duration || 0),
        expectedFullPlay: false,
        userInitiated: false,
        message: startAt ? 'Playback resumed from the saved position.' : 'Playback started.',
      });
      return true;
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error('Playback error:', e);
        emitPlaybackEvent({
          eventType: 'playback-start-failed',
          songKey: song.songKey || '',
          artist: song.artist || '',
          track: song.track || '',
          driveFileId: song.driveFileId || '',
          positionSeconds: Number(audio.currentTime || 0),
          durationSeconds: Number(audio.duration || 0),
          expectedFullPlay: false,
          userInitiated: false,
          message: e instanceof Error ? e.message : 'Playback failed.',
        });
        setError(e instanceof Error ? e.message : 'Playback failed.');
      }
      return false;
    }
  }, [clearSource, emitPlaybackEvent, volume]);

  const playNext = useCallback((options = {}) => {
    const activeQueue = queueRef.current;
    if (activeQueue.length === 0) return false;
    const { avoidCurrent = false, stopOnBlocked = false, reason = 'auto-next' } = options;
    const audio = audioRef.current;
    const activeIndex = queueIndexRef.current;
    const current = activeQueue[activeIndex];
    if (reason.startsWith('user') && current) {
      emitPlaybackEvent({
        eventType: 'user-skip',
        songKey: current.songKey || '',
        artist: current.artist || '',
        track: current.track || '',
        driveFileId: current.driveFileId || '',
        positionSeconds: Number(audio.currentTime || 0),
        durationSeconds: Number(audio.duration || 0),
        expectedFullPlay: false,
        userInitiated: true,
        message: reason,
      });
    }

    let nextIdx;
    if (shuffleMode === 'smart') {
      nextIdx = smartRandomIndex(activeQueue, activeIndex, playedInSessionRef.current, failedSongKeysRef.current, avoidCurrent);
      if (nextIdx < 0 && repeatMode === 'all') {
        nextIdx = nextUnfailedIndex(activeQueue, activeIndex, failedSongKeysRef.current, avoidCurrent, repeatMode);
      }
    } else {
      const effectiveRepeat = reason === 'ended' && repeatMode === 'one' ? 'off' : repeatMode;
      nextIdx = nextUnfailedIndex(activeQueue, activeIndex, failedSongKeysRef.current, avoidCurrent, effectiveRepeat);
    }

    if (nextIdx < 0 || nextIdx === activeIndex) {
      if (stopOnBlocked) {
        clearSource();
        setCurrentSong(null);
        setError('Playback stopped because no other playable songs are available right now.');
      }
      return false;
    }

    queueIndexRef.current = nextIdx;
    setQueueIndex(nextIdx);
    return true;
  }, [clearSource, emitPlaybackEvent, repeatMode, shuffleMode]);

  const playPrev = useCallback((options = {}) => {
    const activeQueue = queueRef.current;
    if (activeQueue.length === 0) return;
    const { reason = 'user-prev' } = options;
    const audio = audioRef.current;
    const activeIndex = queueIndexRef.current;
    const current = activeQueue[activeIndex];
    if (current) {
      emitPlaybackEvent({
        eventType: 'user-skip',
        songKey: current.songKey || '',
        artist: current.artist || '',
        track: current.track || '',
        driveFileId: current.driveFileId || '',
        positionSeconds: Number(audio.currentTime || 0),
        durationSeconds: Number(audio.duration || 0),
        expectedFullPlay: false,
        userInitiated: true,
        message: reason,
      });
    }
    const previousIndex = previousQueueIndex({
      length: activeQueue.length,
      currentIndex: activeIndex,
      repeatMode,
    });
    queueIndexRef.current = previousIndex;
    setQueueIndex(previousIndex);
  }, [emitPlaybackEvent, repeatMode]);

  const toggleShuffle = useCallback(() => {
    setShuffleMode(prev => {
      const modes = ['off', 'shuffle', 'smart'];
      const next = modes[(modes.indexOf(prev) + 1) % modes.length];

      if (next === 'shuffle' && queue.length > 0) {
        originalQueueRef.current = [...queue];
        const currentSongObj = queue[queueIndex];
        const rest = queue.filter((_, i) => i !== queueIndex);
        const readyRest = rest.filter(isQueueReady);
        const blockedRest = rest.filter(song => !isQueueReady(song));
        setQueue([currentSongObj, ...shuffleArray(readyRest), ...blockedRest]);
        setQueueIndex(0);
      } else if (next === 'off' && originalQueueRef.current.length > 0) {
        const currentSongObj = queue[queueIndex];
        setQueue(originalQueueRef.current);
        const origIdx = originalQueueRef.current.findIndex(s => s.songKey === currentSongObj?.songKey);
        setQueueIndex(origIdx >= 0 ? origIdx : 0);
        originalQueueRef.current = [];
      }

      return next;
    });
  }, [queue, queueIndex]);

  useEffect(() => {
    const audio = audioRef.current;
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => {
      const durationSeconds = Number(audio.duration || 0);
      const positionSeconds = Number(audio.currentTime || 0);
      const completed = !durationSeconds || positionSeconds >= Math.max(0, durationSeconds - 2);
      if (currentSong) {
        emitPlaybackEvent({
          eventType: completed ? 'playback-complete' : 'playback-short-ended',
          songKey: currentSong.songKey || '',
          artist: currentSong.artist || '',
          track: currentSong.track || '',
          driveFileId: currentSong.driveFileId || '',
          positionSeconds,
          durationSeconds,
          expectedFullPlay: completed,
          userInitiated: false,
          message: completed ? 'Audio ended normally.' : 'Audio ended before the expected duration.',
        });
      }
      if (repeatMode === 'one' && currentSong) {
        audio.currentTime = 0;
        audio.play().catch(error => {
          if (error.name !== 'AbortError') setError(error instanceof Error ? error.message : 'Playback failed.');
        });
      } else {
        playNext({ reason: 'ended' });
      }
    };
    const onTimeUpdate = () => {
      if (audio.duration) setProgress((audio.currentTime / audio.duration) * 100);
      if (Date.now() - lastPersistedAtRef.current > 1000) {
        lastPersistedAtRef.current = Date.now();
        persistQueueState();
      }
    };
    const onDurationChange = () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    const onError = () => {
      if (!audio.getAttribute('src')) return;
      const key = currentSong?.songKey;
      const code = audio.error?.code;
      const msg = audio.error?.message || '';
      const payload = {
        code,
        msg,
        songKey: key,
        currentTime: Number(audio.currentTime || 0),
        duration: Number(audio.duration || 0),
      };
      console.error('Audio error:', payload);
      setIsPlaying(false);
      if (key) failedSongKeysRef.current.add(key);
      if (currentSong) {
        emitPlaybackEvent({
          eventType: 'unexpected-playback-skip',
          songKey: currentSong.songKey || '',
          artist: currentSong.artist || '',
          track: currentSong.track || '',
          driveFileId: currentSong.driveFileId || '',
          positionSeconds: Number(audio.currentTime || 0),
          durationSeconds: Number(audio.duration || 0),
          expectedFullPlay: false,
          userInitiated: false,
          message: `Audio error ${code || 'unknown'} ${msg}`.trim(),
        });
      }
      setError('Stream failed for this song. Skipping to the next playable track.');
      window.setTimeout(() => {
        playNext({ avoidCurrent: true, stopOnBlocked: true, reason: 'stream-error' });
      }, 900);
    };

    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('durationchange', onDurationChange);
    audio.addEventListener('error', onError);
    return () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('durationchange', onDurationChange);
      audio.removeEventListener('error', onError);
    };
  }, [emitPlaybackEvent, persistQueueState, playNext, repeatMode, currentSong]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (audio.paused) {
      audio.play().then(() => {
        if (!currentSong) return;
        emitPlaybackEvent({
          eventType: audio.currentTime > 0 ? 'playback-resume' : 'playback-start',
          songKey: currentSong.songKey || '',
          artist: currentSong.artist || '',
          track: currentSong.track || '',
          driveFileId: currentSong.driveFileId || '',
          positionSeconds: Number(audio.currentTime || 0),
          durationSeconds: Number(audio.duration || 0),
          expectedFullPlay: false,
          userInitiated: true,
          message: audio.currentTime > 0 ? 'Playback resumed by the listener.' : 'Playback started by the listener.',
        });
      }).catch(e => {
        if (e.name !== 'AbortError') console.error(e);
      });
    } else {
      if (currentSong) {
        emitPlaybackEvent({
          eventType: 'playback-pause',
          songKey: currentSong.songKey || '',
          artist: currentSong.artist || '',
          track: currentSong.track || '',
          driveFileId: currentSong.driveFileId || '',
          positionSeconds: Number(audio.currentTime || 0),
          durationSeconds: Number(audio.duration || 0),
          expectedFullPlay: false,
          userInitiated: true,
          message: 'Playback paused by the listener.',
        });
      }
      audio.pause();
    }
  }, [currentSong, emitPlaybackEvent]);

  const seek = useCallback((pct) => {
    const audio = audioRef.current;
    if (!audio.duration) return;
    const fromSeconds = Number(audio.currentTime || 0);
    const toSeconds = (pct / 100) * audio.duration;
    audio.currentTime = toSeconds;
    if (currentSong) {
      emitPlaybackEvent({
        eventType: 'playback-seek',
        songKey: currentSong.songKey || '',
        artist: currentSong.artist || '',
        track: currentSong.track || '',
        driveFileId: currentSong.driveFileId || '',
        positionSeconds: Number(toSeconds || 0),
        durationSeconds: Number(audio.duration || 0),
        fromPositionSeconds: fromSeconds,
        toPositionSeconds: Number(toSeconds || 0),
        expectedFullPlay: false,
        userInitiated: true,
        message: 'Playback position changed by the listener.',
      });
    }
  }, [currentSong, emitPlaybackEvent]);

  const changeVolume = useCallback((v) => {
    audioRef.current.volume = v;
    setVolume(v);
  }, []);

  const clearError = useCallback(() => setError(''), []);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (currentSong) {
      emitPlaybackEvent({
        eventType: 'playback-stop',
        songKey: currentSong.songKey || '',
        artist: currentSong.artist || '',
        track: currentSong.track || '',
        driveFileId: currentSong.driveFileId || '',
        positionSeconds: Number(audio.currentTime || 0),
        durationSeconds: Number(audio.duration || 0),
        expectedFullPlay: false,
        userInitiated: true,
        message: 'Playback stopped by the listener.',
      });
    }
    clearSource();
    setCurrentSong(null);
  }, [clearSource, currentSong, emitPlaybackEvent]);

  const setQueueAndPlay = useCallback((songs, startIndex = 0) => {
    setError('');
    failedSongKeysRef.current.clear();
    playedInSessionRef.current.clear();
    originalQueueRef.current = [];
    const uniqueSongs = dedupeQueue(songs);
    const selectedIndex = Math.min(Math.max(0, startIndex), Math.max(0, uniqueSongs.length - 1));
    setResumeOnRestore(true);

    if (shuffleMode === 'shuffle') {
      const currentSongObj = uniqueSongs[selectedIndex];
      const rest = uniqueSongs.filter((_, i) => i !== selectedIndex);
      const shuffled = [currentSongObj, ...shuffleArray(rest)];
      originalQueueRef.current = [...uniqueSongs];
      queueRef.current = shuffled;
      queueIndexRef.current = 0;
      setQueue(shuffled);
      setQueueIndex(0);
    } else {
      queueRef.current = uniqueSongs;
      queueIndexRef.current = selectedIndex;
      setQueue(uniqueSongs);
      setQueueIndex(selectedIndex);
    }
  }, [shuffleMode]);

  const enqueueNext = useCallback((song) => {
    if (!song) return false;
    setError('');
    if (song.songKey) failedSongKeysRef.current.delete(song.songKey);

    const activeQueue = queueRef.current;
    if (activeQueue.length === 0) {
      queueRef.current = [song];
      queueIndexRef.current = 0;
      setQueue([song]);
      setQueueIndex(0);
      setResumeOnRestore(true);
      return true;
    }

    const currentIdx = Math.min(queueIndexRef.current, activeQueue.length - 1);
    const nextQueue = insertAfter(activeQueue, currentIdx, song);
    const nextCurrentIdx = Math.max(0, nextQueue.findIndex(item => queueItemKey(item) === queueItemKey(activeQueue[currentIdx])));
    queueRef.current = nextQueue;
    queueIndexRef.current = nextCurrentIdx;
    setQueue(nextQueue);
    setQueueIndex(nextCurrentIdx);

    if (originalQueueRef.current.length > 0) {
      originalQueueRef.current = insertAtEnd(originalQueueRef.current, song);
    }

    return true;
  }, []);

  const addToQueue = useCallback((song) => {
    if (!song) return false;
    const activeQueue = queueRef.current;
    const nextQueue = insertAtEnd(activeQueue, song);
    queueRef.current = nextQueue;
    setQueue(nextQueue);
    if (activeQueue.length === 0) {
      queueIndexRef.current = 0;
      setQueueIndex(0);
      setResumeOnRestore(true);
    }
    return true;
  }, []);

  const removeFromQueue = useCallback((index) => {
    const activeQueue = queueRef.current;
    if (index < 0 || index >= activeQueue.length) return false;
    const nextQueue = removeAt(activeQueue, index);
    const activeIndex = queueIndexRef.current;
    let nextIndex = activeIndex;
    if (nextQueue.length === 0) {
      nextIndex = 0;
      clearSource();
      setCurrentSong(null);
    } else if (index < activeIndex) {
      nextIndex = activeIndex - 1;
    } else if (index === activeIndex) {
      nextIndex = Math.min(activeIndex, nextQueue.length - 1);
    }
    queueRef.current = nextQueue;
    queueIndexRef.current = nextIndex;
    setQueue(nextQueue);
    setQueueIndex(nextIndex);
    return true;
  }, [clearSource]);

  const reorderQueueItems = useCallback((fromIndex, toIndex) => {
    const activeQueue = queueRef.current;
    const currentSongKey = queueItemKey(activeQueue[queueIndexRef.current]);
    const nextQueue = reorderQueue(activeQueue, fromIndex, toIndex);
    const nextIndex = Math.max(0, nextQueue.findIndex(song => queueItemKey(song) === currentSongKey));
    queueRef.current = nextQueue;
    queueIndexRef.current = nextIndex;
    setQueue(nextQueue);
    setQueueIndex(nextIndex);
    return nextQueue;
  }, []);

  const clearQueue = useCallback(() => {
    queueRef.current = [];
    queueIndexRef.current = 0;
    originalQueueRef.current = [];
    clearSource();
    setCurrentSong(null);
    setQueue([]);
    setQueueIndex(0);
    setResumeOnRestore(false);
  }, [clearSource]);

  const playQueueItem = useCallback((index) => {
    const activeQueue = queueRef.current;
    if (index < 0 || index >= activeQueue.length) return false;
    if (index !== queueIndexRef.current) {
      clearSource();
      setCurrentSong(null);
    }
    queueIndexRef.current = index;
    setQueueIndex(index);
    setResumeOnRestore(true);
    setResumePosition(0);
    return true;
  }, [clearSource]);

  const toggleRepeat = useCallback(() => {
    setRepeatMode(previous => {
      const modes = ['off', 'one', 'all'];
      const next = modes[(modes.indexOf(previous) + 1) % modes.length];
      repeatModeRef.current = next;
      return next;
    });
  }, []);

  return {
    audioRef,
    currentSong,
    currentSongKey: currentSong?.songKey || null,
    isPlaying,
    progress,
    duration,
    volume,
    error,
    playbackEvent,
    queue,
    queueIndex,
    shuffleMode,
    repeatMode,
    resumeOnRestore,
    resumePosition,
    loadAndPlay,
    togglePlay,
    seek,
    changeVolume,
    clearError,
    setPlayerError,
    stop,
    playNext,
    playPrev,
    enqueueNext,
    addToQueue,
    removeFromQueue,
    reorderQueue: reorderQueueItems,
    clearQueue,
    playQueueItem,
    setQueueAndPlay,
    toggleShuffle,
    toggleRepeat,
  };
}
