import { useState, useRef, useEffect, useCallback } from 'react';

function driveStreamUrl(fileId, accessToken) {
  const params = new URLSearchParams({
    alt: 'media',
    access_token: accessToken,
  });
  return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`;
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
  const blobUrlRef = useRef(null);

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

  const playNext = useCallback(() => {
    setQueueIndex(currentIndex => (
      queue.length === 0 ? currentIndex : (currentIndex + 1) % queue.length
    ));
  }, [queue.length]);

  const playPrev = useCallback(() => {
    setQueueIndex(currentIndex => (
      queue.length === 0 ? currentIndex : (currentIndex - 1 + queue.length) % queue.length
    ));
  }, [queue.length]);

  // Sync isPlaying state from audio element events
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

  const loadAndPlay = useCallback(async (song, accessToken) => {
    const audio = audioRef.current;
    setError('');

    // Revoke old Blob URL to free memory
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }

    audio.pause();

    if (song.isDownloaded && song.blob) {
      // Play from local IndexedDB blob — instant, no network needed
      const url = URL.createObjectURL(song.blob);
      blobUrlRef.current = url;
      audio.src = url;
      setCurrentSong(song);
    } else if (song.driveFileId && accessToken) {
      // Let the browser stream directly from Drive instead of fetching the
      // entire MP3 into IndexedDB.
      audio.preload = 'metadata';
      audio.src = driveStreamUrl(song.driveFileId, accessToken);
      setCurrentSong(song);
    } else {
      clearSource();
      setCurrentSong(null);
      setError(
        song.driveFileId
          ? 'Google Drive sign-in is required before this song can stream.'
          : `"${song.track}" is not available to play yet. Download it first so the Drive worker can prepare it.`
      );
      return;
    }

    audio.volume = volume;
    audio.play().catch(e => {
      console.error('Playback error:', e);
      setError(e instanceof Error ? e.message : 'Playback failed.');
    });
  }, [clearSource, volume]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (audio.paused) {
      audio.play().catch(console.error);
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
    setQueue(songs);
    setQueueIndex(startIndex);
  }, []);

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
    loadAndPlay,
    togglePlay,
    seek,
    changeVolume,
    clearError,
    stop,
    playNext,
    playPrev,
    setQueueAndPlay,
  };
}
