/**
 * Manages navigator.mediaSession registration and state updates so lock-screen
 * and hardware remote controls stay active across song-to-song transitions.
 */

export function registerMediaSessionActions(session, controller) {
  if (!session || !controller) return () => {};
  const seekSeconds = seconds => {
    const duration = controller.audio?.duration;
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(seconds)) return;
    controller.seek((seconds / duration) * 100);
  };
  const actions = {
    play: controller.play,
    pause: controller.pause,
    stop: controller.stop,
    previoustrack: controller.playPrev,
    nexttrack: () => controller.playNext({ reason: 'user-media-session' }),
    seekto: details => {
      if (Number.isFinite(details?.seekTime)) seekSeconds(details.seekTime);
    },
    seekbackward: details => seekSeconds((controller.audio?.currentTime || 0) - (details?.seekOffset || 10)),
    seekforward: details => seekSeconds((controller.audio?.currentTime || 0) + (details?.seekOffset || 10)),
  };
  // Browsers support different action subsets. One unsupported action must not block the others.
  for (const [name, handler] of Object.entries(actions)) {
    try { session.setActionHandler(name, handler); } catch { /* unsupported action */ }
  }
  return () => {
    for (const name of Object.keys(actions)) {
      try { session.setActionHandler(name, null); } catch { /* unsupported action */ }
    }
    session.metadata = null;
    session.playbackState = 'none';
  };
}

export function buildMediaMetadataInit(song) {
  if (!song) return null;
  return {
    title: song.track || 'Unknown track',
    artist: song.artist || 'Unknown artist',
    album: song.album || 'Sisic Music',
    artwork: song.coverArtUrl ? [{ src: song.coverArtUrl }] : [],
  };
}

export function computeMediaPositionState({ duration, progress, rpm, pitchModifier } = {}) {
  const safeDuration = Number(duration);
  if (!Number.isFinite(safeDuration) || safeDuration <= 0) return undefined;
  const rawPosition = ((Number(progress) || 0) / 100) * safeDuration;
  const position = Math.max(0, Math.min(safeDuration, rawPosition));
  const rawRate = ((Number(rpm) || 45) / 45) * (Number(pitchModifier) || 1);
  const playbackRate = Number.isFinite(rawRate) && rawRate > 0 ? Math.max(0.0625, rawRate) : 1;
  return { duration: safeDuration, position, playbackRate };
}

export function syncMediaSessionState(session, state = {}) {
  if (!session) return;
  const hasSong = Boolean(state.currentSong);
  session.playbackState = hasSong
    ? (state.isPlaying || state.isPlayRequested ? 'playing' : 'paused')
    : 'none';
  try {
    session.setPositionState?.(hasSong ? computeMediaPositionState(state) : undefined);
  } catch { /* position reporting is optional */ }
}
