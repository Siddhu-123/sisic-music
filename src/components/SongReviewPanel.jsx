import { useState } from 'react';
import { ThumbsUp, RefreshCw, Link2, X } from 'lucide-react';
import { useDialogFocus } from '../hooks/useDialogFocus.js';

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
