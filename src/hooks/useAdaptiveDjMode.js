import { useEffect, useMemo, useRef } from 'react';
import { cacheDjTransitionScores, getDjTransitionScores } from '../db.js';
import { buildSkipObservations, chooseDjCandidate, chooseDjTransitionTime, DJ_SKIP_THRESHOLD, predictSkipProbability, rankDjCandidates } from '../services/djModeService.js';

export function useAdaptiveDjMode(player, songs, playbackEvents, likedSongKeys) {
  const observations = useMemo(() => buildSkipObservations(playbackEvents), [playbackEvents]);
  const latest = useRef(null);
  useEffect(() => { latest.current = { player, songs, playbackEvents, likedSongKeys, observations }; });
  useEffect(() => {
    if (!player.djModeEnabled || !player.isPlaying) return undefined;
    let cancelled = false;
    let busy = false;
    const evaluate = async () => {
      if (busy || cancelled) return;
      const state = latest.current;
      const p = state.player;
      if (!p.currentSong || p.djPlan || p.isBuffering || p.repeatMode === 'one' || p.sleepTimer?.mode === 'track') return;
      const positionSeconds = p.progress / 100 * p.duration;
      const fadeSeconds = Math.max(2, Math.min(p.crossfadeSeconds || 4, 7));
      if (positionSeconds < 8 || p.duration - positionSeconds <= fadeSeconds + 2) return;
      const source = state.songs.find(song => song.songKey === p.currentSongKey) || p.currentSong;
      const prediction = predictSkipProbability({ song: source, songs: state.songs, observations: state.observations, positionSeconds, durationSeconds: p.duration });
      p.setDjPrediction(prediction);
      if (prediction.probability < DJ_SKIP_THRESHOLD) return;
      busy = true;
      try {
        // IndexedDB is an optional optimization; unavailable storage must not stop DJ mode.
        const cached = await getDjTransitionScores(p.currentSongKey).catch(() => []);
        if (cancelled) return;
        const transitionAtSeconds = chooseDjTransitionTime(prediction, p.duration, fadeSeconds, p.djHistory);
        const ranked = rankDjCandidates({ source, songs: state.songs, playbackEvents: state.playbackEvents, positionSeconds: transitionAtSeconds,
          likedSongKeys: state.likedSongKeys, history: p.djHistory, transitionScores: new Map(cached.map(score => [score.cacheKey, score])) });
        const choice = chooseDjCandidate(ranked, { history: p.djHistory });
        if (!choice || transitionAtSeconds == null || cancelled) return;
        const current = latest.current.player;
        if (current.currentSongKey !== p.currentSongKey || current.queueRevision !== p.queueRevision
          || Math.abs(current.progress / 100 * current.duration - positionSeconds) > 4) return;
        p.planDjTransition({ sourceSongKey: p.currentSongKey, candidate: choice.song, probability: prediction.probability,
          fallback: choice.fallback, transitionAtSeconds, crossfadeSeconds: fadeSeconds });
        cacheDjTransitionScores(ranked.map(item => item.transition)).catch(() => {});
      } catch (error) {
        console.warn('Adaptive DJ ranking failed:', error);
      } finally { busy = false; }
    };
    evaluate();
    const timer = setInterval(evaluate, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [player.djModeEnabled, player.isPlaying, player.currentSongKey]);
}
