import { useEffect, useState, useSyncExternalStore } from 'react';
import { PlaybackController } from '../services/PlaybackController.js';
import { resolvePlaybackUrl } from '../services/playbackSource.js';

const ACTIONS = ['loadAndPlay', 'configurePlayback', 'togglePlay', 'play', 'pause', 'seek', 'changeVolume', 'toggleMute', 'setRpm',
  'setPitchModifier', 'setPitchRange', 'beginScratch', 'setScratchAngularVelocity', 'endScratch', 'setNeedleLifted', 'clearError',
  'setPlayerError', 'stop', 'playNext', 'playPrev', 'enqueueNext', 'addToQueue', 'removeFromQueue', 'reorderQueue', 'clearQueue',
  'setQueueAndPlay', 'playQueueItem', 'toggleShuffle', 'toggleRepeat', 'setEqPreset', 'setBandGain', 'setCrossfade', 'setSleepTimer',
  'setDjModeEnabled', 'setDjPrediction', 'planDjTransition', 'clearDjPlan'];

export function useAudioPlayer() {
  const [controller] = useState(() => {
    let storage;
    try { storage = window.localStorage; } catch { /* private mode */ }
    return new PlaybackController({ resolveUrl: resolvePlaybackUrl, storage });
  });
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    controller.activate();
    const onVisibility = () => controller.visibilityChanged(document.hidden);
    const onPageHide = () => controller.persist();
    const timer = window.setInterval(controller.checkSleep, 1000);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      controller.dispose();
    };
  }, [controller]);

  useEffect(() => {
    const onKeyDown = event => {
      if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.target?.closest?.('input, textarea, select, button, [contenteditable="true"], [role="slider"], [role="dialog"]')) return;
      const action = {
        ' ': controller.togglePlay, MediaPlayPause: controller.togglePlay, MediaStop: controller.stop,
        MediaTrackNext: () => controller.playNext({ reason: 'user-next' }), MediaTrackPrevious: controller.playPrev,
        ArrowRight: () => controller.seek(state.progress + 5 / (state.duration || 1) * 100),
        ArrowLeft: () => controller.seek(state.progress - 5 / (state.duration || 1) * 100),
        m: controller.toggleMute,
      }[event.key];
      if (action) { event.preventDefault(); action(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controller, state.duration, state.progress]);

  useEffect(() => {
    const session = navigator.mediaSession;
    if (!session) return;
    const song = state.currentSong;
    if (typeof MediaMetadata === 'function') session.metadata = song ? new MediaMetadata({
      title: song.track || 'Unknown track', artist: song.artist || 'Unknown artist', album: song.album || 'Sisic Music',
      artwork: song.coverArtUrl ? [{ src: song.coverArtUrl }] : [],
    }) : null;
    const seekSeconds = seconds => controller.seek(seconds / (controller.audio?.duration || 1) * 100);
    const actions = {
      play: controller.play, pause: controller.pause, stop: controller.stop,
      previoustrack: controller.playPrev, nexttrack: () => controller.playNext({ reason: 'user-media-session' }),
      seekto: details => seekSeconds(details.seekTime),
      seekbackward: details => seekSeconds((controller.audio?.currentTime || 0) - (details.seekOffset || 10)),
      seekforward: details => seekSeconds((controller.audio?.currentTime || 0) + (details.seekOffset || 10)),
    };
    // Browsers support different action subsets. One unsupported action must not block the others.
    for (const [name, handler] of Object.entries(actions)) {
      try { session.setActionHandler(name, song ? handler : null); } catch { /* unsupported action */ }
    }
    return () => {
      for (const name of Object.keys(actions)) { try { session.setActionHandler(name, null); } catch { /* unsupported */ } }
      session.metadata = null;
      session.playbackState = 'none';
    };
  }, [controller, state.currentSong]);

  useEffect(() => {
    const session = navigator.mediaSession;
    if (!session) return;
    session.playbackState = state.currentSong ? (state.isPlaying ? 'playing' : 'paused') : 'none';
    try {
      session.setPositionState?.(state.duration > 0 ? {
        duration: state.duration, position: Math.min(state.duration, state.progress / 100 * state.duration),
        playbackRate: (state.rpm / 45) * state.pitchModifier,
      } : undefined);
    } catch { /* position reporting is optional */ }
  }, [state.currentSong, state.isPlaying, state.duration, state.progress, state.rpm, state.pitchModifier]);

  return { ...state, audioRef: controller.audioRef, ...Object.fromEntries(ACTIONS.map(name => [name, controller[name]])) };
}
