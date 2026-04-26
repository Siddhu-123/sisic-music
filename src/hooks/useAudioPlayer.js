import { useState, useRef, useEffect, useCallback } from 'react';
import { db } from '../db';

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

    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('durationchange', onDurationChange);
    return () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('durationchange', onDurationChange);
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

    setCurrentSong(song);
    audio.pause();

    if (song.isDownloaded && song.blob) {
      // Play from local IndexedDB blob — instant, no network needed
      const url = URL.createObjectURL(song.blob);
      blobUrlRef.current = url;
      audio.src = url;
    } else if (accessToken && song.driveFileId) {
      // Stream from Drive API with auth header
      // We must fetch it as a blob because <audio> can't send custom headers
      try {
        const response = await fetch(
          `https://www.googleapis.com/drive/v3/files/${song.driveFileId}?alt=media`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (response.ok) {
          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          blobUrlRef.current = url;
          audio.src = url;
          // Cache it in IndexedDB for offline use next time
          db.songs.where('driveFileId').equals(song.driveFileId).modify({ blob, isDownloaded: true });
        } else {
          const message = `Drive stream failed with status ${response.status}.`;
          console.error(message);
          setError(message);
          return;
        }
      } catch (e) {
        console.error('Streaming error:', e);
        setError(e instanceof Error ? e.message : 'Streaming failed.');
        return;
      }
    } else {
      setError(`"${song.track}" is not available to play yet. Download it first so the Drive worker can prepare it.`);
      return;
    }

    audio.volume = volume;
    audio.play().catch(e => {
      console.error('Playback error:', e);
      setError(e instanceof Error ? e.message : 'Playback failed.');
    });
  }, [volume]);

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
    playNext,
    playPrev,
    setQueueAndPlay,
  };
}
