import React, { useEffect, useId, useRef, useState } from 'react';
import {
  Play,
  Pause,
  SkipForward,
  SkipBack,
  Volume2,
  Download,
  CheckCircle2,
  Shuffle,
  Repeat,
  ListMusic,
  Clock3,
  AlertTriangle,
  Cloud,
  HardDriveDownload,
  Plus,
  Trash2,
  ChevronDown,
  UploadCloud,
  BrainCircuit,
  Laptop,
  Info,
  ThumbsUp,
  RefreshCw,
  Link2,
  X,
  Sliders,
  Sparkles,
  ExternalLink,
  Heart,
  Copy,
  FolderOpen,
} from 'lucide-react';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import { Turntable } from './Turntable.jsx';
function resizeArtworkUrl(url = '', size = 300) {
  if (!url || url.startsWith('data:') || url.startsWith('blob:')) return url;
  const safeSize = Math.max(60, Math.round(Number(size) || 300));
  return url.replace(/\/\d+x\d+bb\./i, `/${safeSize}x${safeSize}bb.`);
}

export function AsyncArtworkImage({ song, className = '', fallbackSize = 24, alt = '', size = 300, sizes, priority = false }) {
  const [fetchedArtUrl, setFetchedArtUrl] = useState('');

  useEffect(() => {
    let active = true;
    if (!song) return undefined;
    import('../services/artworkService.js')
      .then(({ getSongArtwork }) => getSongArtwork(song))
      .then(res => {
        if (active && res?.coverArtUrl) setFetchedArtUrl(res.coverArtUrl);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [song]);

  const artUrl = resizeArtworkUrl(fetchedArtUrl || song?.coverArtUrl, size);
  const hue = song?.track ? song.track.charCodeAt(0) % 360 : 200;

  if (artUrl) {
    return (
      <img
        src={artUrl}
        alt={alt || `${song?.track || 'Song'} cover`}
        className={className}
        width={size}
        height={size}
        sizes={sizes}
        loading={priority ? 'eager' : 'lazy'}
        fetchPriority={priority ? 'high' : 'low'}
        decoding="async"
      />
    );
  }

  return (
    <div
      className={`${className} artwork-fallback`}
      style={{ background: `linear-gradient(135deg, hsl(${hue}, 70%, 35%), hsl(${(hue + 60) % 360}, 70%, 20%))` }}
    >
      <span style={{ fontSize: `${fallbackSize}px` }}>♪</span>
    </div>
  );
}

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

export function ExpandedPlayer({
  player,
  onClose,
  hue,
  onToggleQueue,
  onOpenSongInfo,
  onAddToPlaylist,
  onDelete,
  onReview,
  onDownload,
  onPlayNext,
  onAddToQueue,
  onOpenEqualizer,
  onMoreLikeThis,
}) {
  const {
    currentSong,
    isPlaying,
    isSpinningDown,
    progress,
    duration,
    shuffleMode,
    togglePlay,
    seek,
    playNext,
    playPrev,
    toggleShuffle,
    repeatMode,
    toggleRepeat,
    rpm,
    setRpm,
    pitchModifier,
    pitchRange,
    setPitchModifier,
    setPitchRange,
    beginScratch,
    setScratchAngularVelocity,
    endScratch,
    setNeedleLifted,
    queue,
    queueIndex,
    playQueueItem,
    stop,
  } = player;

  const [progressPreview, setProgressPreview] = useState(null);
  const displayedProgress = progressPreview ?? progress;

  if (!currentSong) return null;

  return (
    <div className="expanded-player">
      <div className="expanded-player__bg" style={{ background: `linear-gradient(135deg, hsl(${hue}, 70%, 15%), hsl(${(hue + 60) % 360}, 70%, 5%))` }} />
      <div className="expanded-player__header">
        <div style={{ display: 'flex', gap: '8px' }}>
          {onOpenEqualizer && (
            <button className="icon-btn" onClick={(e) => { e.stopPropagation(); onOpenEqualizer(); }} aria-label="Equalizer" title="Equalizer">
              <Sliders size={22} color="white" />
            </button>
          )}
          {onMoreLikeThis && (
            <button className="icon-btn" onClick={(e) => { e.stopPropagation(); onMoreLikeThis(currentSong); }} aria-label="More Like This" title="More Like This">
              <Sparkles size={22} color="white" />
            </button>
          )}
        </div>
        <button className="icon-btn" onClick={(e) => { e.stopPropagation(); onClose(); }} aria-label="Minimize player">
          <ChevronDown size={28} color="white" />
        </button>
      </div>

      <div className="expanded-player__content">
        <div className="expanded-player__layout">
          <div className="expanded-player__art-container">
            <Turntable
              currentSong={currentSong}
              artwork={<AsyncArtworkImage song={currentSong} alt={`${currentSong.track} cover`} className="turntable__art" fallbackSize={28} size={400} priority />}
              isPlaying={isPlaying}
              isBraking={isSpinningDown}
              progress={displayedProgress}
              duration={duration}
              rpm={rpm}
              pitchModifier={pitchModifier}
              pitchRange={pitchRange}
              queue={queue}
              queueIndex={queueIndex}
              onTogglePlay={togglePlay}
              onSeek={seek}
              onScratchStart={beginScratch}
              onScratchVelocity={setScratchAngularVelocity}
              onScratchEnd={endScratch}
              onNeedleLift={setNeedleLifted}
              onEject={stop}
              onProgressPreview={setProgressPreview}
              onLoadSong={song => {
                const nextIndex = queue.findIndex(item => (item.songKey || item.id) === (song.songKey || song.id));
                if (nextIndex >= 0) playQueueItem(nextIndex);
              }}
              onPitchChange={setPitchModifier}
              onPitchRangeChange={setPitchRange}
              onRpmChange={setRpm}
            />
          </div>

          <div className="expanded-player__details-column">
            <div className="expanded-player__info">
              <h2 className="expanded-player__title">{currentSong.track}</h2>
              <p className="expanded-player__artist">{currentSong.artist}</p>
            </div>

            <div className="expanded-player__metadata">
              <section className="expanded-player__text-panel">
                <h3>Lyrics</h3>
                <p>{currentSong.lyrics || 'Lyrics will appear here when song metadata is available.'}</p>
              </section>
              <section className="expanded-player__text-panel">
                <h3>Description</h3>
                <p>{currentSong.description || 'Song description and credits will appear here when available.'}</p>
              </section>
            </div>

            <div className="expanded-player__controls-area">
            <div className="expanded-progress">
            <span className="time-label">{formatTime((displayedProgress / 100) * duration)}</span>
            <input
              type="range"
              className="progress-bar"
              min={0}
              max={100}
              step={0.1}
              value={displayedProgress}
              onChange={event => {
                setProgressPreview(null);
                seek(Number(event.target.value));
              }}
              aria-label="Playback position"
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
            <button className={`icon-btn ${repeatMode !== 'off' ? 'icon-btn--active' : ''}`} onClick={toggleRepeat} aria-label={`Repeat: ${repeatMode}`}>
              <Repeat size={22} color={repeatMode !== 'off' ? 'var(--green)' : 'white'} />
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
              <div className="expanded-player__actions" role="group" aria-label="Song actions">
                <button className="panel-action-btn" onClick={() => onOpenSongInfo?.(currentSong)}><Info size={16} /> Info</button>
                <button className="panel-action-btn" onClick={() => onAddToPlaylist?.(currentSong)}><Plus size={16} /> Playlist</button>
                <button className="panel-action-btn" onClick={() => onPlayNext?.(currentSong)}><SkipForward size={16} /> Play next</button>
                <button className="panel-action-btn" onClick={() => onAddToQueue?.(currentSong)}><ListMusic size={16} /> Queue</button>
                <button className="panel-action-btn" onClick={() => onDownload?.(currentSong)}><Download size={16} /> Offline</button>
                <button className="panel-action-btn" onClick={() => onReview?.(currentSong)}><RefreshCw size={16} /> Review</button>
                <button className="panel-action-btn panel-action-btn--danger" onClick={() => onDelete?.(currentSong)}><Trash2 size={16} /> Delete</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function PlayerBar({
  player,
  onToggleQueue,
  onOpenSongInfo,
  onAddToPlaylist,
  onDelete,
  onReview,
  onDownload,
  onPlayNext,
  onAddToQueue,
  onOpenEqualizer,
  onMoreLikeThis,
}) {
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
            <AsyncArtworkImage song={currentSong} className="player-thumb" fallbackSize={16} size={96} sizes="64px" priority />
            <div className="player-meta">
              <span className="player-track">{currentSong.track}</span>
              <span className="player-artist">{currentSong.artist}</span>
            </div>
            {currentSong.isDownloaded || currentSong.isCached || currentSong.hasBlob
              ? <CheckCircle2 size={16} color="var(--green)" style={{ marginLeft: 'auto' }} />
              : <Cloud size={16} color="var(--text-muted)" style={{ marginLeft: 'auto' }} />
            }
            <button className="icon-btn player-info-btn" onClick={event => { event.stopPropagation(); onOpenSongInfo?.(currentSong); }} aria-label="Song info" title="Song info">
              <Info size={16} />
            </button>
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
            aria-label="Playback position"
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
          aria-label="Volume"
        />
      </div>
      {isExpanded && (
        <ExpandedPlayer
          key={currentSong?.songKey || 'expanded-player'}
          player={player}
          onClose={() => setIsExpanded(false)}
          hue={hue}
          onToggleQueue={onToggleQueue}
          onOpenSongInfo={onOpenSongInfo}
          onAddToPlaylist={onAddToPlaylist}
          onDelete={onDelete}
          onReview={onReview}
          onDownload={onDownload}
          onPlayNext={onPlayNext}
          onAddToQueue={onAddToQueue}
          onOpenEqualizer={onOpenEqualizer}
          onMoreLikeThis={onMoreLikeThis}
        />
      )}
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
  onMarkDuplicate,
  onRestoreDuplicate,
  onReview,
  onInfo,
  onMoreLikeThis,
  onToggleLike,
  isLiked = false,
  isReadyLoose = false,
  isCurrentSong,
  isDownloading,
}) {
  const status = statusDetails(song);
  const StatusIcon = status.icon;
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const menuId = useId();
  const cardRef = useRef(null);
  const menuRef = useRef(null);
  const longPressTimerRef = useRef(null);
  const longPressTriggeredRef = useRef(false);
  const pointerRef = useRef({ active: false, startX: 0, offset: 0, swiped: false });

  const closeMenu = () => setMenuOpen(false);
  const clearLongPress = () => {
    if (longPressTimerRef.current) window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  };
  const runAction = (event, action) => {
    event.stopPropagation();
    closeMenu();
    action?.(song);
  };

  const openMenu = () => setMenuOpen(true);

  const handleCardContextMenu = event => {
    event.preventDefault();
    event.stopPropagation();
    openMenu();
  };

  const handleCardKeyDown = event => {
    if (event.defaultPrevented || !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return;
    event.preventDefault();
    openMenu();
  };

  const handlePointerDown = (event) => {
    if (event.target.closest('.song-card__dl-btn, .song-card__actions')) return;
    longPressTriggeredRef.current = false;
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTriggeredRef.current = true;
      pointerRef.current.active = false;
      setDragOffset(0);
      setMenuOpen(true);
    }, 480);
    if (isReadyLoose) {
      pointerRef.current = { active: true, startX: event.clientX, offset: 0, swiped: false };
    }
  };

  const handlePointerMove = (event) => {
    if (Math.abs(event.clientX - (pointerRef.current.startX || event.clientX)) > 8) clearLongPress();
    if (!pointerRef.current.active) return;
    const offset = Math.max(-110, Math.min(110, event.clientX - pointerRef.current.startX));
    if (Math.abs(offset) > 8) pointerRef.current.swiped = true;
    pointerRef.current.offset = offset;
    setDragOffset(offset);
  };

  const handlePointerUp = () => {
    clearLongPress();
    if (longPressTriggeredRef.current) {
      pointerRef.current.active = false;
      setDragOffset(0);
      window.setTimeout(() => {
        longPressTriggeredRef.current = false;
      }, 0);
      return;
    }
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

  useEffect(() => {
    return () => clearLongPress();
  }, []);

  useEffect(() => {
    if (!menuOpen) return undefined;
    menuRef.current?.querySelector('[role="menuitem"]')?.focus();
    const handlePointerDownOutside = event => {
      if (!cardRef.current?.contains(event.target)) closeMenu();
    };
    const handleEscape = event => {
      if (event.key !== 'Escape') return;
      closeMenu();
      cardRef.current?.querySelector('.song-card__primary')?.focus();
    };
    document.addEventListener('pointerdown', handlePointerDownOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDownOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [menuOpen]);

  const handleMenuKeyDown = event => {
    const items = [...(menuRef.current?.querySelectorAll('[role="menuitem"]:not(:disabled)') || [])];
    if (!items.length) return;
    if (event.key === 'Tab') {
      closeMenu();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (currentIndex + 1 + items.length) % items.length
          : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex].focus();
  };

  const actionItems = [
    { label: isCurrentSong ? 'Resume' : 'Play', icon: Play, action: onPlay },
    onPlayNext && { label: 'Next', icon: SkipForward, action: onPlayNext },
    onAddToQueue && { label: 'Queue', icon: ListMusic, action: onAddToQueue },
    onToggleLike && { label: isLiked ? 'Unlike' : 'Like', icon: Heart, action: onToggleLike, fill: isLiked ? 'currentColor' : 'none' },
    onDownload && { label: song.driveFileId ? 'Offline' : 'Download', icon: Download, action: onDownload, disabled: isDownloading },
    onAddToPlaylist && { label: 'Playlist', icon: Plus, action: onAddToPlaylist },
    onReview && { label: 'Review', icon: RefreshCw, action: onReview },
    onInfo && { label: 'Info', icon: Info, action: onInfo },
    onMoreLikeThis && { label: 'Similar', icon: Sparkles, action: onMoreLikeThis },
    onMarkDuplicate && { label: 'Duplicate', icon: Copy, action: onMarkDuplicate, danger: true },
    onRestoreDuplicate && { label: 'Restore', icon: FolderOpen, action: onRestoreDuplicate },
    onDeleteReady && { label: 'Delete', icon: Trash2, action: onDeleteReady, danger: true },
  ].filter(Boolean);

  const actionRadius = actionItems.length > 9 ? 190 : actionItems.length > 6 ? 150 : 112;
  const actionStyle = index => {
    const angle = actionItems.length <= 1 ? -90 : -170 + ((index / (actionItems.length - 1)) * 160);
    const radians = angle * (Math.PI / 180);
    return {
      '--arc-x': `${Math.cos(radians) * actionRadius}px`,
      '--arc-y': `${Math.sin(radians) * actionRadius}px`,
      '--arc-delay': `${index * 24}ms`,
    };
  };

  return (
    <article
      ref={cardRef}
      className={`song-card ${isCurrentSong ? 'song-card--active' : ''} ${isReadyLoose ? 'song-card--swipeable' : ''} ${menuOpen ? 'song-card--actions-open' : ''}`}
      style={isReadyLoose && dragOffset ? { transform: `translateX(${dragOffset}px)` } : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onContextMenu={handleCardContextMenu}
    >
      <button
        className="song-card__primary"
        onClick={() => {
          if (pointerRef.current.swiped) return;
          onPlay(song);
        }}
        onKeyDown={handleCardKeyDown}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
        aria-label={`${isCurrentSong ? 'Resume' : 'Play'} ${song.track} by ${song.artist}`}
      >
        <div className="song-card__art-wrapper">
          <AsyncArtworkImage song={song} className="song-card__art" fallbackSize={18} size={300} sizes="(max-width: 768px) 45vw, 220px" />
          {isCurrentSong && (
            <div className="song-card__playing-bars"><span /><span /><span /></div>
          )}
        </div>
        <div className="song-card__info">
          <p className="song-card__title">{song.track}</p>
          <p className="song-card__artist">{song.artist}</p>
        </div>
      </button>
      <div className="song-card__footer">
        <div className="song-card__status-stack">
          <div className={`song-status ${status.className}`} data-status-label={status.label} title={song.downloadJob?.lastError || status.label}>
            <StatusIcon size={12} />
            <span>{status.label}</span>
          </div>
          {song.syncStatus && song.syncStatus !== 'done' && (
            <div className="song-status song-status--downloading" data-status-label="Sync queued" title="Metadata sync is pending">
              <Cloud size={12} />
              <span>Sync {song.syncStatus}</span>
            </div>
          )}
          {song.embeddingStatus && song.embeddingStatus !== 'done' && (
            <div className="song-status song-status--queued" data-status-label="Analysis queued" title="Embedding pipeline status">
              <Clock3 size={12} />
              <span>Embedding {song.embeddingStatus}</span>
            </div>
          )}
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
      {menuOpen && (
        <div ref={menuRef} id={menuId} className="song-card__actions song-card__actions--arc" role="menu" aria-label={`Actions for ${song.track}`} onClick={event => event.stopPropagation()} onKeyDown={handleMenuKeyDown}>
          {actionItems.map((item, index) => {
            const Icon = item.icon;
            return (
              <button key={item.label} role="menuitem" className={item.danger ? 'song-card__actions-danger' : ''} style={actionStyle(index)} onClick={event => runAction(event, item.action)} disabled={item.disabled}>
                <Icon size={16} fill={item.fill || 'none'} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </article>
  );
}

export function SongInfoPanel({ song, onClose, onPlay, onPlayNext, onAddToQueue, onAddToPlaylist, onReview, onDelete, onMarkDuplicate, onRestoreDuplicate, onSave, onDownload, isDownloading = false }) {
  const dialogRef = useDialogFocus(true, onClose);
  const status = statusDetails(song);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(() => ({
      artist: song.artist || '',
      track: song.track || '',
      album: song.album || '',
      genre: song.genre || '',
      releaseDate: song.releaseDate || '',
      description: song.description || '',
      lyrics: song.lyrics || '',
    }));

  const setField = (field, value) => setForm(previous => ({ ...previous, [field]: value }));
  const save = async () => {
    setSaving(true);
    try {
      await onSave?.(song, form);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="song-info-panel" role="dialog" aria-modal="true" aria-labelledby="song-info-title" tabIndex={-1}>
        <div className="panel-header">
          <div>
            <span className="song-info-panel__eyebrow">Song information</span>
            <h2 id="song-info-title">{song.track}</h2>
            <p>{song.artist}{song.album ? ` · ${song.album}` : ''}</p>
          </div>
          <div className="song-info-panel__header-actions">
            {onSave && <button className="panel-action-btn" onClick={() => setEditing(value => !value)}>{editing ? 'Cancel edit' : 'Edit details'}</button>}
            <button data-dialog-autofocus className="icon-btn" onClick={onClose} aria-label="Close song info"><X size={20} /></button>
          </div>
        </div>

        <div className="song-info-panel__hero">
          <div className="song-info-panel__art" role="img" aria-label="Song artwork placeholder">♪</div>
          <div>
            <strong>{status.label}</strong>
            <span>{song.filename || song.driveFileId || 'No Drive file linked yet'}</span>
            <span>{song.album || 'Album not available'}</span>
          </div>
        </div>

        <div className="song-info-panel__actions">
          <button className="panel-action-btn panel-action-btn--primary" onClick={() => onPlay?.(song)}><Play size={16} /> Play</button>
          <button className="panel-action-btn" onClick={() => onPlayNext?.(song)}><SkipForward size={16} /> Play next</button>
          <button className="panel-action-btn" onClick={() => onAddToQueue?.(song)}><ListMusic size={16} /> Queue</button>
          <button className="panel-action-btn" onClick={() => onAddToPlaylist?.(song)}><Plus size={16} /> Playlist</button>
          <button className="panel-action-btn" onClick={() => onDownload?.(song)} disabled={isDownloading}><Download size={16} /> Offline</button>
          <button className="panel-action-btn" onClick={() => onReview?.(song)}><RefreshCw size={16} /> Suggest source</button>
          {onMarkDuplicate && <button className="panel-action-btn panel-action-btn--danger" onClick={() => onMarkDuplicate(song)}><Copy size={16} /> Mark duplicate</button>}
          {onRestoreDuplicate && <button className="panel-action-btn" onClick={() => onRestoreDuplicate(song)}><FolderOpen size={16} /> Restore to Ready</button>}
          {onDelete && <button className="panel-action-btn panel-action-btn--danger" onClick={() => onDelete(song)}><Trash2 size={16} /> Delete</button>}
        </div>

        {editing ? (
          <div className="song-info-panel__edit-form">
            <div className="song-info-panel__edit-grid">
              <label>Artist<input value={form.artist} onChange={event => setField('artist', event.target.value)} /></label>
              <label>Title<input value={form.track} onChange={event => setField('track', event.target.value)} /></label>
              <label>Album<input value={form.album} onChange={event => setField('album', event.target.value)} /></label>
              <label>Genre<input value={form.genre} onChange={event => setField('genre', event.target.value)} /></label>
              <label>Release date<input value={form.releaseDate} onChange={event => setField('releaseDate', event.target.value)} placeholder="YYYY-MM-DD" /></label>
            </div>
            <label>Description<textarea rows="3" value={form.description} onChange={event => setField('description', event.target.value)} /></label>
            <label>Lyrics<textarea rows="7" value={form.lyrics} onChange={event => setField('lyrics', event.target.value)} /></label>
            <button className="btn-primary song-info-panel__save" onClick={save} disabled={saving || !form.artist?.trim() || !form.track?.trim()}>
              {saving ? 'Saving…' : 'Save details to Drive'}
            </button>
          </div>
        ) : (
          <div className="song-info-panel__sections">
            <section><h3>Description</h3><p>{song.description || 'No description is available yet.'}</p></section>
            <section><h3>Lyrics</h3><p>{song.lyrics || 'Lyrics are not available yet. They can be added by the metadata pipeline later.'}</p></section>
          </div>
        )}

        <dl className="song-info-panel__metadata">
          <div><dt>Artist</dt><dd>{song.artist || 'Unknown artist'}</dd></div>
          <div><dt>Created / added</dt><dd>{song.dateCreated || (song.dateAdded ? new Date(song.dateAdded).toLocaleString() : 'Unknown')}</dd></div>
          <div><dt>Last played</dt><dd>{song.lastPlayedAt ? new Date(song.lastPlayedAt).toLocaleString() : 'Not played yet'}</dd></div>
          <div><dt>Play count</dt><dd>{song.playCount || 0}</dd></div>
        </dl>
      </section>
    </div>
  );
}

export function SongReviewPanel({ song, onClose, onApprove, onRetryStudio, onUseYoutubeLink, busy = false }) {
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const sourceUrl = song.sourceUrl || song.selectedSourceUrl || '';
  const job = song.downloadJob;
  const dialogRef = useDialogFocus(true, onClose, { canClose: !busy });

  return (
    <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="song-review-panel" role="dialog" aria-modal="true" aria-labelledby="song-review-title" tabIndex={-1}>
        <div className="panel-header">
          <div>
            <h2 id="song-review-title">Song specification</h2>
            <p className="song-review-panel__subtitle">Review the source and replace a noisy or incorrect recording.</p>
          </div>
          <button data-dialog-autofocus className="icon-btn" onClick={onClose} aria-label="Close song specification"><X size={20} /></button>
        </div>

        <div className="song-review-panel__song">
          <strong>{song.track}</strong>
          <span>{song.artist}{song.album ? ` · ${song.album}` : ''}</span>
        </div>

        <dl className="song-review-panel__details">
          <div><dt>Quality review</dt><dd>{song.qualityStatus || 'Not reviewed'}</dd></div>
          <div><dt>Worker status</dt><dd>{job?.status || (song.driveFileId ? 'done' : 'not queued')}</dd></div>
          <div><dt>Drive file</dt><dd>{song.filename || song.driveFileId || 'Not uploaded'}</dd></div>
          {song.sourceTitle && <div><dt>Selected title</dt><dd>{song.sourceTitle}</dd></div>}
          {song.sourceUploader && <div><dt>Uploader</dt><dd>{song.sourceUploader}</dd></div>}
          {song.sourceSelectionMode && <div><dt>Selection mode</dt><dd>{song.sourceSelectionMode}</dd></div>}
          {sourceUrl && (
            <div><dt>Source URL</dt><dd><a href={sourceUrl} target="_blank" rel="noreferrer">Open source</a></dd></div>
          )}
        </dl>

        {job?.lastError && <p className="song-review-panel__error">{job.lastError}</p>}

        <div className="song-review-panel__actions">
          <button className="panel-action-btn" onClick={() => onApprove(song)} disabled={busy}>
            <ThumbsUp size={16} />
            <span>This is the correct studio song</span>
          </button>
          <button className="panel-action-btn" onClick={() => onRetryStudio(song)} disabled={busy}>
            <RefreshCw size={16} />
            <span>{busy ? 'Queueing...' : 'Video/noisy — try another studio result'}</span>
          </button>
        </div>

        <div className="song-review-panel__link-form">
          <label htmlFor="replacement-youtube-url">Use a specific YouTube link</label>
          <div className="song-review-panel__link-row">
            <Link2 size={16} />
            <input
              id="replacement-youtube-url"
              type="url"
              placeholder="https://www.youtube.com/watch?v=..."
              value={youtubeUrl}
              onChange={event => setYoutubeUrl(event.target.value)}
              disabled={busy}
            />
            <button className="btn-primary" onClick={() => onUseYoutubeLink(song, youtubeUrl)} disabled={busy || !youtubeUrl.trim()}>
              Replace
            </button>
          </div>
          <small>The worker will extract audio from this link, upload the replacement, then remove the old Drive file.</small>
        </div>
      </section>
    </div>
  );
}

export function LoginScreen({ onLogin, error, busy = false, setupStatus = {} }) {
  const missing = setupStatus.missing || [];
  return (
    <div className="login-screen">
      <div className="login-glow" />
      <div className="login-card">
        <div className="login-logo">
          <span className="login-logo__icon">♪</span>
        </div>
        <h1 className="login-title">Sisic Music</h1>
        <p className="login-sub">Your music. Everywhere. Offline.</p>
        <button className="btn-primary login-btn" onClick={onLogin} disabled={busy}>
          {busy ? 'Connecting…' : 'Sign in with Google'}
        </button>
        {error && <p className="login-error" role="alert">{error}</p>}
        <div className={`setup-card ${missing.length ? 'setup-card--needs-config' : 'setup-card--ready'}`}>
          <div className="setup-card__heading">
            <div>
              <span className="setup-card__eyebrow">First-time setup</span>
              <h2>{missing.length ? 'Connect your own Drive library' : 'Your site is configured'}</h2>
            </div>
            <span className="setup-card__status">
              {missing.length ? 'Needs setup' : 'Ready'}
            </span>
          </div>
          <p className="setup-card__copy">
            GitHub Pages hosts the interface only. Your music stays private in your Google Drive and is accessed after you authorize this site.
          </p>
          <ol className="setup-card__steps">
            <li>Create a Google Cloud OAuth web client and enable the Google Drive API.</li>
            <li>Add this GitHub Pages address as an authorized JavaScript origin.</li>
            <li>Build the site with the client ID, Drive folder ID, and library JSON file ID.</li>
          </ol>
          <div className="setup-card__links">
            <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">
              Google Cloud credentials <ExternalLink size={13} />
            </a>
            <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noreferrer">
              Enable Drive API <ExternalLink size={13} />
            </a>
          </div>
          <p className="setup-card__permissions"><strong>Drive permission:</strong> the current browser flow requests read-only access so it can find the existing Spotify export, plus app-managed file access for Sisic indexes and downloads. OAuth tokens stay in memory and are not stored in localStorage.</p>
          <p className="setup-card__automation"><strong>Automated:</strong> Google sign-in, Drive authorization, library sync, and offline downloads. <strong>One-time manual step:</strong> Google Cloud OAuth and the three build variables.</p>
          {missing.length > 0 && <p className="setup-card__missing">Missing from this build: {missing.join(', ')}</p>}
        </div>
        <p className="login-hint">Connect to your Google Drive music library</p>
      </div>
    </div>
  );
}

export function SyncBanner({ isSyncing, syncStatus, error, onSync, actionLabel, onAction, actionDisabled = false }) {
  if (!syncStatus && !isSyncing) return null;
  return (
    <div
      className={`sync-banner ${isSyncing ? 'sync-banner--loading' : ''} ${error ? 'sync-banner--error' : ''}`}
      role={error ? 'alert' : 'status'}
    >
      {isSyncing && <div className="spinner" />}
      <span>{syncStatus}</span>
      {!isSyncing && actionLabel && onAction && (
        <button className="sync-refresh-btn" onClick={onAction} disabled={actionDisabled}>{actionDisabled ? 'Connecting…' : actionLabel}</button>
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
  const visibleJobs = jobs.filter(job => !['complete', 'duplicate'].includes(job.status)).slice(0, 5);
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
            <div className="import-progress" role="progressbar" aria-label={`${Math.round((job.progress || 0) * 100)} percent complete`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round((job.progress || 0) * 100)}>
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
            <div className="import-progress" role="progressbar" aria-label="Embedding status" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round((job.progress || 0) * 100)}>
              <span style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function downloadStatusText(song) {
  const job = song.downloadJob;
  if (job?.status === 'queued') return 'Queued for the Mac worker';
  if (job?.status === 'downloading') return 'Mac worker is downloading';
  if (job?.status === 'blocked') return 'Blocked; manual import required';
  if (job?.status === 'failed' || job?.status === 'error') return `Mac failed${job.lastError ? ` · ${job.lastError}` : ''}`;
  return 'Not queued for the Mac worker';
}

function workerTaskStatus(job = {}) {
  if (job.status === 'queued') return { label: 'Queued', tone: 'queued' };
  if (job.status === 'downloading') return { label: 'Downloading', tone: 'active' };
  if (job.status === 'blocked') return { label: 'Blocked', tone: 'attention' };
  if (job.status === 'failed') return { label: 'Failed', tone: 'attention' };
  if (job.status === 'error') return { label: 'Retry required', tone: 'attention' };
  if (job.status === 'done' && !job.uploadedFileId) return { label: 'Upload incomplete', tone: 'attention' };
  return { label: job.status || 'Pending', tone: 'queued' };
}

export function MacWorkerTasksPanel({ tasks = [], onRetry, onRefresh }) {
  const queuedCount = tasks.filter(task => task.workerJob?.status === 'queued').length;
  const activeCount = tasks.filter(task => task.workerJob?.status === 'downloading').length;
  const attentionCount = tasks.length - queuedCount - activeCount;

  return (
    <section className="mac-worker-tasks" aria-label="Mac worker tasks">
      <div className="mac-worker-tasks__header">
        <div>
          <Laptop size={20} />
          <div>
            <h2>Mac worker tasks</h2>
            <p>Every queue item that is not fully uploaded to Drive yet.</p>
          </div>
        </div>
        <button className="download-status-row__action" onClick={onRefresh} type="button">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <div className="mac-worker-tasks__metrics">
        <div><span>Remaining</span><strong>{tasks.length.toLocaleString()}</strong></div>
        <div><span>Queued</span><strong>{queuedCount.toLocaleString()}</strong></div>
        <div><span>Active</span><strong>{activeCount.toLocaleString()}</strong></div>
        <div><span>Needs attention</span><strong>{attentionCount.toLocaleString()}</strong></div>
      </div>

      <div className="mac-worker-tasks__list">
        {tasks.length === 0 ? (
          <div className="download-status-empty">No remaining Mac worker tasks. The queue is caught up.</div>
        ) : tasks.map(task => {
          const job = task.workerJob || {};
          const status = workerTaskStatus(job);
          const retryable = ['failed', 'error', 'blocked'].includes(job.status) || (job.status === 'done' && !job.uploadedFileId);
          return (
            <div className="mac-worker-task" key={job.jobId || task.songKey}>
              <div className="mac-worker-task__status" data-tone={status.tone}>{status.label}</div>
              <div className="mac-worker-task__copy">
                <strong>{task.track || job.track || 'Untitled'}</strong>
                <span>{task.artist || job.artist || 'Unknown artist'}</span>
                <small>{job.sourceFileId ? `Imported source${job.sourceFileName ? ` · ${job.sourceFileName}` : ''}` : 'yt-dlp source'}{job.expectedFilename ? ` · ${job.expectedFilename}` : ''}</small>
                {job.lastError && <small className="mac-worker-task__error">{job.lastError}</small>}
              </div>
              {retryable && <button className="download-status-row__action" onClick={() => onRetry?.(task)} type="button">Retry</button>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function DownloadStatusPanel({
  readyCount = 0,
  queuedSongs = [],
  manualSongs = [],
  notQueuedSongs = [],
  onRetry,
  onQueue,
  onImport,
}) {
  const [tab, setTab] = useState('queued');
  const tabs = [
    { id: 'queued', label: 'Queued for download', songs: queuedSongs },
    { id: 'manual', label: 'Manual source needed', songs: manualSongs },
    { id: 'notQueued', label: 'Not queued', songs: notQueuedSongs },
  ];
  const activeTab = tabs.find(item => item.id === tab) || tabs[0];

  return (
    <section className="download-status-panel" aria-label="Download status">
      <div className="download-status-panel__header">
        <div>
          <Laptop size={20} />
          <div>
            <h2>Library availability</h2>
            <p>The Mac worker can try queued songs with yt-dlp. Failed or blocked songs need your own source file.</p>
          </div>
        </div>
        <button className="btn-primary download-status-panel__import" onClick={onImport}>
          <UploadCloud size={16} /> Import source file
        </button>
      </div>

      <div className="download-status-metrics">
        <div><span>Ready</span><strong>{readyCount.toLocaleString()}</strong></div>
        <div><span>Mac can try now</span><strong>{queuedSongs.length.toLocaleString()}</strong></div>
        <div><span>Manual source</span><strong>{manualSongs.length.toLocaleString()}</strong></div>
        <div><span>Not queued</span><strong>{notQueuedSongs.length.toLocaleString()}</strong></div>
      </div>

      <div className="download-status-tabs" role="tablist" aria-label="Download groups">
        {tabs.map(item => (
          <button
            key={item.id}
            className={`download-status-tab ${tab === item.id ? 'download-status-tab--active' : ''}`}
            onClick={() => setTab(item.id)}
            role="tab"
            aria-selected={tab === item.id}
            id={`download-tab-${item.id}`}
            aria-controls="download-tabpanel"
            tabIndex={tab === item.id ? 0 : -1}
            onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
              event.preventDefault();
              const direction = event.key === 'ArrowRight' ? 1 : -1;
              const index = tabs.findIndex(candidate => candidate.id === item.id);
              const nextId = tabs[(index + direction + tabs.length) % tabs.length].id;
              setTab(nextId);
              window.requestAnimationFrame(() => document.getElementById(`download-tab-${nextId}`)?.focus());
            }}
          >
            {item.label} <span>{item.songs.length}</span>
          </button>
        ))}
      </div>

      <div
        id="download-tabpanel"
        className="download-status-list"
        role="tabpanel"
        aria-labelledby={`download-tab-${activeTab.id}`}
        tabIndex={0}
      >
        <div className="download-status-list__heading">
          <strong>{activeTab.label}</strong>
          <span>{activeTab.id === 'manual' ? 'Import an audio file when the worker cannot complete it.' : activeTab.id === 'notQueued' ? 'Queue these when you want the Mac worker to try them.' : 'The Mac worker can attempt these automatically.'}</span>
        </div>
        {activeTab.songs.length === 0 ? (
          <div className="download-status-empty">No songs in this group.</div>
        ) : (
          activeTab.songs.map(song => (
            <div className="download-status-row" key={song.songKey}>
              <div className="download-status-row__copy">
                <strong>{song.track}</strong>
                <span>{song.artist}</span>
                <small>{downloadStatusText(song)}</small>
              </div>
              {activeTab.id === 'manual' && onRetry && (
                <button className="download-status-row__action" onClick={() => onRetry(song)}>Retry Mac</button>
              )}
              {activeTab.id === 'notQueued' && onQueue && (
                <button className="download-status-row__action" onClick={() => onQueue(song)}>Queue</button>
              )}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
