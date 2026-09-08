import React, { useLayoutEffect, useRef, useState } from 'react';
import { queueItemKey } from '../queueManager.js';
import { X, Shuffle, Repeat, Clock3, AlertTriangle, Cloud, Trash2, ChevronUp, ChevronDown, GripVertical, Search } from 'lucide-react';
import { useDialogFocus } from '../hooks/useDialogFocus';

const SHUFFLE_LABELS = { off: 'Off', shuffle: 'Shuffle', smart: 'Smart' };
const REPEAT_LABELS = { off: 'Repeat off', one: 'Repeat one', all: 'Repeat all' };

function queueStatus(song, jobBySongKey) {
  const job = jobBySongKey?.get(song.songKey) || song.downloadJob;
  if (song.driveFileId) return { label: 'Ready', icon: Cloud, className: 'queue-pill--ready' };
  if (job?.status === 'error' || job?.status === 'failed') return { label: 'Failed', icon: AlertTriangle, className: 'queue-pill--error' };
  if (job?.status === 'downloading') return { label: 'Downloading', icon: Clock3, className: 'queue-pill--working' };
  if (job?.status === 'queued') return { label: 'Queued', icon: Clock3, className: 'queue-pill--queued' };
  return null;
}

export function QueuePanel({ player, jobBySongKey, onClose, onRetry }) {
  const panelRef = useDialogFocus(true, onClose);
  const {
    queue,
    queueIndex,
    shuffleMode,
    toggleShuffle,
    repeatMode,
    toggleRepeat,
    removeFromQueue,
    reorderQueue,
    clearQueue,
    playQueueItem,
  } = player;
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(50);
  const [dragTarget, setDragTarget] = useState(null);
  const drag = useRef(null);
  const listRef = useRef(null);
  const positions = useRef(new Map());
  const filtered = queue.map((song, position) => ({ song, position })).slice(queueIndex + 1)
    .filter(({ song }) => `${song.track} ${song.artist} ${song.album || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const upcoming = filtered.slice(0, limit);
  useLayoutEffect(() => {
    const rows = [...(listRef.current?.querySelectorAll('[data-song-key]') || [])];
    const next = new Map();
    const sameRows = positions.current.size === rows.length && rows.every(row => positions.current.has(row.dataset.songKey));
    rows.forEach(row => {
      const top = row.offsetTop;
      const oldTop = positions.current.get(row.dataset.songKey);
      next.set(row.dataset.songKey, top);
      if (sameRows && oldTop != null && top !== oldTop && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        row.getAnimations().forEach(animation => animation.cancel());
        row.animate([{ transform: `translateY(${oldTop - top}px)` }, { transform: 'translateY(0)' }], { duration: 180, easing: 'ease-out' });
      }
    });
    positions.current = next;
  }, [queue, query, queueIndex]);
  const cancelDrag = () => { drag.current = null; setDragTarget(null); };
  const moveDrag = event => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    const list = listRef.current;
    const rect = list.getBoundingClientRect();
    if (event.clientY < rect.top + 40) list.scrollTop -= 16;
    if (event.clientY > rect.bottom - 40) list.scrollTop += 16;
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-song-key]');
    if (row && list.contains(row)) { drag.current.target = row.dataset.songKey; setDragTarget(row.dataset.songKey); }
  };
  const finishDrag = () => {
    if (drag.current?.target) {
      const from = queue.findIndex(song => String(queueItemKey(song)) === drag.current.key);
      const to = queue.findIndex(song => String(queueItemKey(song)) === drag.current.target);
      if (from > queueIndex && to > queueIndex) reorderQueue(from, to);
    }
    cancelDrag();
  };

  const renderStatus = (song) => {
    const status = queueStatus(song, jobBySongKey);
    if (!status) return null;
    const Icon = status.icon;
    return (
      <span className={`queue-pill ${status.className}`}>
        <Icon size={11} /> {status.label}
        {(status.className === 'queue-pill--error' || status.className === 'queue-pill--queued') && onRetry && (
          <button className="queue-pill__retry" onClick={() => onRetry(song)} aria-label={`Retry ${song.track}`}>
            Retry
          </button>
        )}
      </span>
    );
  };

  return (
    <aside
      ref={panelRef}
      className="queue-panel"
      role="dialog"
      aria-labelledby="queue-panel-title"
      tabIndex={-1}
    >
      <div className="queue-panel__header">
        <h2 id="queue-panel-title">Queue</h2>
        <div className="queue-panel__actions">
          <button
            className={`icon-btn queue-shuffle-btn ${shuffleMode !== 'off' ? 'queue-shuffle-btn--active' : ''}`}
            onClick={toggleShuffle}
            title={`Shuffle: ${SHUFFLE_LABELS[shuffleMode]}`}
          >
            <Shuffle size={16} />
            <span className="queue-shuffle-label">{SHUFFLE_LABELS[shuffleMode]}</span>
          </button>
          <button
            className={`icon-btn queue-shuffle-btn ${repeatMode !== 'off' ? 'queue-shuffle-btn--active' : ''}`}
            onClick={toggleRepeat}
            title={REPEAT_LABELS[repeatMode]}
            aria-label={REPEAT_LABELS[repeatMode]}
          >
            <Repeat size={16} />
            <span className="queue-shuffle-label">{repeatMode === 'one' ? 'One' : repeatMode === 'all' ? 'All' : 'Off'}</span>
          </button>
          <button className="icon-btn" onClick={clearQueue} aria-label="Clear queue" title="Clear queue">
            <Trash2 size={16} />
          </button>
          <button data-dialog-autofocus className="icon-btn" onClick={onClose} aria-label="Close queue">
            <X size={18} />
          </button>
        </div>
      </div>

      <label className="queue-search"><Search size={16} /><input aria-label="Filter queue" placeholder="Filter queue" value={query} onChange={e => { setQuery(e.target.value); setLimit(50); }} /></label>
      {player.currentSong && (
        <div className="queue-section">
          <div className="queue-section__label">Now Playing</div>
          <div
            className="queue-item queue-item--active queue-item--clickable"
            role="button"
            tabIndex={0}
            onClick={event => {
              if (event.target.closest('button')) return;
              playQueueItem(queueIndex);
            }}
            onKeyDown={event => {
              if (event.target !== event.currentTarget) return;
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                playQueueItem(queueIndex);
              }
            }}
            title="Pause or resume"
          >
            <div className={`queue-item__bars ${player.isPlaying ? '' : 'queue-item__bars--paused'}`}><span /><span /><span /></div>
            <div className="queue-item__info">
              <span className="queue-item__title">{player.currentSong.track}</span>
              <span className="queue-item__artist">{player.currentSong.artist}</span>
            </div>
            {renderStatus(player.currentSong)}
            <button className="icon-btn" onClick={() => removeFromQueue(queueIndex)} aria-label="Remove current track from queue"><X size={14} /></button>
          </div>
        </div>
      )}

      <div className="queue-section">
        <div className="queue-section__label">
          Next Up {upcoming.length > 0 && `(${queue.length - queueIndex - 1})`}
        </div>
        {upcoming.length === 0 ? (
          <div className="queue-empty">{query ? 'No matching tracks' : 'No upcoming tracks'}</div>
        ) : (
          <div className="queue-list" ref={listRef}>
            {upcoming.map(({ song, position: queuePosition }, index) => {
              return (
              <div
                key={queueItemKey(song)}
                data-song-key={queueItemKey(song)}
                className={`queue-item queue-item--clickable ${dragTarget === String(queueItemKey(song)) ? 'queue-item--drop-target' : ''}`}
                role="button"
                tabIndex={0}
                onClick={event => {
                  if (event.target.closest('button')) return;
                  playQueueItem(queuePosition);
                }}
                onKeyDown={event => {
                  if (event.target.closest('button')) return;
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    playQueueItem(queuePosition);
                  }
                }}
                title={`Play ${song.track}`}
              >
                <button className="icon-btn queue-drag-handle" aria-label={`Drag to reorder ${song.track}`} title="Drag to reorder"
                  onPointerDown={event => {
                    if (event.button !== 0) return;
                    event.preventDefault(); event.stopPropagation();
                    drag.current = { key: String(queueItemKey(song)), pointerId: event.pointerId };
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}
                ><GripVertical size={16} /></button>
                <span className="queue-item__num">{index + 1}</span>
                <div className="queue-item__info">
                  <span className="queue-item__title">{song.track}</span>
                  <span className="queue-item__artist">{song.artist}</span>
                </div>
                {renderStatus(song)}
                <div className="queue-item__actions">
                  <button className="icon-btn" disabled={queuePosition <= queueIndex + 1} onClick={() => reorderQueue(queuePosition, queuePosition - 1)} aria-label={`Move ${song.track} up`} title="Move up">
                    <ChevronUp size={14} />
                  </button>
                  <button className="icon-btn" onClick={() => reorderQueue(queuePosition, queuePosition + 1)} disabled={queuePosition >= queue.length - 1} aria-label={`Move ${song.track} down`} title="Move down">
                    <ChevronDown size={14} />
                  </button>
                  <button className="icon-btn" onClick={() => removeFromQueue(queuePosition)} aria-label={`Remove ${song.track} from queue`} title="Remove from queue">
                    <X size={14} />
                  </button>
                </div>
              </div>
              );
            })}
            {filtered.length > limit && <button className="btn-primary" onClick={() => setLimit(value => value + 50)}>Show more ({filtered.length - limit})</button>}
          </div>
        )}
      </div>
    </aside>
  );
}
