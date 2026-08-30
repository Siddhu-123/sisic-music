import { useState } from 'react';
import { Download, UploadCloud, Laptop } from 'lucide-react';
import { downloadStatusText } from './componentUtils.jsx';

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
