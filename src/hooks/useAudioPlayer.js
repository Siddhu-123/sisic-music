import { useState, useRef, useEffect, useCallback } from 'react';

function driveStreamUrl(fileId, accessToken) {
  const params = new URLSearchParams({
    alt: 'media',
    access_token: accessToken,
  });
  return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`;
}

/**
 * Weighted random pick using logarithmic play count.
 * weight = 1 + ln(1 + playCount)
 * Songs played in current session get deprioritized.
 */
function smartRandomIndex(songs, currentIndex, playedInSession) {
  if (songs.length <= 1) return 0;

  const weights = songs.map((song, i) => {
    if (i === currentIndex) return 0; // Don't replay current song
    const playCount = song.playCount || 0;
    let w = 1 + Math.log(1 + playCount);
    // Deprioritize recently played in this session
    if (playedInSession.has(song.id)) w *= 0.15;
    return w;
  });

  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight === 0) return (currentIndex + 1) % songs.length;

  let random = Math.random() * totalWeight;
  for (let i = 0; i < weights.length; i++) {
    random -= weights[i];
    if (random <= 0) return i;
  }
  return 0;
}

/** Fisher-Yates shuffle (returns new array). */
function shuffleArray(arr) {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function useAudioPlayer() {
  const audioRef = useRef(new Audio());
  const [currentSong, setCurrentSong] = useState(null);
  const [queue, setQueue] = useState([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0-100
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [error, setError] = useState('');
  const [shuffleMode, setShuffleMode] = useState('off'); // 'off' | 'shuffle' | 'smart'
  const blobUrlRef = useRef(null);
  const playedInSessionRef = useRef(new Set());
  // Store the original (unshuffled) queue so we can restore it
  const originalQueueRef = useRef([]);

  const clearSource = useCallback(() => {
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

  const loadAndPlay = useCallback(async (song, accessToken) => {
    const audio = audioRef.current;
    setError('');

    // Revoke old Blob URL to free memory
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }

    // Properly pause and wait before setting new source — fixes the
    // "play() request was interrupted by a call to pause()" error
    audio.pause();
    audio.removeAttribute('src');
    audio.load(); // Reset the element cleanly

    if (song.isDownloaded && song.blob) {
      // Play from local IndexedDB blob — instant, no network needed
      const url = URL.createObjectURL(song.blob);
      blobUrlRef.current = url;
      audio.src = url;
      setCurrentSong(song);
    } else if (song.driveFileId && accessToken) {
      // Stream directly from Drive
      audio.preload = 'auto';
      audio.src = driveStreamUrl(song.driveFileId, accessToken);
      setCurrentSong(song);
    } else {
      clearSource();
      setCurrentSong(null);
      setError(
        song.driveFileId
          ? 'Google Drive sign-in is required before this song can stream.'
          : `"${song.track}" is not on Drive yet — it's been queued for download.`
      );
      return;
    }

    audio.volume = volume;

    // Track in session history for smart shuffle
    if (song.id) playedInSessionRef.current.add(song.id);

    // Small delay to let the browser process the source change
    await new Promise(r => setTimeout(r, 50));

    try {
      await audio.play();
    } catch (e) {
      // AbortError means user/code triggered another action — not a real error
      if (e.name !== 'AbortError') {
        console.error('Playback error:', e);
        setError(e instanceof Error ? e.message : 'Playback failed.');
      }
    }
  }, [clearSource, volume]);

  // ── Next / Prev ────────────────────────────────────────────────────────

  const playNext = useCallback(() => {
    if (queue.length === 0) return;

    if (shuffleMode === 'smart') {
      const nextIdx = smartRandomIndex(queue, queueIndex, playedInSessionRef.current);
      setQueueIndex(nextIdx);
    } else {
      setQueueIndex(i => (i + 1) % queue.length);
    }
  }, [queue, queueIndex, shuffleMode]);

  const playPrev = useCallback(() => {
    if (queue.length === 0) return;
    setQueueIndex(i => (i - 1 + queue.length) % queue.length);
  }, [queue.length]);

  // ── Shuffle ────────────────────────────────────────────────────────────

  const toggleShuffle = useCallback(() => {
    setShuffleMode(prev => {
      const modes = ['off', 'shuffle', 'smart'];
      const next = modes[(modes.indexOf(prev) + 1) % modes.length];

      if (next === 'shuffle' && queue.length > 0) {
        // Save original order and shuffle
        originalQueueRef.current = [...queue];
        const currentSongObj = queue[queueIndex];
        const rest = queue.filter((_, i) => i !== queueIndex);
        const shuffled = [currentSongObj, ...shuffleArray(rest)];
        setQueue(shuffled);
        setQueueIndex(0);
      } else if (next === 'off' && originalQueueRef.current.length > 0) {
        // Restore original order
        const currentSongObj = queue[queueIndex];
        setQueue(originalQueueRef.current);
        const origIdx = originalQueueRef.current.findIndex(s => s.id === currentSongObj?.id);
        setQueueIndex(origIdx >= 0 ? origIdx : 0);
        originalQueueRef.current = [];
      }
      // 'smart' mode doesn't reorder — it picks randomly at playNext time

      return next;
    });
  }, [queue, queueIndex]);

  // ── Audio element event listeners ──────────────────────────────────────

  useEffect(() => {
    const audio = audioRef.current;
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => playNext();
    const onTimeUpdate = () => {
      if (audio.duration) setProgress((audio.currentTime / audio.duration) * 100);
    };
    const onDurationChange = () => setDuration(audio.duration);
    const onError = () => {
      if (!audio.getAttribute('src')) return;
      setIsPlaying(false);
      setError('Could not stream this Drive file. Re-sync or sign in again, then try the song once more.');
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
  }, [playNext]);

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
    if (audio.duration) {
      audio.currentTime = (pct / 100) * audio.duration;
    }
  }, []);

  const changeVolume = useCallback((v) => {
    audioRef.current.volume = v;
    setVolume(v);
  }, []);

  const clearError = useCallback(() => {
    setError('');
  }, []);

  const stop = useCallback(() => {
    clearSource();
    setCurrentSong(null);
  }, [clearSource]);

  const setQueueAndPlay = useCallback((songs, startIndex = 0) => {
    setError('');
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

  return {
    audioRef,
    currentSong,
    isPlaying,
    progress,
    duration,
    volume,
    error,
    queue,
    queueIndex,
    shuffleMode,
    loadAndPlay,
    togglePlay,
    seek,
    changeVolume,
    clearError,
    stop,
    playNext,
    playPrev,
    setQueueAndPlay,
    toggleShuffle,
  };
}
