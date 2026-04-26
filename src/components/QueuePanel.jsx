import React from 'react';
import { X, Shuffle, ListMusic } from 'lucide-react';

const SHUFFLE_LABELS = { off: 'Off', shuffle: 'Shuffle', smart: 'Smart' };

export function QueuePanel({ player, onClose }) {
  const { queue, queueIndex, shuffleMode, toggleShuffle } = player;
  const upcoming = queue.slice(queueIndex + 1, queueIndex + 21); // Next 20

  return (
    <div className="queue-panel">
      <div className="queue-panel__header">
        <h3>Queue</h3>
        <div className="queue-panel__actions">
          <button
            className={`icon-btn queue-shuffle-btn ${shuffleMode !== 'off' ? 'queue-shuffle-btn--active' : ''}`}
            onClick={toggleShuffle}
            title={`Shuffle: ${SHUFFLE_LABELS[shuffleMode]}`}
          >
            <Shuffle size={16} />
            <span className="queue-shuffle-label">{SHUFFLE_LABELS[shuffleMode]}</span>
          </button>
          <button className="icon-btn" onClick={onClose} aria-label="Close queue">
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Now Playing */}
      {player.currentSong && (
        <div className="queue-section">
          <div className="queue-section__label">Now Playing</div>
          <div className="queue-item queue-item--active">
            <div className="queue-item__bars"><span /><span /><span /></div>
            <div className="queue-item__info">
              <span className="queue-item__title">{player.currentSong.track}</span>
              <span className="queue-item__artist">{player.currentSong.artist}</span>
            </div>
          </div>
        </div>
      )}

      {/* Up Next */}
      <div className="queue-section">
        <div className="queue-section__label">
          Next Up {upcoming.length > 0 && `(${queue.length - queueIndex - 1})`}
        </div>
        {upcoming.length === 0 ? (
          <div className="queue-empty">No songs in queue</div>
        ) : (
          <div className="queue-list">
            {upcoming.map((song, i) => (
              <div key={`${song.id}-${i}`} className="queue-item">
                <span className="queue-item__num">{i + 1}</span>
                <div className="queue-item__info">
                  <span className="queue-item__title">{song.track}</span>
                  <span className="queue-item__artist">{song.artist}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
