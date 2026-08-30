import { UploadCloud, BrainCircuit } from 'lucide-react';

const IMPORT_STATUS_LABELS = {
  waiting: 'Waiting',
  importing: 'Importing',
  'reading-metadata': 'Reading metadata',
  duplicate: 'Duplicate detected',
  complete: 'Complete',
  failed: 'Failed',
};

export function ImportStatusPanel({ jobs = [], embeddingJobs = [] }) {
  const visibleJobs = jobs.filter(job => !['complete', 'duplicate'].includes(job.status)).slice(0, 5);
  const visibleEmbeddings = embeddingJobs.filter(job => ['queued', 'processing', 'failed'].includes(job.status)).slice(0, 3);
  if (!visibleJobs.length && !visibleEmbeddings.length) return null;
  return (
    <section className="import-status-panel" aria-label="Import pipeline status">
      <div className="import-status-panel__header">
        <div>
          <UploadCloud size={18} />
          <strong>Import pipeline</strong>
        </div>
        <span>{jobs.filter(job => !['complete', 'duplicate'].includes(job.status)).length || 'Ready'}</span>
      </div>
      <div className="import-status-panel__list">
        {visibleJobs.map(job => (
          <div className="import-status-row" key={job.jobId}>
            <div className="import-status-row__copy">
              <span>{job.fileName || job.songKey || 'Audio file'}</span>
              <small>{IMPORT_STATUS_LABELS[job.status] || job.status}{job.message ? ` · ${job.message}` : ''}</small>
            </div>
            <div className="import-progress" role="progressbar" aria-label={`${Math.round((job.progress || 0) * 100)} percent complete`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round((job.progress || 0) * 100)}>
              <span style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} />
            </div>
          </div>
        ))}
        {visibleEmbeddings.map(job => (
          <div className="import-status-row import-status-row--embedding" key={job.jobId}>
            <div className="import-status-row__copy">
              <span><BrainCircuit size={14} /> Embedding {job.songKey}</span>
              <small>{job.status === 'processing' ? 'Generating embedding' : job.status === 'failed' ? 'Retry required' : 'Queued'}</small>
            </div>
            <div className="import-progress" role="progressbar" aria-label="Embedding status" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round((job.progress || 0) * 100)}>
              <span style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
