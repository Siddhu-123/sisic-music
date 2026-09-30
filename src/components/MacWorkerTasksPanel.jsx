import { Laptop, RefreshCw } from 'lucide-react';
import { workerTaskStatus } from './componentUtils.jsx';

export function MacWorkerTasksPanel({ tasks = [], canonicalRecordCount = 0, onRetry, onReview, onRefresh }) {
  const queuedCount = tasks.filter(task => task.workerJob?.status === 'queued').length;
  const activeCount = tasks.filter(task => task.workerJob?.status === 'downloading').length;
  const reviewCount = tasks.filter(task => task.workerJob?.status === 'needs-review').length;
  const attentionCount = tasks.length - queuedCount - activeCount - reviewCount;

  return (
    <section className="mac-worker-tasks" aria-label="Mac worker tasks">
      <div className="mac-worker-tasks__header">
        <div>
          <Laptop size={20} />
          <div>
            <h2>Mac worker tasks</h2>
            <p>Canonical Drive queue · {canonicalRecordCount.toLocaleString()} record{canonicalRecordCount === 1 ? '' : 's'}</p>
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
        <div><span>Needs review</span><strong>{reviewCount.toLocaleString()}</strong></div>
        <div><span>Other attention</span><strong>{attentionCount.toLocaleString()}</strong></div>
      </div>

      <div className="mac-worker-tasks__list">
        {tasks.length === 0 ? (
          <div className="download-status-empty">No remaining Mac worker tasks. The queue is caught up.</div>
        ) : tasks.map(task => {
          const job = task.workerJob || {};
          const status = workerTaskStatus(job);
          const needsReview = job.status === 'needs-review';
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
              {needsReview && <button className="download-status-row__action" onClick={() => onReview?.(task)} type="button">Review sources</button>}
              {retryable && <button className="download-status-row__action" onClick={() => onRetry?.(task)} type="button">Retry</button>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
