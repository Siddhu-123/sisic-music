import { memo, useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen, LoaderCircle } from 'lucide-react';
import { statusDetails } from './componentUtils.jsx';
import { AsyncArtworkImage } from './AsyncArtworkImage.jsx';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import '../song-tiles.css';
import nextGlyph from '../assets/song-tile/next-arrow.svg';
import playGlyph from '../assets/song-tile/play-arrow.svg';
import likeGlyph from '../assets/song-tile/like-glyph.svg';
import infoGlyph from '../assets/song-tile/info-glyph.svg';
import duplicateGlyph from '../assets/song-tile/duplicate-glyph.svg';
import reviewIcon from '../assets/song-tile/review.svg';
import playlistIcon from '../assets/song-tile/playlist.png';
import plusIcon from '../assets/song-tile/plus.png';
import similarIcon from '../assets/song-tile/sparkles.png';
import downloadIcon from '../assets/song-tile/download.png';
import deleteIcon from '../assets/song-tile/delete.png';

const ROW_SLOTS = ['next', 'play', 'queue', 'playlist', 'like', 'similar'];

export function TileFace({ song, statusText, statusTitle, title = song.track, subtitle = song.artist, cover, children }) {
  return (
    <div className="tile-face">
      <div className="tile-face__backdrop" aria-hidden="true">
        {[0, 1, 2, 3].map(level => (
          <div key={level} className={`tile-face__layer tile-face__layer--${level}`}>
            <AsyncArtworkImage defaultCover song={song} className="tile-face__bg" size={300} alt="" />
            <span className="tile-face__vignette" />
          </div>
        ))}
      </div>
      <div className="tile-face__cover">{cover ?? <AsyncArtworkImage defaultCover song={song} className="tile-face__cover-img" size={300} alt={`${song.track} cover`} />}</div>
      {children}
      <div className="tile-face__meta">
        <span className="tile-face__meta-bg" aria-hidden="true" />
        <p className="tile-face__title">{title}</p>
        <p className="tile-face__artist">{subtitle}</p>
      </div>
      <p className="tile-face__status" title={statusTitle}>{statusText}</p>
    </div>
  );
}

export const SongCard = memo(function SongCard({
  song,
  onPlay,
  onPrepare,
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
  isPlaying = false,
  isDownloading,
}) {
  const status = statusDetails(song);
  const statusText = [
    status.label,
    song.syncStatus && song.syncStatus !== 'done' ? `Sync ${song.syncStatus}` : '',
    song.embeddingStatus && song.embeddingStatus !== 'done' ? `Embedding ${song.embeddingStatus}` : '',
  ].filter(Boolean).join(' · ');
  const statusTitle = song.downloadJob?.lastError || statusText;
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuMounted, setMenuMounted] = useState(false);
  const [menuPhase, setMenuPhase] = useState('opening');
  const [menuPosition, setMenuPosition] = useState(null);
  const [dragOffset, setDragOffset] = useState(0);
  const menuId = useId();
  const cardRef = useRef(null);
  const triggerRef = useRef(null);
  const departingMenuRef = useRef(null);
  const menuDialogRef = useRef(null);
  const longPressTimerRef = useRef(null);
  const longPressTriggeredRef = useRef(false);
  const menuCloseTimerRef = useRef(null);
  const menuSettleTimerRef = useRef(null);
  const positionFrameRef = useRef(null);
  const openingFramesRef = useRef([]);
  const menuOpenRef = useRef(false);
  const wasMenuMountedRef = useRef(false);
  const prefersReducedMotionRef = useRef(false);
  const pointerRef = useRef({ active: false, startX: 0, offset: 0, swiped: false });

  const cancelOpeningFrames = useCallback(() => {
    openingFramesRef.current.forEach(frame => window.cancelAnimationFrame(frame));
    openingFramesRef.current = [];
  }, []);

  const closeMenu = useCallback(() => {
    if (!menuOpenRef.current) return;
    departingMenuRef.current = menuDialogRef.current?.current;
    menuOpenRef.current = false;
    setMenuOpen(false);
    cancelOpeningFrames();
    window.clearTimeout(menuSettleTimerRef.current);
    setMenuPhase('closing');
    window.clearTimeout(menuCloseTimerRef.current);
    // Figma: Variant3 -> Default is a 0.3s ease-out dissolve.
    menuCloseTimerRef.current = window.setTimeout(() => setMenuMounted(false), prefersReducedMotionRef.current ? 0 : 300);
  }, [cancelOpeningFrames]);
  const menuRef = useDialogFocus(menuOpen, closeMenu, { canClose: menuOpen });

  useEffect(() => {
    menuDialogRef.current = menuRef;
  }, [menuRef]);

  const clearLongPress = () => {
    if (longPressTimerRef.current) window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  };
  const runAction = (event, action) => {
    event.stopPropagation();
    if (!menuOpenRef.current) return;
    closeMenu();
    action?.(song);
  };

  const updateMenuPosition = useCallback(() => {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const viewportScale = Math.min((window.innerWidth - 16) / 352, (window.innerHeight - 16) / 388, 1);
    const cardScale = Math.min(rect.width / 300, rect.height / 336, 1);
    const scale = window.innerWidth <= 600 ? viewportScale : Math.min(cardScale, viewportScale);
    const stageWidth = 352 * scale;
    const stageHeight = 388 * scale;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - stageWidth - 8));
    const top = Math.max(8, Math.min(rect.top - 52 * scale, window.innerHeight - stageHeight - 8));
    setMenuPosition({ left, top, scale });
  }, []);

  const openMenu = useCallback(() => {
    window.clearTimeout(menuCloseTimerRef.current);
    window.clearTimeout(menuSettleTimerRef.current);
    cancelOpeningFrames();
    menuOpenRef.current = true;
    updateMenuPosition();
    setMenuMounted(true);
    setMenuOpen(true);
    setMenuPhase('opening');
    const firstFrame = window.requestAnimationFrame(() => {
      openingFramesRef.current = openingFramesRef.current.filter(frame => frame !== firstFrame);
      const secondFrame = window.requestAnimationFrame(() => {
        openingFramesRef.current = openingFramesRef.current.filter(frame => frame !== secondFrame);
        if (!menuOpenRef.current) return;
        setMenuPhase('open');
        // Figma: Variant2 -> Variant3 (buttons above the card) right after the 1.022s spring lands.
        menuSettleTimerRef.current = window.setTimeout(() => {
          if (menuOpenRef.current) setMenuPhase('settled');
        }, prefersReducedMotionRef.current ? 0 : 1022);
      });
      openingFramesRef.current.push(secondFrame);
    });
    openingFramesRef.current.push(firstFrame);
  }, [cancelOpeningFrames, updateMenuPosition]);

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
    if (event.target.closest('.song-card__actions')) return;
    longPressTriggeredRef.current = false;
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTriggeredRef.current = true;
      pointerRef.current.active = false;
      setDragOffset(0);
      openMenu();
    }, 480);
    pointerRef.current = { active: isReadyLoose, startX: event.clientX, startY: event.clientY, offset: 0, swiped: false };
  };

  const handlePointerMove = (event) => {
    if (Math.hypot(event.clientX - pointerRef.current.startX, event.clientY - pointerRef.current.startY) > 8) clearLongPress();
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
      return;
    }
    if (!pointerRef.current.active) return;
    const offset = pointerRef.current.offset || dragOffset;
    pointerRef.current.active = false;
    setDragOffset(0);
    if (offset <= -72) onDeleteReady?.(song);
    if (offset >= 72) onAddToPlaylist?.(song);
  };

  useEffect(() => {
    return () => clearLongPress();
  }, []);

  useEffect(() => () => {
    window.clearTimeout(menuCloseTimerRef.current);
    window.clearTimeout(menuSettleTimerRef.current);
    window.cancelAnimationFrame(positionFrameRef.current);
    cancelOpeningFrames();
  }, [cancelOpeningFrames]);

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const update = () => { prefersReducedMotionRef.current = Boolean(media?.matches); };
    update();
    media?.addEventListener?.('change', update);
    return () => media?.removeEventListener?.('change', update);
  }, []);

  useEffect(() => {
    if (menuMounted) {
      wasMenuMountedRef.current = true;
      return undefined;
    }
    if (!wasMenuMountedRef.current) return undefined;
    wasMenuMountedRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      const activeElement = document.activeElement;
      const trigger = triggerRef.current;
      if (activeElement === document.body || !activeElement?.isConnected || activeElement === trigger || departingMenuRef.current?.contains(activeElement)) {
        trigger?.focus();
      }
      departingMenuRef.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [menuMounted]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const handlePointerDownOutside = event => {
      if (!cardRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) closeMenu();
    };
    document.addEventListener('pointerdown', handlePointerDownOutside);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDownOutside);
    };
  }, [menuOpen, menuRef, closeMenu]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const reposition = () => {
      window.cancelAnimationFrame(positionFrameRef.current);
      positionFrameRef.current = window.requestAnimationFrame(updateMenuPosition);
    };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      window.cancelAnimationFrame(positionFrameRef.current);
    };
  }, [menuOpen, updateMenuPosition]);

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
    { label: 'Play', glyph: playGlyph, action: onPlay, slot: 'play' },
    onPlayNext && { label: 'Next', glyph: nextGlyph, action: onPlayNext, slot: 'next' },
    onAddToQueue && { label: 'Queue', glyph: playlistIcon, action: onAddToQueue, slot: 'queue' },
    onAddToPlaylist && { label: 'Playlist', glyph: plusIcon, action: onAddToPlaylist, slot: 'playlist' },
    onToggleLike && { label: isLiked ? 'Unlike' : 'Like', glyph: likeGlyph, action: onToggleLike, slot: 'like' },
    onMoreLikeThis && { label: 'Similar', glyph: similarIcon, action: onMoreLikeThis, slot: 'similar' },
    onInfo && { label: 'Info', glyph: infoGlyph, action: onInfo, slot: 'info' },
    onPrepare && { label: song.driveFileId ? 'Ready to stream' : 'Prepare on Drive', glyph: downloadIcon, action: onPrepare, disabled: isDownloading, busy: isDownloading, slot: 'download' },
    onMarkDuplicate && !onRestoreDuplicate && { label: 'Duplicate', glyph: duplicateGlyph, action: onMarkDuplicate, slot: 'duplicate' },
    onRestoreDuplicate && { label: 'Restore', Icon: FolderOpen, action: onRestoreDuplicate, slot: 'restore' },
    onReview && { label: 'Review', glyph: reviewIcon, action: onReview, slot: 'review' },
    { label: 'Delete', glyph: deleteIcon, action: onDeleteReady, disabled: !song.driveFileId || song.isDeleted, danger: true, slot: 'delete' },
  ].filter(Boolean);

  const renderAction = item => {
    const Icon = item.Icon;
    return <button key={item.slot} type="button" role="menuitem" className={`song-prototype-action song-prototype-action--${item.slot}${item.danger ? ' is-danger' : ''}`} onClick={event => runAction(event, item.action)} disabled={!menuOpen || item.disabled} aria-label={item.label} title={item.label}>
      <span className="song-prototype-action__icon">
        {item.glyph && <span className="song-prototype-action__glyph" style={{ '--glyph': `url("${item.glyph}")` }} aria-hidden="true" />}
        {Icon && <Icon className="song-prototype-action__restore" size={22} strokeWidth={2.5} aria-hidden="true" />}
      </span>
      <span className="song-prototype-action__label">{item.label}</span>
      {item.busy && <LoaderCircle className="song-prototype-spinner" size={18} aria-label="Downloading" />}
    </button>;
  };

  return (
    <>
      <article
        ref={cardRef}
        className={`song-card song-card--group25 ${isCurrentSong ? 'song-card--active' : ''} ${isReadyLoose ? 'song-card--swipeable' : ''} ${menuOpen ? 'song-card--actions-open' : ''} ${menuMounted && menuPhase !== 'closing' ? 'song-card--prototype-hidden' : ''}`}
        style={isReadyLoose && dragOffset ? { transform: `translateX(${dragOffset}px)` } : undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => { clearLongPress(); pointerRef.current.active = false; pointerRef.current.swiped = true; setDragOffset(0); }}
        onContextMenu={handleCardContextMenu}
      >
      <button
        className="song-card__primary"
        ref={triggerRef}
        onClick={() => {
          if (pointerRef.current.swiped || longPressTriggeredRef.current) return;
          onPlay(song);
        }}
        onKeyDown={handleCardKeyDown}
        aria-label={`${isCurrentSong ? 'Resume' : 'Play'} ${song.track} by ${song.artist}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
      >
        <TileFace song={song} statusText={statusText} statusTitle={statusTitle}>
          {isCurrentSong && (
            <div className={`song-card__playing-bars ${isPlaying ? '' : 'song-card__playing-bars--paused'}`}><span /><span /><span /></div>
          )}
        </TileFace>
      </button>
      </article>
      {menuMounted && createPortal(
        <div className={`song-prototype-portal is-${menuPhase}`} role="presentation" style={menuPosition ? { '--menu-left': `${menuPosition.left}px`, '--menu-top': `${menuPosition.top}px`, '--menu-scale': menuPosition.scale } : undefined}>
          <div
            ref={menuRef}
            id={menuId}
            className="song-prototype-stage"
            role="menu"
            aria-label={`Actions for ${song.track}`}
            tabIndex={-1}
            onClick={event => event.stopPropagation()}
            onKeyDown={handleMenuKeyDown}
            onContextMenu={event => event.preventDefault()}
          >
            <div className="song-prototype-art" onClick={closeMenu}>
              <TileFace song={song} statusText={statusText} statusTitle={statusTitle} />
            </div>
            <div className="song-prototype-actions" inert={!menuOpen}>
              <div className="song-prototype-actions__row">{actionItems.filter(item => ROW_SLOTS.includes(item.slot)).map(renderAction)}</div>
              <div className="song-prototype-actions__column">{actionItems.filter(item => !ROW_SLOTS.includes(item.slot)).map(renderAction)}</div>
            </div>
          </div>
          <button className="song-prototype-scrim" aria-label="Close actions" onClick={closeMenu} tabIndex={-1} />
        </div>,
        document.body,
      )}
    </>
  );
});
