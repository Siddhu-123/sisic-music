import { useState, useRef, useEffect, useCallback } from 'react';

const MIN_CACHED_AUDIO_BYTES = 16 * 1024;
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

function nextUnfailedIndex(songs, currentIndex, failedSongKeys, avoidCurrent = false) {
  if (songs.length === 0) return -1;
  const maxSteps = avoidCurrent ? songs.length - 1 : songs.length;
  for (let step = 1; step <= maxSteps; step++) {
    const next = (currentIndex + step) % songs.length;
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

function queueItemKey(song) {
  return song?.songKey || song?.id || null;
}

export function useAudioPlayer() {
  const audioRef = useRef(new Audio());
  const [currentSong, setCurrentSong] = useState(null);
  const [queue, setQueue] = useState([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [error, setError] = useState('');
  const [shuffleMode, setShuffleMode] = useState('off');
  const [playbackEvent, setPlaybackEvent] = useState(null);
  const blobUrlRef = useRef(null);
  const playedInSessionRef = useRef(new Set());
  const failedSongKeysRef = useRef(new Set());
  const originalQueueRef = useRef([]);
  const loadRequestRef = useRef(0);

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

  const loadAndPlay = useCallback(async (song, accessToken) => {
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
    if (song.songKey || song.id) playedInSessionRef.current.add(song.songKey || song.id);

    await new Promise(resolve => setTimeout(resolve, 50));
    if (!isLatestRequest()) return false;

    try {
      await audio.play();
      if (song.songKey) failedSongKeysRef.current.delete(song.songKey);
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
    if (queue.length === 0) return false;
    const { avoidCurrent = false, stopOnBlocked = false, reason = 'auto-next' } = options;
    const audio = audioRef.current;
    const current = queue[queueIndex];
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
      nextIdx = smartRandomIndex(queue, queueIndex, playedInSessionRef.current, failedSongKeysRef.current, avoidCurrent);
    } else {
      nextIdx = nextUnfailedIndex(queue, queueIndex, failedSongKeysRef.current, avoidCurrent);
    }

    if (nextIdx < 0 || nextIdx === queueIndex) {
      if (stopOnBlocked) {
        clearSource();
        setCurrentSong(null);
        setError('Playback stopped because no other playable songs are available right now.');
      }
      return false;
    }

    setQueueIndex(nextIdx);
    return true;
  }, [clearSource, emitPlaybackEvent, queue, queueIndex, shuffleMode]);

  const playPrev = useCallback((options = {}) => {
    if (queue.length === 0) return;
    const { reason = 'user-prev' } = options;
    const audio = audioRef.current;
    const current = queue[queueIndex];
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
    setQueueIndex(i => (i - 1 + queue.length) % queue.length);
  }, [emitPlaybackEvent, queue, queueIndex]);

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
      playNext({ reason: 'ended' });
    };
    const onTimeUpdate = () => {
      if (audio.duration) setProgress((audio.currentTime / audio.duration) * 100);
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
  }, [emitPlaybackEvent, playNext, currentSong]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (audio.paused) {
      audio.play().catch(e => {
        if (e.name !== 'AbortError') console.error(e);
      });
    } else {
      audio.pause();
    }
  }, []);

  const seek = useCallback((pct) => {
    const audio = audioRef.current;
    if (audio.duration) audio.currentTime = (pct / 100) * audio.duration;
  }, []);

  const changeVolume = useCallback((v) => {
    audioRef.current.volume = v;
    setVolume(v);
  }, []);

  const clearError = useCallback(() => setError(''), []);

  const stop = useCallback(() => {
    clearSource();
    setCurrentSong(null);
  }, [clearSource]);

  const setQueueAndPlay = useCallback((songs, startIndex = 0) => {
    setError('');
    failedSongKeysRef.current.clear();
    playedInSessionRef.current.clear();
    originalQueueRef.current = [];

    if (shuffleMode === 'shuffle') {
      const currentSongObj = songs[startIndex];
      const rest = songs.filter((_, i) => i !== startIndex);
      originalQueueRef.current = [...songs];
      setQueue([currentSongObj, ...shuffleArray(rest)]);
      setQueueIndex(0);
    } else {
      setQueue(songs);
      setQueueIndex(startIndex);
    }
  }, [shuffleMode]);

  const enqueueNext = useCallback((song) => {
    if (!song) return false;
    setError('');
    if (song.songKey) failedSongKeysRef.current.delete(song.songKey);

    if (queue.length === 0) {
      setQueue([song]);
      setQueueIndex(0);
      return true;
    }

    const currentIdx = Math.min(queueIndex, queue.length - 1);
    const currentKey = queueItemKey(queue[currentIdx]);
    const selectedKey = queueItemKey(song);
    const withoutDuplicate = queue.filter((item, index) => (
      index === currentIdx || !selectedKey || queueItemKey(item) !== selectedKey
    ));
    const nextCurrentIdx = Math.max(0, withoutDuplicate.findIndex(item => queueItemKey(item) === currentKey));
    const insertAt = Math.min(nextCurrentIdx + 1, withoutDuplicate.length);
    setQueue([
      ...withoutDuplicate.slice(0, insertAt),
      song,
      ...withoutDuplicate.slice(insertAt),
    ]);
    setQueueIndex(nextCurrentIdx);

    if (originalQueueRef.current.length > 0) {
      const originalWithoutDuplicate = originalQueueRef.current.filter(item => (
        !selectedKey || queueItemKey(item) !== selectedKey
      ));
      originalQueueRef.current = [...originalWithoutDuplicate, song];
    }

    return true;
  }, [queue, queueIndex]);

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
    setQueueAndPlay,
    toggleShuffle,
  };
}
