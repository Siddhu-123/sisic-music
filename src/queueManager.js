export const REPEAT_MODES = ['off', 'one', 'all'];

export function queueItemKey(song = {}) {
  return song.songKey || song.id || null;
}

export function dedupeQueue(songs = [], { allowDuplicate = false } = {}) {
  if (allowDuplicate) return [...songs].filter(Boolean);
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
  if (fromIndex < 0 || fromIndex >= queue.length || toIndex < 0 || toIndex >= queue.length) {
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

export function serializeQueueState(state = {}) {
  return JSON.stringify({
    version: 1,
    queue: dedupeQueue(state.queue || [], { allowDuplicate: true }),
    queueIndex: Math.max(0, Number(state.queueIndex) || 0),
    repeatMode: REPEAT_MODES.includes(state.repeatMode) ? state.repeatMode : 'off',
    shuffleMode: state.shuffleMode || 'off',
    positionSeconds: Math.max(0, Number(state.positionSeconds) || 0),
    isPlaying: Boolean(state.isPlaying),
    savedAt: new Date().toISOString(),
  });
}

export function restoreQueueState(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || !Array.isArray(parsed.queue)) return null;
    return {
      queue: parsed.queue.filter(Boolean),
      queueIndex: Math.min(Math.max(0, Number(parsed.queueIndex) || 0), Math.max(0, parsed.queue.length - 1)),
      repeatMode: REPEAT_MODES.includes(parsed.repeatMode) ? parsed.repeatMode : 'off',
      shuffleMode: parsed.shuffleMode || 'off',
      positionSeconds: Math.max(0, Number(parsed.positionSeconds) || 0),
      isPlaying: Boolean(parsed.isPlaying),
    };
  } catch {
    return null;
  }
}
