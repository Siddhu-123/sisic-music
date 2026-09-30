export const MAX_DOWNLOAD_DURATION_SECONDS = 8 * 60;

export function parseDurationSeconds(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.includes(':')) {
      const parts = trimmed.split(':').map(Number);
      if (parts.length >= 2 && parts.length <= 3 && parts.every(part => Number.isFinite(part) && part >= 0)) {
        const seconds = parts.reduce((total, part) => (total * 60) + part, 0);
        return seconds > 0 ? seconds : null;
      }
    }
  }

  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export function getKnownDurationSeconds(song = {}) {
  const candidates = [
    song.durationSeconds,
    song.durationMs == null ? null : Number(song.durationMs) / 1000,
    song.duration,
    song.sourceDuration,
    song.downloadJob?.durationSeconds,
    song.downloadJob?.durationMs == null ? null : Number(song.downloadJob.durationMs) / 1000,
    song.downloadJob?.sourceDuration,
  ];
  return candidates.map(parseDurationSeconds).find(Boolean) || null;
}

export function formatDurationSeconds(value) {
  const seconds = parseDurationSeconds(value);
  if (seconds == null) return 'unknown duration';
  const totalSeconds = Math.ceil(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${remainder}`;
}

export function exceedsDownloadDuration(song = {}) {
  const durationSeconds = getKnownDurationSeconds(song);
  return durationSeconds != null && durationSeconds > MAX_DOWNLOAD_DURATION_SECONDS;
}
