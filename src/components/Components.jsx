import React from 'react';
import { Play, Pause, SkipForward, SkipBack, Volume2, Download, CheckCircle2 } from 'lucide-react';

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export function PlayerBar({ player }) {
  const { currentSong, isPlaying, progress, duration, volume, togglePlay, seek, changeVolume, playNext, playPrev } = player;

  return (
    <div className="player-bar">
      {/* Song Info */}
      <div className="player-song-info">
        {currentSong ? (
          <>
            <div className="player-thumb" />
            <div className="player-meta">
              <span className="player-track">{currentSong.track}</span>
              <span className="player-artist">{currentSong.artist}</span>
            </div>
            {currentSong.isDownloaded
              ? <CheckCircle2 size={16} color="var(--green)" style={{ marginLeft: 'auto' }} />
              : <Download size={16} color="var(--text-muted)" style={{ marginLeft: 'auto' }} />
            }
          </>
        ) : (
          <span className="player-artist">Nothing playing</span>
        )}
      </div>

      {/* Controls */}
      <div className="player-controls">
        <div className="player-buttons">
          <button className="icon-btn" onClick={playPrev} aria-label="Previous">
            <SkipBack size={20} />
          </button>
          <button className="play-btn" onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
            {isPlaying ? <Pause size={22} fill="black" /> : <Play size={22} fill="black" />}
          </button>
          <button className="icon-btn" onClick={playNext} aria-label="Next">
            <SkipForward size={20} />
          </button>
        </div>
        <div className="progress-row">
          <span className="time-label">{formatTime((progress / 100) * duration)}</span>
          <input
            type="range"
            className="progress-bar"
            min={0} max={100} step={0.1}
            value={progress}
            onChange={e => seek(Number(e.target.value))}
          />
          <span className="time-label">{formatTime(duration)}</span>
        </div>
      </div>

      {/* Volume */}
      <div className="player-volume">
        <Volume2 size={18} color="var(--text-muted)" />
        <input
          type="range"
          className="volume-bar"
          min={0} max={1} step={0.01}
          value={volume}
          onChange={e => changeVolume(Number(e.target.value))}
        />
      </div>
    </div>
  );
}

export function SongCard({ song, onPlay, onDownload, isCurrentSong, isDownloading }) {
  // Generate a stable gradient color from the song title
  const hue = song.track.charCodeAt(0) % 360;

  return (
    <div
      className={`song-card ${isCurrentSong ? 'song-card--active' : ''}`}
      onClick={() => onPlay(song)}
    >
      <div
        className="song-card__art"
        style={{ background: `linear-gradient(135deg, hsl(${hue}, 70%, 35%), hsl(${(hue + 60) % 360}, 70%, 20%))` }}
      >
        {isCurrentSong
          ? <div className="song-card__playing-bars">
              <span /><span /><span />
            </div>
          : <Play size={32} className="song-card__play-icon" fill="white" />
        }
      </div>
      <div className="song-card__info">
        <p className="song-card__title">{song.track}</p>
        <p className="song-card__artist">{song.artist}</p>
      </div>
      <button
        className="song-card__dl-btn"
        onClick={e => { e.stopPropagation(); onDownload(song); }}
        aria-label={song.isDownloaded ? 'Offline available' : 'Download for offline'}
        disabled={isDownloading}
      >
        {song.isDownloaded
          ? <CheckCircle2 size={18} color="var(--green)" />
          : isDownloading
            ? <div className="spinner" />
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

export function SyncBanner({ isSyncing, syncStatus, error, onSync }) {
  if (!syncStatus && !isSyncing) return null;
  return (
    <div
      className={`sync-banner ${isSyncing ? 'sync-banner--loading' : ''} ${error ? 'sync-banner--error' : ''}`}
      role={error ? 'alert' : 'status'}
    >
      {isSyncing && <div className="spinner" />}
      <span>{syncStatus}</span>
      {!isSyncing && !error && (
        <button className="sync-refresh-btn" onClick={onSync}>Sync again</button>
      )}
    </div>
  );
}
