export const REPEAT_MODES = ['off', 'one', 'all'];

export function queueItemKey(song = {}) {
  return song?.songKey || song?.id || song?.driveFileId || null;
}

export function dedupeQueue(songs = [], { allowDuplicate = false } = {}) {
  if (!Array.isArray(songs)) return [];
  if (allowDuplicate) return songs.filter(song => song && typeof song === 'object' && queueItemKey(song));
  const seen = new Set();
  return songs.filter(song => {
    const key = queueItemKey(song);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function insertAfter(queue = [], index = -1, song, { allowDuplicate = false } = {}) {
  if (!song) return [...queue];
  const next = allowDuplicate
    ? [...queue]
    : queue.filter(item => queueItemKey(item) !== queueItemKey(song));
  const currentIndex = next.findIndex(item => queueItemKey(item) === queueItemKey(queue[index]));
  const insertAt = Math.min(Math.max(currentIndex, -1) + 1, next.length);
  next.splice(insertAt, 0, song);
  return next;
}

export function insertAtEnd(queue = [], song, { allowDuplicate = false } = {}) {
  if (!song) return [...queue];
  const next = allowDuplicate
    ? [...queue]
    : queue.filter(item => queueItemKey(item) !== queueItemKey(song));
  next.push(song);
  return next;
}

export function removeAt(queue = [], index = -1) {
  if (index < 0 || index >= queue.length) return [...queue];
  return queue.filter((_, itemIndex) => itemIndex !== index);
}

export function reorderQueue(queue = [], fromIndex = -1, toIndex = -1) {
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex < 0 || fromIndex >= queue.length || toIndex < 0 || toIndex >= queue.length) {
    return [...queue];
  }
  const next = [...queue];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

export function nextQueueIndex({ length, currentIndex, repeatMode = 'off', avoidCurrent = false }) {
  if (!length) return -1;
  const lastIndex = length - 1;
  if (avoidCurrent && length === 1) return -1;
  if (currentIndex < lastIndex) return currentIndex + 1;
  if (repeatMode === 'all') return 0;
  return -1;
}

export function previousQueueIndex({ length, currentIndex, repeatMode = 'off' }) {
  if (!length) return -1;
  if (currentIndex > 0) return currentIndex - 1;
  return repeatMode === 'all' ? length - 1 : 0;
}

function nonnegative(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : fallback;
}

export function serializeQueueState(state = {}) {
  return JSON.stringify({ ...restoreQueueState(state), version: 1, savedAt: new Date().toISOString() });
}

export function restoreQueueState(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || !Array.isArray(parsed.queue)) return null;
    const selectedKey = queueItemKey(parsed.queue[Math.floor(nonnegative(parsed.queueIndex))]);
    const cleanRecord = song => {
      if (!song || typeof song !== 'object') return null;
      const result = { ...song };
      for (const field of ['localFile', 'blob', 'isDownloaded', 'isCached', 'hasBlob', 'cacheSizeBytes', 'cachedAt']) delete result[field];
      return result;
    };
    const queue = dedupeQueue(parsed.queue).map(cleanRecord).filter(Boolean);
    const selectedIndex = queue.findIndex(song => queueItemKey(song) === selectedKey);
    const manualQueue = dedupeQueue(parsed.manualQueue || [])
      .map(song => queue.find(item => queueItemKey(item) === queueItemKey(song)) || cleanRecord(song))
      .filter(song => queueItemKey(song));
    const sleepTimer = parsed.sleepTimer?.mode === 'track' ? { mode: 'track' }
      : parsed.sleepTimer?.mode === 'time' && Number.isFinite(parsed.sleepTimer.deadline) ? { mode: 'time', deadline: parsed.sleepTimer.deadline } : null;
    const uniqueStrings = (value, limit) => Array.isArray(value) ? [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))].slice(0, limit) : [];
    const timingBuckets = Array.isArray(parsed.djHistory?.timingBuckets)
      ? [...new Set(parsed.djHistory.timingBuckets.map(Number).filter(Number.isFinite).map(value => Math.max(0, Math.floor(value / 5) * 5)))].slice(0, 4)
      : [];
    return {
      queue,
      originalQueue: dedupeQueue(parsed.originalQueue || []).map(song => queue.find(item => queueItemKey(item) === queueItemKey(song))).filter(Boolean),
      manualQueue,
      queueIndex: selectedIndex >= 0 ? selectedIndex : Math.min(Math.floor(nonnegative(parsed.queueIndex)), Math.max(0, queue.length - 1)),
      repeatMode: REPEAT_MODES.includes(parsed.repeatMode) ? parsed.repeatMode : 'off',
      shuffleMode: ['off', 'shuffle', 'smart'].includes(parsed.shuffleMode) ? parsed.shuffleMode : 'off',
      positionSeconds: nonnegative(parsed.positionSeconds), isPlaying: Boolean(queue.length && parsed.isPlaying),
      volume: Math.min(1, nonnegative(parsed.volume, 1)), muted: Boolean(parsed.muted),
      crossfadeSeconds: Math.min(12, nonnegative(parsed.crossfadeSeconds)), sleepTimer,
      eqPreset: typeof parsed.eqPreset === 'string' ? parsed.eqPreset : 'flat',
      eqGains: Array.isArray(parsed.eqGains) && parsed.eqGains.length === 5 ? parsed.eqGains.map(gain => Math.max(-12, Math.min(12, Number(gain) || 0))) : [0, 0, 0, 0, 0],
      djModeEnabled: Boolean(parsed.djModeEnabled),
      djHistory: { candidateKeys: uniqueStrings(parsed.djHistory?.candidateKeys, 6), timingBuckets },
    };
  } catch { return null; }
}
