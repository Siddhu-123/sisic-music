import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Play, SkipForward, Download, CheckCircle2, ListMusic, Clock3, Cloud, Plus, Trash2, Info, RefreshCw, X, Sparkles, Heart, Copy, FolderOpen, MoreHorizontal } from 'lucide-react';
import { statusDetails } from './componentUtils.jsx';
import { AsyncArtworkImage } from './AsyncArtworkImage.jsx';
import { useDialogFocus } from '../hooks/useDialogFocus.js';

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
  const longPressTimerRef = useRef(null);
  const longPressTriggeredRef = useRef(false);
  const pointerRef = useRef({ active: false, startX: 0, offset: 0, swiped: false });

  const closeMenu = () => setMenuOpen(false);
  const menuRef = useDialogFocus(menuOpen, closeMenu);
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
    if (event.target.closest('.song-card__dl-btn, .song-card__menu-btn, .song-card__actions')) return;
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
    const handlePointerDownOutside = event => {
      if (!cardRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) closeMenu();
    };
    document.addEventListener('pointerdown', handlePointerDownOutside);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDownOutside);
    };
  }, [menuOpen, menuRef]);

  const handleMenuKeyDown = event => {
    const items = [...(menuRef.current?.querySelectorAll('[role="menuitem"]:not(:disabled)') || [])];
    if (!items.length) return;
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

  return (
    <>
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
      <button
        type="button"
        className="song-card__menu-btn"
        onClick={event => { event.stopPropagation(); openMenu(); }}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
        aria-label={`More actions for ${song.track}`}
        title="More actions"
      >
        <MoreHorizontal size={18} />
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
      </article>
      {menuOpen && createPortal(
        <div className="song-action-sheet-overlay" role="presentation" onClick={closeMenu}>
          <div
            ref={menuRef}
            id={menuId}
            className="song-action-sheet"
            role="menu"
            aria-label={`Actions for ${song.track}`}
            onClick={event => event.stopPropagation()}
            onKeyDown={handleMenuKeyDown}
          >
            <div className="song-action-sheet__header">
              <div className="song-action-sheet__art">
                <AsyncArtworkImage song={song} size={96} fallbackSize={20} />
              </div>
              <div className="song-action-sheet__meta">
                <strong>{song.track}</strong>
                <span>{song.artist}</span>
                {song.album && <small>{song.album}</small>}
              </div>
              <button
                type="button"
                className="song-action-sheet__close"
                onClick={closeMenu}
                aria-label="Close actions menu"
              >
                <X size={18} />
              </button>
            </div>

            <div className="song-action-sheet__grid">
              {actionItems.map(item => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.label}
                    type="button"
                    role="menuitem"
                    className={`song-action-sheet__btn ${item.danger ? 'song-action-sheet__btn--danger' : ''}`}
                    onClick={event => runAction(event, item.action)}
                    disabled={item.disabled}
                  >
                    <Icon size={18} fill={item.fill || 'none'} />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
