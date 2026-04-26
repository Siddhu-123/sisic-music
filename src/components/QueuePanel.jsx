import React from 'react';
import { X, Shuffle, Clock3, AlertTriangle, Cloud, HardDriveDownload } from 'lucide-react';

const SHUFFLE_LABELS = { off: 'Off', shuffle: 'Shuffle', smart: 'Smart' };

function queueStatus(song, jobBySongKey) {
  const job = jobBySongKey?.get(song.songKey) || song.downloadJob;
  if (song.isDownloaded || song.isCached || song.hasBlob) return { label: 'Cached', icon: HardDriveDownload, className: 'queue-pill--ready' };
  if (song.driveFileId) return { label: 'Ready', icon: Cloud, className: 'queue-pill--ready' };
  if (job?.status === 'error' || job?.status === 'failed') return { label: 'Failed', icon: AlertTriangle, className: 'queue-pill--error' };
  if (job?.status === 'downloading') return { label: 'Downloading', icon: Clock3, className: 'queue-pill--working' };
  if (job?.status === 'queued') return { label: 'Queued', icon: Clock3, className: 'queue-pill--queued' };
  return null;
}

export function QueuePanel({ player, jobBySongKey, onClose }) {
  const { queue, queueIndex, shuffleMode, toggleShuffle } = player;
  const upcoming = queue.slice(queueIndex + 1, queueIndex + 21);

  const renderStatus = (song) => {
    const status = queueStatus(song, jobBySongKey);
    if (!status) return null;
    const Icon = status.icon;
    return (
      <span className={`queue-pill ${status.className}`}>
        <Icon size={11} /> {status.label}
      </span>
    );
  };

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

      {player.currentSong && (
        <div className="queue-section">
          <div className="queue-section__label">Now Playing</div>
          <div className="queue-item queue-item--active">
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
            {upcoming.map((song, index) => (
              <div key={`${song.songKey}-${index}`} className="queue-item">
                <span className="queue-item__num">{index + 1}</span>
                <div className="queue-item__info">
                  <span className="queue-item__title">{song.track}</span>
                  <span className="queue-item__artist">{song.artist}</span>
                </div>
                {renderStatus(song)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
