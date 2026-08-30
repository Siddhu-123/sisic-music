import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  Clock3,
  Download,
  HardDriveDownload,
  Trash2,
} from 'lucide-react';

export function formatTime(seconds) {
  if (!seconds || Number.isNaN(seconds)) return '0:00';
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${secs}`;
}

export function statusDetails(song) {
  const status = song.status || song.downloadJob?.status;
  if (song.isDownloaded) return { label: 'Offline', icon: CheckCircle2, className: 'song-status--ready' };
  if (song.isCached || song.hasBlob) return { label: 'Cached', icon: HardDriveDownload, className: 'song-status--ready' };
  if (song.driveFileId) return { label: 'Ready', icon: Cloud, className: 'song-status--ready' };
  if (status === 'queued') return { label: 'Queued', icon: Clock3, className: 'song-status--queued' };
  if (status === 'downloading') return { label: 'Downloading', icon: Clock3, className: 'song-status--downloading' };
  if (status === 'done') return { label: 'Ready', icon: Cloud, className: 'song-status--ready' };
  if (status === 'blocked' || status === 'deleted') return { label: 'Deleted', icon: Trash2, className: 'song-status--error' };
  if (status === 'error' || status === 'failed') return { label: 'Failed', icon: AlertTriangle, className: 'song-status--error' };
  return { label: 'Request', icon: Download, className: 'song-status--missing' };
}

export function downloadStatusText(song) {
  const job = song.downloadJob;
  if (job?.status === 'queued') return 'Queued for the Mac worker';
  if (job?.status === 'downloading') return 'Mac worker is downloading';
  if (job?.status === 'blocked') return 'Blocked; manual import required';
  if (job?.status === 'failed' || job?.status === 'error') return `Mac failed${job.lastError ? ` · ${job.lastError}` : ''}`;
  return 'Not queued for the Mac worker';
}

export function workerTaskStatus(job = {}) {
  if (job.status === 'queued') return { label: 'Queued', tone: 'queued' };
  if (job.status === 'downloading') return { label: 'Downloading', tone: 'active' };
  if (job.status === 'blocked') return { label: 'Blocked', tone: 'attention' };
  if (job.status === 'failed') return { label: 'Failed', tone: 'attention' };
  if (job.status === 'error') return { label: 'Retry required', tone: 'attention' };
  if (job.status === 'done' && !job.uploadedFileId) return { label: 'Upload incomplete', tone: 'attention' };
  return { label: job.status || 'Pending', tone: 'queued' };
}
