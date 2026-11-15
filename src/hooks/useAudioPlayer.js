import { useEffect, useState, useSyncExternalStore } from 'react';
import { PlaybackController } from '../services/PlaybackController.js';
import { resolvePlaybackUrl } from '../services/playbackSource.js';
import { shouldIgnoreGlobalPlaybackShortcut } from '../services/playbackShortcuts.js';
import {
  buildMediaMetadataInit,
  registerMediaSessionActions,
  syncMediaSessionState,
} from '../services/playbackMediaSession.js';

export const ACTIONS = ['loadAndPlay', 'configurePlayback', 'togglePlay', 'play', 'pause', 'seek', 'changeVolume', 'toggleMute', 'setRpm',
  'setPitchModifier', 'setPitchRange', 'beginScratch', 'setScratchAngularVelocity', 'endScratch', 'setNeedleLifted', 'clearError',
  'setPlayerError', 'stop', 'playNext', 'playPrev', 'enqueueNext', 'addToQueue', 'removeFromQueue', 'reorderQueue', 'clearQueue',
  'setQueueAndPlay', 'playQueueItem', 'toggleShuffle', 'toggleRepeat', 'setEqPreset', 'setBandGain', 'setEqGains', 'setEqEnabled', 'setCrossfade', 'setSleepTimer',
  'setDjModeEnabled', 'setDjVoiceEnabled', 'setDjPrediction', 'planDjTransition', 'clearDjPlan', 'event'];

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
      if (shouldIgnoreGlobalPlaybackShortcut(event)) return;
      const key = event.key === ' ' || event.code === 'Space' ? ' ' : event.key;
      const action = {
        ' ': controller.togglePlay, MediaPlayPause: controller.togglePlay, MediaStop: controller.stop,
        MediaTrackNext: () => controller.playNext({ reason: 'user-next' }), MediaTrackPrevious: controller.playPrev,
        ArrowRight: () => controller.seek(state.progress + 5 / (state.duration || 1) * 100),
        ArrowLeft: () => controller.seek(state.progress - 5 / (state.duration || 1) * 100),
        m: controller.toggleMute,
      }[key];
      if (action) { event.preventDefault(); action(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controller, state.duration, state.progress]);

  const hasSong = Boolean(state.currentSong);
  const songTitle = state.currentSong?.track || '';
  const songArtist = state.currentSong?.artist || '';
  const songAlbum = state.currentSong?.album || '';
  const songCover = state.currentSong?.coverArtUrl || '';

  useEffect(() => {
    const session = navigator.mediaSession;
    if (!session || !hasSong) return;
    return registerMediaSessionActions(session, controller);
  }, [controller, hasSong]);

  useEffect(() => {
    const session = navigator.mediaSession;
    if (!session || typeof MediaMetadata !== 'function') return;
    session.metadata = hasSong
      ? new MediaMetadata(buildMediaMetadataInit({
        track: songTitle,
        artist: songArtist,
        album: songAlbum,
        coverArtUrl: songCover,
      }))
      : null;
  }, [hasSong, songTitle, songArtist, songAlbum, songCover]);

  useEffect(() => {
    syncMediaSessionState(navigator.mediaSession, state);
  }, [state]);

  return { ...state, audioRef: controller.audioRef, ...Object.fromEntries(ACTIONS.map(name => [name, controller[name]])) };
}
