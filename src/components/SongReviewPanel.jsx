import { useState } from 'react';
import { CheckCircle2, Clock3, ExternalLink, Link2, RefreshCw, ShieldAlert, ThumbsDown, ThumbsUp, Trash2, X } from 'lucide-react';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import { formatDurationSeconds, getKnownDurationSeconds, MAX_DOWNLOAD_DURATION_SECONDS } from '../services/downloadPolicy.js';

function candidateUrl(candidate = {}) {
  const value = candidate.url || candidate.webpage_url || candidate.original_url || '';
  if (/^https?:\/\//i.test(String(value))) return String(value);
  const videoId = candidate.videoId || candidate.id || value;
  return videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` : '';
}

function candidateVideoId(candidate = {}) {
  const direct = String(candidate.videoId || candidate.id || '').trim();
  if (/^[A-Za-z0-9_-]{6,}$/.test(direct)) return direct;
  const source = candidateUrl(candidate);
  try {
    const parsed = new URL(source);
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    const value = parsed.searchParams.get('v') || pathParts[pathParts.length - 1] || '';
    return /^[A-Za-z0-9_-]{6,}$/.test(value) ? value : '';
  } catch {
    return '';
  }
}

function candidateKey(candidate = {}) {
  return String(candidate.candidateId || candidateVideoId(candidate) || candidateUrl(candidate) || candidate.title || 'candidate');
}

function candidatePreviewUrl(candidate) {
  const videoId = candidateVideoId(candidate);
  if (!videoId) return '';
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?autoplay=1&mute=1&controls=0&playsinline=1&rel=0&start=0&end=20`;
}

function candidateThumbnail(candidate) {
  if (candidate.thumbnail) return candidate.thumbnail;
  const videoId = candidateVideoId(candidate);
  return videoId ? `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg` : '';
}

function candidateDuration(value) {
  const seconds = getKnownDurationSeconds({ duration: value });
  return seconds ? formatDurationSeconds(seconds) : '';
}

function candidateReason(candidate) {
  if (candidate.durationLimitExceeded) {
    return `This source is ${candidateDuration(candidate.duration)} long and exceeds the ${formatDurationSeconds(MAX_DOWNLOAD_DURATION_SECONDS)} limit. Select it only if you approve downloading it.`;
  }
  if (candidate.selectionStatus === 'safety-filtered') {
    return 'The automatic safety filter flagged this result. Inspect it before selecting.';
  }
  return candidate.reason || 'Possible match from YouTube search.';
}

export function SongReviewPanel({
  song,
  onClose,
  onApprove,
  onRetryStudio,
  onUseYoutubeLink,
  onSelectCandidate,
  onRejectCandidate,
  onTrashRequest,
  busy = false,
}) {
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [activePreviewId, setActivePreviewId] = useState('');
  const [rejectedIds, setRejectedIds] = useState(() => new Set());
  const sourceUrl = song.sourceUrl || song.selectedSourceUrl || '';
  const job = song.downloadJob;
  const candidates = Array.isArray(job?.reviewCandidates)
    ? job.reviewCandidates
    : (Array.isArray(song.reviewCandidates) ? song.reviewCandidates : []);
  const visibleCandidates = candidates.filter(candidate => !rejectedIds.has(candidateKey(candidate)));
  const songDuration = getKnownDurationSeconds(song);
  const canTrashRequest = Boolean(onTrashRequest && job?.jobId && !['done', 'downloading', 'cancelled'].includes(job.status));
  const dialogRef = useDialogFocus(true, onClose, { canClose: !busy });

  const rejectCandidate = async candidate => {
    try {
      await onRejectCandidate?.(song, candidate);
      setRejectedIds(previous => new Set([...previous, candidateKey(candidate)]));
    } catch {
      // The parent reports the error; keep the candidate visible if persistence failed.
    }
  };

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
          {songDuration && <div><dt>Duration</dt><dd>{formatDurationSeconds(songDuration)}{songDuration > MAX_DOWNLOAD_DURATION_SECONDS ? ' · over limit' : ''}</dd></div>}
          {sourceUrl && (
            <div><dt>Source URL</dt><dd><a href={sourceUrl} target="_blank" rel="noreferrer">Open source</a></dd></div>
          )}
        </dl>

        {job?.lastError && <p className="song-review-panel__error">{job.lastError}</p>}

        {candidates.length > 0 && (
          <section className="song-review-candidates" aria-labelledby="song-review-candidates-title">
            <div className="song-review-candidates__header">
              <div>
                <h3 id="song-review-candidates-title">Worker could not decide</h3>
                <p>Choose the result that is actually the song. Hover a result to preview its first 20 seconds. Your choices improve future ranking.</p>
              </div>
              <span>{visibleCandidates.length} to review</span>
            </div>

            {visibleCandidates.length === 0 ? (
              <div className="song-review-candidates__empty">You rejected every result shown. Search again or paste a YouTube link below.</div>
            ) : (
              <div className="song-review-candidates__list">
                {visibleCandidates.map(candidate => {
                  const key = candidateKey(candidate);
                  const previewUrl = candidatePreviewUrl(candidate);
                  const thumbnail = candidateThumbnail(candidate);
                  const isDurationFiltered = Boolean(candidate.durationLimitExceeded);
                  const isFiltered = candidate.selectionStatus === 'safety-filtered';
                  const score = Number(candidate.score);
                  return (
                    <article className="song-review-candidate" key={key}>
                      <div
                        className="song-review-candidate__media"
                        tabIndex={previewUrl ? 0 : -1}
                        onMouseEnter={() => previewUrl && setActivePreviewId(key)}
                        onMouseLeave={() => setActivePreviewId('')}
                        onFocus={event => { if (event.target === event.currentTarget && previewUrl) setActivePreviewId(key); }}
                        onBlur={() => setActivePreviewId('')}
                        aria-label={previewUrl ? `Preview ${candidate.title}` : undefined}
                      >
                        {activePreviewId === key && previewUrl ? (
                          <iframe
                            src={previewUrl}
                            title={`Preview of ${candidate.title}`}
                            allow="autoplay; encrypted-media; picture-in-picture"
                          />
                        ) : thumbnail ? (
                          <img src={thumbnail} alt={`Thumbnail for ${candidate.title}`} loading="lazy" />
                        ) : (
                          <div className="song-review-candidate__no-art">YouTube</div>
                        )}
                        <span className={`song-review-candidate__badge ${isFiltered || isDurationFiltered ? 'song-review-candidate__badge--filtered' : ''}`}>
                          {isDurationFiltered ? <Clock3 size={13} /> : isFiltered ? <ShieldAlert size={13} /> : <CheckCircle2 size={13} />}
                          {isDurationFiltered ? 'Over 8-minute limit' : isFiltered ? 'Safety filtered' : 'Possible match'}
                        </span>
                      </div>
                      <div className="song-review-candidate__body">
                        <a
                          className="song-review-candidate__title"
                          href={candidateUrl(candidate)}
                          target="_blank"
                          rel="noreferrer"
                          onMouseEnter={() => previewUrl && setActivePreviewId(key)}
                          onMouseLeave={() => setActivePreviewId('')}
                        >
                          {candidate.title || 'Untitled YouTube result'}
                          <ExternalLink size={13} />
                        </a>
                        <div className="song-review-candidate__meta">
                          {candidate.uploader || candidate.channel || 'Unknown channel'}
                          {candidateDuration(candidate.duration) ? ` · ${candidateDuration(candidate.duration)}` : ''}
                          {Number.isFinite(score) && score > 0 ? ` · ${Math.round(score * 100)}% match` : ''}
                        </div>
                        <small>{candidateReason(candidate)}</small>
                        <div className="song-review-candidate__actions">
                          <button className="btn-primary" onClick={() => onSelectCandidate?.(song, candidate)} disabled={busy || !candidateUrl(candidate)}>
                            <CheckCircle2 size={15} /> Use this source
                          </button>
                          <button className="panel-action-btn" onClick={() => rejectCandidate(candidate)} disabled={busy}>
                            <ThumbsDown size={15} /> Not this
                          </button>
                          <a className="song-review-candidate__open" href={candidateUrl(candidate)} target="_blank" rel="noreferrer">Open on YouTube</a>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        )}

        <div className="song-review-panel__actions">
          <button className="panel-action-btn" onClick={() => onApprove(song)} disabled={busy}>
            <ThumbsUp size={16} />
            <span>This is the correct studio song</span>
          </button>
          <button className="panel-action-btn" onClick={() => onRetryStudio(song)} disabled={busy}>
            <RefreshCw size={16} />
            <span>{busy ? 'Queueing...' : 'Search again for another source'}</span>
          </button>
          {canTrashRequest && (
            <button className="panel-action-btn" onClick={() => onTrashRequest(song)} disabled={busy}>
              <Trash2 size={16} />
              <span>Trash download request</span>
            </button>
          )}
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
