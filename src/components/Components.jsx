import React from 'react';
import {
  Play,
  Pause,
  SkipForward,
  SkipBack,
  Volume2,
  Download,
  CheckCircle2,
  Shuffle,
  ListMusic,
  Clock3,
  AlertTriangle,
  Cloud,
  HardDriveDownload,
} from 'lucide-react';

function formatTime(seconds) {
  if (!seconds || Number.isNaN(seconds)) return '0:00';
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${secs}`;
}

function statusDetails(song) {
  const status = song.status || song.downloadJob?.status;
  if (song.isDownloaded) return { label: 'Offline', icon: CheckCircle2, className: 'song-status--ready' };
  if (song.isCached || song.hasBlob) return { label: 'Cached', icon: HardDriveDownload, className: 'song-status--ready' };
  if (song.driveFileId) return { label: 'Ready', icon: Cloud, className: 'song-status--ready' };
  if (status === 'queued') return { label: 'Queued', icon: Clock3, className: 'song-status--queued' };
  if (status === 'downloading') return { label: 'Downloading', icon: Clock3, className: 'song-status--downloading' };
  if (status === 'done') return { label: 'Ready', icon: Cloud, className: 'song-status--ready' };
  if (status === 'error' || status === 'failed') return { label: 'Failed', icon: AlertTriangle, className: 'song-status--error' };
  return { label: 'Request', icon: Download, className: 'song-status--missing' };
}

export function PlayerBar({ player, onToggleQueue }) {
  const {
    currentSong,
    isPlaying,
    progress,
    duration,
    volume,
    shuffleMode,
    togglePlay,
    seek,
    changeVolume,
    playNext,
    playPrev,
    toggleShuffle,
  } = player;

  return (
    <div className="player-bar">
      <div className="player-song-info">
        {currentSong ? (
          <>
            <div className="player-thumb" />
            <div className="player-meta">
              <span className="player-track">{currentSong.track}</span>
              <span className="player-artist">{currentSong.artist}</span>
            </div>
            {currentSong.isDownloaded || currentSong.isCached || currentSong.hasBlob
              ? <CheckCircle2 size={16} color="var(--green)" style={{ marginLeft: 'auto' }} />
              : <Cloud size={16} color="var(--text-muted)" style={{ marginLeft: 'auto' }} />
            }
          </>
        ) : (
          <span className="player-artist">Nothing playing</span>
        )}
      </div>

      <div className="player-controls">
        <div className="player-buttons">
          <button
            className={`icon-btn ${shuffleMode !== 'off' ? 'icon-btn--active' : ''}`}
            onClick={toggleShuffle}
            aria-label={`Shuffle: ${shuffleMode}`}
            title={`Shuffle: ${shuffleMode}`}
          >
            <Shuffle size={16} />
          </button>
          <button className="icon-btn" onClick={playPrev} aria-label="Previous">
            <SkipBack size={20} />
          </button>
          <button className="play-btn" onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
            {isPlaying ? <Pause size={22} fill="black" /> : <Play size={22} fill="black" />}
          </button>
          <button className="icon-btn" onClick={playNext} aria-label="Next">
            <SkipForward size={20} />
          </button>
          <button className="icon-btn" onClick={onToggleQueue} aria-label="Queue" title="Queue">
            <ListMusic size={16} />
          </button>
        </div>
        <div className="progress-row">
          <span className="time-label">{formatTime((progress / 100) * duration)}</span>
          <input
            type="range"
            className="progress-bar"
            min={0}
            max={100}
            step={0.1}
            value={progress}
            onChange={event => seek(Number(event.target.value))}
          />
          <span className="time-label">{formatTime(duration)}</span>
        </div>
      </div>

      <div className="player-volume">
        <Volume2 size={18} color="var(--text-muted)" />
        <input
          type="range"
          className="volume-bar"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={event => changeVolume(Number(event.target.value))}
        />
      </div>
    </div>
  );
}

export function SongCard({ song, onPlay, onDownload, isCurrentSong, isDownloading }) {
  const hue = song.track.charCodeAt(0) % 360;
  const status = statusDetails(song);
  const StatusIcon = status.icon;

  return (
    <div
      className={`song-card ${isCurrentSong ? 'song-card--active' : ''}`}
      onClick={() => onPlay(song)}
      role="button"
      tabIndex={0}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onPlay(song);
        }
      }}
    >
      <div
        className="song-card__art"
        style={{ background: `linear-gradient(135deg, hsl(${hue}, 70%, 35%), hsl(${(hue + 60) % 360}, 70%, 20%))` }}
      >
        {isCurrentSong
          ? <div className="song-card__playing-bars"><span /><span /><span /></div>
          : <Play size={32} className="song-card__play-icon" fill="white" />
        }
      </div>
      <div className="song-card__info">
        <p className="song-card__title">{song.track}</p>
        <p className="song-card__artist">{song.artist}</p>
      </div>
      <div className={`song-status ${status.className}`} title={song.downloadJob?.lastError || status.label}>
        <StatusIcon size={12} />
        <span>{status.label}</span>
      </div>
      <button
        className="song-card__dl-btn"
        onClick={event => { event.stopPropagation(); onDownload(song); }}
        aria-label={song.isDownloaded ? 'Offline available' : 'Cache or request song'}
        disabled={isDownloading}
      >
        {isDownloading
          ? <div className="spinner" />
          : song.isDownloaded || song.isCached || song.hasBlob
            ? <CheckCircle2 size={18} color="var(--green)" />
            : <Download size={18} color="var(--text-muted)" />
        }
      </button>
    </div>
  );
}

export function LoginScreen({ onLogin, error }) {
  return (
    <div className="login-screen">
      <div className="login-glow" />
      <div className="login-card">
        <div className="login-logo">
          <span className="login-logo__icon">♪</span>
        </div>
        <h1 className="login-title">Sisic Music</h1>
        <p className="login-sub">Your music. Everywhere. Offline.</p>
        <button className="btn-primary login-btn" onClick={onLogin}>
          Sign in with Google
        </button>
        {error && <p className="login-error" role="alert">{error}</p>}
        <p className="login-hint">Connect to your Google Drive music library</p>
      </div>
    </div>
  );
}

export function SyncBanner({ isSyncing, syncStatus, error, onSync, actionLabel, onAction }) {
  if (!syncStatus && !isSyncing) return null;
  return (
    <div
      className={`sync-banner ${isSyncing ? 'sync-banner--loading' : ''} ${error ? 'sync-banner--error' : ''}`}
      role={error ? 'alert' : 'status'}
    >
      {isSyncing && <div className="spinner" />}
      <span>{syncStatus}</span>
      {!isSyncing && actionLabel && onAction && (
        <button className="sync-refresh-btn" onClick={onAction}>{actionLabel}</button>
      )}
      {!isSyncing && !error && !actionLabel && (
        <button className="sync-refresh-btn" onClick={onSync}>Sync again</button>
      )}
    </div>
  );
}
