import React, { useRef, useState } from 'react';
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
  MoreHorizontal,
  Plus,
  Trash2,
  ChevronDown,
  UploadCloud,
  BrainCircuit,
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
  if (status === 'blocked' || status === 'deleted') return { label: 'Deleted', icon: Trash2, className: 'song-status--error' };
  if (status === 'error' || status === 'failed') return { label: 'Failed', icon: AlertTriangle, className: 'song-status--error' };
  return { label: 'Request', icon: Download, className: 'song-status--missing' };
}

export function ExpandedPlayer({ player, onClose, hue, onToggleQueue }) {
  const {
    currentSong,
    isPlaying,
    progress,
    duration,
    shuffleMode,
    togglePlay,
    seek,
    playNext,
    playPrev,
    toggleShuffle,
  } = player;

  if (!currentSong) return null;

  return (
    <div className="expanded-player">
      <div className="expanded-player__bg" style={{ background: `linear-gradient(135deg, hsl(${hue}, 70%, 15%), hsl(${(hue + 60) % 360}, 70%, 5%))` }} />
      <div className="expanded-player__header">
        <button className="icon-btn" onClick={(e) => { e.stopPropagation(); onClose(); }} aria-label="Minimize player">
          <ChevronDown size={28} color="white" />
        </button>
      </div>

      <div className="expanded-player__content">
        <div className="expanded-player__art-container">
          <div
            className={`expanded-player__art ${isPlaying ? 'expanded-player__art--playing' : ''}`}
            style={{ background: `linear-gradient(135deg, hsl(${hue}, 70%, 45%), hsl(${(hue + 60) % 360}, 70%, 25%))` }}
          >
            <span className="expanded-player__art-icon">♪</span>
          </div>
        </div>

        <div className="expanded-player__info">
          <h2 className="expanded-player__title">{currentSong.track}</h2>
          <p className="expanded-player__artist">{currentSong.artist}</p>
        </div>

        <div className="expanded-player__controls-area">
          <div className="expanded-progress">
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

          <div className="expanded-controls">
            <button
              className={`icon-btn ${shuffleMode !== 'off' ? 'icon-btn--active' : ''}`}
              onClick={toggleShuffle}
              aria-label={`Shuffle: ${shuffleMode}`}
            >
              <Shuffle size={24} color={shuffleMode !== 'off' ? 'var(--green)' : 'white'} />
            </button>
            <button className="icon-btn" onClick={() => playPrev({ reason: 'user-prev' })} aria-label="Previous">
              <SkipBack size={36} color="white" />
            </button>
            <button className="play-btn play-btn--large" onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
              {isPlaying ? <Pause size={32} fill="black" /> : <Play size={32} fill="black" />}
            </button>
            <button className="icon-btn" onClick={() => playNext({ reason: 'user-next' })} aria-label="Next">
              <SkipForward size={36} color="white" />
            </button>
            <button className="icon-btn" onClick={onToggleQueue} aria-label="Queue" title="Queue">
              <ListMusic size={24} color="white" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function PlayerBar({ player, onToggleQueue }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const hue = player.currentSong ? player.currentSong.track.charCodeAt(0) % 360 : 0;

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
      <div className="player-song-info" onClick={() => currentSong && setIsExpanded(true)} style={{ cursor: currentSong ? 'pointer' : 'default' }}>
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
          <button className="icon-btn" onClick={() => playPrev({ reason: 'user-prev' })} aria-label="Previous">
            <SkipBack size={20} />
          </button>
          <button className="play-btn" onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
            {isPlaying ? <Pause size={22} fill="black" /> : <Play size={22} fill="black" />}
          </button>
          <button className="icon-btn" onClick={() => playNext({ reason: 'user-next' })} aria-label="Next">
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
      {isExpanded && <ExpandedPlayer player={player} onClose={() => setIsExpanded(false)} hue={hue} onToggleQueue={onToggleQueue} />}
    </div>
  );
}

export function SongCard({
  song,
  onPlay,
  onDownload,
  onAddToQueue,
  onPlayNext,
  onAddToPlaylist,
  onDeleteReady,
  isReadyLoose = false,
  isCurrentSong,
  isDownloading,
}) {
  const hue = song.track.charCodeAt(0) % 360;
  const status = statusDetails(song);
  const StatusIcon = status.icon;
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const pointerRef = useRef({ active: false, startX: 0, offset: 0, swiped: false });

  const closeMenu = () => setMenuOpen(false);
  const runAction = (event, action) => {
    event.stopPropagation();
    closeMenu();
    action?.(song);
  };

  const handlePointerDown = (event) => {
    if (!isReadyLoose) return;
    pointerRef.current = { active: true, startX: event.clientX, offset: 0, swiped: false };
  };

  const handlePointerMove = (event) => {
    if (!pointerRef.current.active) return;
    const offset = Math.max(-110, Math.min(110, event.clientX - pointerRef.current.startX));
    if (Math.abs(offset) > 8) pointerRef.current.swiped = true;
    pointerRef.current.offset = offset;
    setDragOffset(offset);
  };

  const handlePointerUp = () => {
    if (!pointerRef.current.active) return;
    const offset = pointerRef.current.offset || dragOffset;
    pointerRef.current.active = false;
    window.setTimeout(() => {
      pointerRef.current.swiped = false;
    }, 0);
    setDragOffset(0);
    if (offset <= -72) onDeleteReady?.(song);
    if (offset >= 72) onAddToPlaylist?.(song);
  };

  return (
    <div
      className={`song-card ${isCurrentSong ? 'song-card--active' : ''} ${isReadyLoose ? 'song-card--swipeable' : ''}`}
      style={isReadyLoose && dragOffset ? { transform: `translateX(${dragOffset}px)` } : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onClick={() => {
        if (pointerRef.current.swiped) return;
        onPlay(song);
      }}
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
      {song.syncStatus && song.syncStatus !== 'done' && (
        <div className="song-status song-status--downloading" title="Metadata sync is pending">
          <Cloud size={12} />
          <span>Sync {song.syncStatus}</span>
        </div>
      )}
      {song.embeddingStatus && song.embeddingStatus !== 'done' && (
        <div className="song-status song-status--queued" title="Embedding pipeline status">
          <Clock3 size={12} />
          <span>Embedding {song.embeddingStatus}</span>
        </div>
      )}
      <button
        className="song-card__menu-btn"
        onClick={event => {
          event.stopPropagation();
          setMenuOpen(open => !open);
        }}
        aria-label="Song actions"
        title="Song actions"
      >
        <MoreHorizontal size={18} />
      </button>
      {menuOpen && (
        <div className="song-card__actions" onClick={event => event.stopPropagation()}>
          <button onClick={event => runAction(event, onPlay)}>
            <Play size={15} />
            <span>Play</span>
          </button>
          {onPlayNext && (
            <button onClick={event => runAction(event, onPlayNext)}>
              <SkipForward size={15} />
              <span>Play next</span>
            </button>
          )}
          {onAddToQueue && (
            <button onClick={event => runAction(event, onAddToQueue)}>
              <ListMusic size={15} />
              <span>Add to queue</span>
            </button>
          )}
          <button onClick={event => runAction(event, onDownload)} disabled={isDownloading}>
            <Download size={15} />
            <span>{song.driveFileId ? 'Offline' : 'Download'}</span>
          </button>
          {onAddToPlaylist && (
            <button onClick={event => runAction(event, onAddToPlaylist)}>
              <Plus size={15} />
              <span>Playlist</span>
            </button>
          )}
          {onDeleteReady && (
            <button className="song-card__actions-danger" onClick={event => runAction(event, onDeleteReady)}>
              <Trash2 size={15} />
              <span>Delete</span>
            </button>
          )}
        </div>
      )}
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

const IMPORT_STATUS_LABELS = {
  waiting: 'Waiting',
  importing: 'Importing',
  'reading-metadata': 'Reading metadata',
  duplicate: 'Duplicate detected',
  complete: 'Complete',
  failed: 'Failed',
};

export function ImportStatusPanel({ jobs = [], embeddingJobs = [] }) {
  const visibleJobs = jobs.slice(0, 5);
  const visibleEmbeddings = embeddingJobs.filter(job => ['queued', 'processing', 'failed'].includes(job.status)).slice(0, 3);
  if (!visibleJobs.length && !visibleEmbeddings.length) return null;
  return (
    <section className="import-status-panel" aria-label="Import pipeline status">
      <div className="import-status-panel__header">
        <div>
          <UploadCloud size={18} />
          <strong>Import pipeline</strong>
        </div>
        <span>{jobs.filter(job => !['complete', 'duplicate'].includes(job.status)).length || 'Ready'}</span>
      </div>
      <div className="import-status-panel__list">
        {visibleJobs.map(job => (
          <div className="import-status-row" key={job.jobId}>
            <div className="import-status-row__copy">
              <span>{job.fileName || job.songKey || 'Audio file'}</span>
              <small>{IMPORT_STATUS_LABELS[job.status] || job.status}{job.message ? ` · ${job.message}` : ''}</small>
            </div>
            <div className="import-progress" aria-label={`${Math.round((job.progress || 0) * 100)} percent complete`}>
              <span style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} />
            </div>
          </div>
        ))}
        {visibleEmbeddings.map(job => (
          <div className="import-status-row import-status-row--embedding" key={job.jobId}>
            <div className="import-status-row__copy">
              <span><BrainCircuit size={14} /> Embedding {job.songKey}</span>
              <small>{job.status === 'processing' ? 'Generating embedding' : job.status === 'failed' ? 'Retry required' : 'Queued'}</small>
            </div>
            <div className="import-progress" aria-label="Embedding status">
              <span style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
