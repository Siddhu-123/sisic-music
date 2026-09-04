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
} from '../queueManager.js';
import { driveService } from '../services/GoogleDriveService.js';
import { EQ_PRESETS } from '../services/audioGraph.js';
import {
  getDriveAppBaseUrl,
  getDriveStreamWorkerUrl,
  isAudioStreamResponse,
  isDriveStreamWorker,
  streamFailureMessage,
} from '../services/driveStream.js';
import { VinylAudioEngine } from '../services/VinylAudioEngine.js';

const QUEUE_STORAGE_KEY = 'sisic:queue-state:v1';
const STREAM_WORKER_READY_TIMEOUT_MS = 5000;
const STREAM_TOKEN_READY_TIMEOUT_MS = 1500;
const TRANSIENT_MEDIA_FIELDS = ['localFile', 'blob', 'isDownloaded', 'isCached', 'hasBlob', 'cacheSizeBytes', 'cachedAt'];

function isQueueReady(song) {
  return Boolean(song?.driveFileId);
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

async function waitForStreamWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return null;
  const baseUrl = import.meta.env.BASE_URL || './';
  const appBase = getDriveAppBaseUrl(baseUrl, window.location.href);
  const expectedWorkerUrl = getDriveStreamWorkerUrl(baseUrl, window.location.href);
  const currentStreamWorker = () => {
    const controller = navigator.serviceWorker.controller;
    return isDriveStreamWorker(controller, expectedWorkerUrl) ? controller : null;
  };

  const controlledWorker = currentStreamWorker();
  if (controlledWorker) return controlledWorker;

  try {
    const registration = await navigator.serviceWorker.register(expectedWorkerUrl, { scope: appBase.pathname });
    registration.update().catch(() => {});
    if (currentStreamWorker()) return currentStreamWorker();

    return await new Promise(resolve => {
      let settled = false;
      let timeout = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timeout !== null) window.clearTimeout(timeout);
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
        resolve(currentStreamWorker());
      };
      const onControllerChange = () => {
        if (currentStreamWorker()) finish();
      };
      timeout = window.setTimeout(finish, STREAM_WORKER_READY_TIMEOUT_MS);
      navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
      navigator.serviceWorker.ready.then(() => {
        if (currentStreamWorker()) finish();
      }).catch(() => {});
      if (currentStreamWorker()) finish();
    });
  } catch {
    return null;
  }
}

async function syncDriveStreamWorkerToken(worker) {
  if (!worker || !driveService.isAuthenticated || typeof window === 'undefined') return false;
  const expectedTokenVersion = driveService.tokenVersion;

  return await new Promise(resolve => {
    let settled = false;
    let timeout = null;
    const finish = value => {
      if (settled) return;
      settled = true;
      if (timeout !== null) window.clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener('message', onMessage);
      resolve(value);
    };
    const onMessage = event => {
      if (event.data?.type !== 'SISIC_DRIVE_TOKEN_READY') return;
      if (expectedTokenVersion && event.data.tokenVersion !== expectedTokenVersion) return;
      finish(true);
    };

    navigator.serviceWorker.addEventListener('message', onMessage);
    if (!driveService.syncTokenToServiceWorker(worker)) {
      finish(false);
      return;
    }
    timeout = window.setTimeout(() => finish(false), STREAM_TOKEN_READY_TIMEOUT_MS);
  });
}

async function probeDriveStream(streamUrl) {
  try {
    const response = await fetch(streamUrl, {
      cache: 'no-store',
      headers: { Range: 'bytes=0-0' },
    });
    const ready = isAudioStreamResponse(response);
    const message = ready ? '' : streamFailureMessage(response);
    try {
      await response.body?.cancel?.();
    } catch {
      // The response was already consumed or does not expose a cancelable body.
    }
    return { ready, message };
  } catch {
    return {
      ready: false,
      message: 'The Drive stream could not be reached. Check your connection and try again.',
    };
  }
}

function toPlayerSong(song) {
  const playerSong = { ...song };
  TRANSIENT_MEDIA_FIELDS.forEach(field => delete playerSong[field]);
  return playerSong;
}

export function useAudioPlayer() {
  const [audioEngine] = useState(() => new VinylAudioEngine());
  const audioRef = useRef(audioEngine);
  const sourceSongRef = useRef(null);
  const isSourceLoadingRef = useRef(false);
  const [restoredInitialState] = useState(() => readPersistedQueueState());
  const [currentSong, setCurrentSong] = useState(null);
  const [queue, setQueue] = useState(() => restoredInitialState?.queue || []);
  const [queueIndex, setQueueIndex] = useState(() => restoredInitialState?.queueIndex || 0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isSpinningDown, setIsSpinningDown] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [error, setError] = useState('');
  const [shuffleMode, setShuffleMode] = useState('off');
  const [repeatMode, setRepeatMode] = useState(() => restoredInitialState?.repeatMode || 'off');
  const [resumeOnRestore, setResumeOnRestore] = useState(() => Boolean(restoredInitialState?.isPlaying));
  const [resumePosition, setResumePosition] = useState(() => restoredInitialState?.positionSeconds || 0);
  const [queueRevision, setQueueRevision] = useState(0);
  const [playbackEvent, setPlaybackEvent] = useState(null);
  const [eqPreset, setEqPresetState] = useState('flat');
  const [eqGains, setEqGainsState] = useState(() => [...EQ_PRESETS.flat.gains]);
  const [rpm, setRpmState] = useState(45);
  const [pitchModifier, setPitchModifierState] = useState(1);
  const [pitchRange, setPitchRangeState] = useState(0.08);
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
    sourceSongRef.current = null;
    isSourceLoadingRef.current = false;
    const audio = audioRef.current;
    audio.clear();
    setIsPlaying(false);
    setProgress(0);
    setDuration(0);
  }, []);

  const setPlayerError = useCallback((message) => {
    setError(message || '');
  }, []);

  const loadAndPlay = useCallback(async (song, options = {}) => {
    const { autoplay = true, startAt = 0 } = options;
    const requestId = ++loadRequestRef.current;
    const isLatestRequest = () => requestId === loadRequestRef.current;
    const audio = audioRef.current;
    setError('');
    audio.clear();
    setIsPlaying(false);
    setProgress(0);
    setDuration(0);
    if (!isLatestRequest()) return false;
    const playerSong = toPlayerSong(song);
    sourceSongRef.current = playerSong;
    isSourceLoadingRef.current = true;

    try {
      if (song.driveFileId) {
        if (!driveService.isAuthenticated) throw new Error('Google Drive sign-in is required before this song can load.');
        const streamWorker = await waitForStreamWorker();
        if (!streamWorker) throw new Error('Drive streaming is not ready. Reload the app once, then try again.');
        const streamUrl = driveService.getAudioStreamUrl(song.driveFileId);
        if (!await syncDriveStreamWorkerToken(streamWorker)) {
          // A previously deployed stream worker does not acknowledge tokens. A
          // one-byte same-origin check keeps that migration path working
          // without ever buffering a media file in JavaScript.
          const probe = await probeDriveStream(streamUrl);
          if (!probe.ready) throw new Error(probe.message);
        }
        try {
          await audio.loadUrl(streamUrl);
        } catch (firstError) {
          if (firstError?.name === 'AbortError') throw firstError;
          const probe = await probeDriveStream(streamUrl);
          if (!probe.ready) throw new Error(probe.message);
          try {
            await audio.loadUrl(streamUrl);
          } catch (retryError) {
            if (retryError?.name === 'AbortError') throw retryError;
            throw new Error('Google Drive responded with audio, but the browser could not decode this file. Re-prepare the song or choose another source.');
          }
        }
      } else {
        clearSource();
        setCurrentSong(null);
        setError(`"${song.track}" is queued for Mac preparation.`);
        return false;
      }
    } catch (error) {
      if (!isLatestRequest()) return false;
      if (error?.name === 'AbortError') return false;
      console.error('Audio stream error:', error);
      sourceSongRef.current = null;
      isSourceLoadingRef.current = false;
      setError(error instanceof Error ? error.message : 'The audio stream could not be loaded.');
      return false;
    }
    if (!isLatestRequest()) return false;
    sourceSongRef.current = playerSong;
    isSourceLoadingRef.current = false;
    setCurrentSong(playerSong);
    audio.setVolume(volume);
    const restoreSeconds = Math.max(0, Number(startAt) || 0);
    if (restoreSeconds > 0) {
      if (isLatestRequest() && Number.isFinite(audio.duration) && audio.duration > restoreSeconds) {
        audio.currentTime = Math.min(restoreSeconds, Math.max(0, audio.duration - 0.25));
      }
      setResumePosition(0);
    }
    if (song.songKey || song.id) playedInSessionRef.current.add(song.songKey || song.id);

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
    setResumeOnRestore(true);
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
    setResumeOnRestore(true);
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
    const onPlay = () => {
      setIsPlaying(true);
      setIsSpinningDown(false);
    };
    const onPause = () => {
      setIsPlaying(false);
      setIsSpinningDown(false);
    };
    const onSpindownStart = () => {
      setIsSpinningDown(true);
      setIsPlaying(false);
    };
    const onSpindownCancel = () => setIsSpinningDown(false);
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
      if (audio.duration) {
        const pct = (audio.currentTime / audio.duration) * 100;
        setProgress(pct);
      }
      if (Date.now() - lastPersistedAtRef.current > 1000) {
        lastPersistedAtRef.current = Date.now();
        persistQueueState();
      }
    };
    const onDurationChange = () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    const onError = (event) => {
      if (!audio.getAttribute('src')) return;
      const failedSong = sourceSongRef.current || currentSong;
      const key = failedSong?.songKey;
      const code = event?.code || audio.error?.code;
      const msg = event?.message || audio.error?.message || '';
      const payload = {
        code,
        msg,
        songKey: key,
        driveFileId: failedSong?.driveFileId || '',
        sourceUrl: event?.sourceUrl || audio.src,
        currentTime: Number(audio.currentTime || 0),
        duration: Number(audio.duration || 0),
      };
      console.error('Audio error:', payload);
      setIsPlaying(false);
      if (failedSong) {
        emitPlaybackEvent({
          eventType: 'playback-stream-error',
          songKey: failedSong.songKey || '',
          artist: failedSong.artist || '',
          track: failedSong.track || '',
          driveFileId: failedSong.driveFileId || '',
          positionSeconds: Number(audio.currentTime || 0),
          durationSeconds: Number(audio.duration || 0),
          expectedFullPlay: false,
          userInitiated: false,
          message: `Audio error ${code || 'unknown'} ${msg}`.trim(),
        });
      }
      if (failedSong?.driveFileId && !driveService.isAuthenticated) {
        driveService.requireAuthentication(new Error('Google Drive authorization ended.'));
        setError('Drive connection paused. Reconnect to continue streaming.');
        return;
      }
      if (isSourceLoadingRef.current) return;
      if (key) failedSongKeysRef.current.add(key);
      setError('Playback could not continue. Press play to retry this song.');
    };

    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('spindownstart', onSpindownStart);
    audio.addEventListener('spindowncancel', onSpindownCancel);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('durationchange', onDurationChange);
    audio.addEventListener('error', onError);
    return () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('spindownstart', onSpindownStart);
      audio.removeEventListener('spindowncancel', onSpindownCancel);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('durationchange', onDurationChange);
      audio.removeEventListener('error', onError);
    };
  }, [emitPlaybackEvent, persistQueueState, playNext, repeatMode, currentSong]);

  const setEqPreset = useCallback((presetKey) => {
    audioRef.current.applyPreset(presetKey);
    setEqPresetState(presetKey);
    setEqGainsState([...(EQ_PRESETS[presetKey]?.gains || [0, 0, 0, 0, 0])]);
  }, []);

  const setBandGain = useCallback((bandIndex, gainDb) => {
    audioRef.current.setBandGain(bandIndex, gainDb);
    setEqPresetState('custom');
    setEqGainsState([...audioRef.current.currentGains]);
  }, []);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || !currentSong) return;

    try {
      const artwork = currentSong.coverArtUrl && !currentSong.coverArtUrl.startsWith('data:')
        ? [{ src: currentSong.coverArtUrl, sizes: '512x512', type: 'image/jpeg' }]
        : [];

      if (typeof window !== 'undefined' && window.MediaMetadata) {
        navigator.mediaSession.metadata = new window.MediaMetadata({
          title: currentSong.track || 'Unknown Track',
          artist: currentSong.artist || 'Unknown Artist',
          album: currentSong.album || 'Sisic Music',
          artwork,
        });
      }

      navigator.mediaSession.setActionHandler('play', () => {
        if (audioRef.current.paused) audioRef.current.play().catch(() => {});
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        if (!audioRef.current.paused) audioRef.current.pause();
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => playPrev({ reason: 'user-media-session' }));
      navigator.mediaSession.setActionHandler('nexttrack', () => playNext({ reason: 'user-media-session' }));
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime != null && Number.isFinite(details.seekTime)) {
          audioRef.current.currentTime = details.seekTime;
        }
      });
    } catch (e) {
      console.debug('MediaSession setup non-fatal:', e);
    }
  }, [currentSong, playNext, playPrev]);

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
    const nextVolume = Math.max(0, Math.min(1, Number(v) || 0));
    const audio = audioRef.current;
    audio.setVolume(nextVolume);
    setVolume(nextVolume);
  }, []);

  const setRpm = useCallback((value) => {
    const nextRpm = Number(value) === 33 ? 33 : 45;
    audioRef.current.setRpm(nextRpm);
    setRpmState(nextRpm);
  }, []);

  const setPitchModifier = useCallback((value) => {
    const nextModifier = Math.max(1 - pitchRange, Math.min(1 + pitchRange, Number(value) || 1));
    audioRef.current.setPitchModifier(nextModifier);
    setPitchModifierState(nextModifier);
  }, [pitchRange]);

  const setPitchRange = useCallback((value) => {
    const nextRange = Number(value) >= 0.16 ? 0.16 : 0.08;
    const nextModifier = Math.max(1 - nextRange, Math.min(1 + nextRange, pitchModifier));
    audioRef.current.setPitchModifier(nextModifier);
    setPitchRangeState(nextRange);
    setPitchModifierState(nextModifier);
  }, [pitchModifier]);

  const beginScratch = useCallback((resume = isPlaying) => {
    audioRef.current.beginScratch({ resume });
  }, [isPlaying]);

  const setScratchAngularVelocity = useCallback((angularVelocity) => {
    audioRef.current.setScratchAngularVelocity(angularVelocity);
  }, []);

  const endScratch = useCallback(() => {
    audioRef.current.endScratch();
  }, []);

  const setNeedleLifted = useCallback((lifted) => {
    audioRef.current.setNeedleLifted(lifted);
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

  useEffect(() => {
    const onKeyDown = event => {
      if (event.defaultPrevented || event.repeat) return;
      const target = event.target;
      const isEditable = target instanceof HTMLElement && (
        target.isContentEditable
        || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName)
      );
      if (isEditable) return;

      const key = event.key || event.code;
      const hasModifier = event.ctrlKey || event.metaKey || event.altKey;
      const isPlayPause = !hasModifier && (key === ' ' || key === 'Spacebar' || key === 'MediaPlayPause' || event.code === 'Space');
      const isStop = !hasModifier && (key === 'MediaStop' || event.code === 'MediaStop');
      const isNext = !hasModifier && (key === 'MediaTrackNext' || event.code === 'MediaTrackNext');
      const isPrevious = !hasModifier && (key === 'MediaTrackPrevious' || event.code === 'MediaTrackPrevious');
      if (!isPlayPause && !isStop && !isNext && !isPrevious) return;

      event.preventDefault();
      if (isPlayPause) togglePlay();
      else if (isStop) stop();
      else if (isNext) playNext({ reason: 'user-next' });
      else if (isPrevious) playPrev({ reason: 'user-prev' });
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [playNext, playPrev, stop, togglePlay]);

  useEffect(() => () => audioRef.current.dispose(), []);

  const setQueueAndPlay = useCallback((songs, startIndex = 0) => {
    setError('');
    setQueueRevision(previous => previous + 1);
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

  const toggleRepeat = useCallback(() => {
    setRepeatMode(previous => {
      const modes = ['off', 'one', 'all'];
      const next = modes[(modes.indexOf(previous) + 1) % modes.length];
      repeatModeRef.current = next;
      return next;
    });
  }, []);

  const playQueueItem = useCallback((index) => {
    const activeQueue = queueRef.current;
    if (index < 0 || index >= activeQueue.length) return false;
    if (index === queueIndexRef.current && currentSong) {
      togglePlay();
      return true;
    }
    setError('');
    queueIndexRef.current = index;
    setQueueIndex(index);
    setResumeOnRestore(true);
    return true;
  }, [currentSong, togglePlay]);

  return {
    audioRef,
    currentSong,
    currentSongKey: currentSong?.songKey || null,
    queueRevision,
    isPlaying,
    isSpinningDown,
    progress,
    duration,
    volume,
    rpm,
    pitchModifier,
    pitchRange,
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
    setRpm,
    setPitchModifier,
    setPitchRange,
    beginScratch,
    setScratchAngularVelocity,
    endScratch,
    setNeedleLifted,
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
    setQueueAndPlay,
    playQueueItem,
    toggleShuffle,
    toggleRepeat,
    eqPreset,
    eqGains,
    setEqPreset,
    setBandGain,
  };
}
