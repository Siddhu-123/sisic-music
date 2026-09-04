import React from 'react';
import { X, Shuffle, Repeat, Clock3, AlertTriangle, Cloud, Trash2, ChevronUp, ChevronDown } from 'lucide-react';
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
  const upcoming = queue.slice(queueIndex + 1, queueIndex + 21);

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
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                playQueueItem(queueIndex);
              }
            }}
            title="Pause or resume"
          >
            <div className="queue-item__bars"><span /><span /><span /></div>
            <div className="queue-item__info">
              <span className="queue-item__title">{player.currentSong.track}</span>
              <span className="queue-item__artist">{player.currentSong.artist}</span>
            </div>
            {renderStatus(player.currentSong)}
          </div>
        </div>
      )}

      <div className="queue-section">
        <div className="queue-section__label">
          Next Up {upcoming.length > 0 && `(${queue.length - queueIndex - 1})`}
        </div>
        {upcoming.length === 0 ? (
          <div className="queue-empty">No songs in queue</div>
        ) : (
          <div className="queue-list">
            {upcoming.map((song, index) => {
              const queuePosition = queueIndex + 1 + index;
              return (
              <div
                key={`${song.songKey}-${index}`}
                className="queue-item queue-item--clickable"
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
                <span className="queue-item__num">{index + 1}</span>
                <div className="queue-item__info">
                  <span className="queue-item__title">{song.track}</span>
                  <span className="queue-item__artist">{song.artist}</span>
                </div>
                {renderStatus(song)}
                <div className="queue-item__actions">
                  <button className="icon-btn" onClick={() => reorderQueue(queuePosition, queuePosition - 1)} aria-label={`Move ${song.track} up`} title="Move up">
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
          </div>
        )}
      </div>
    </aside>
  );
}
