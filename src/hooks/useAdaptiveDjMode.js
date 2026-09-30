import { useEffect, useMemo, useRef } from 'react';
import { cacheDjTransitionScores, getDjTransitionScores } from '../db.js';
import { getSongKey } from '../songIdentity.js';
import { commentaryFor } from '../services/djCommentary.js';
import {
  factsFor,
  nextFromSet,
  planNextSet,
  shouldSpeak,
} from '../services/djSetDirector.js';
import {
  buildSkipObservations,
  chooseDjCandidate,
  chooseDjTransitionTime,
  DJ_SKIP_THRESHOLD,
  planDjMix,
  predictSkipProbability,
  rankDjCandidates,
  scoreDjTransition,
} from '../services/djModeService.js';

export function useAdaptiveDjMode(player, songs, playbackEvents, likedSongKeys) {
  const observations = useMemo(() => buildSkipObservations(playbackEvents), [playbackEvents]);
  const latest = useRef(null);
  const djSetRef = useRef(null);
  const playedRef = useRef([]); // { key, artist } of songs DJ mode has worked from, newest last
  const commentaryMemoryRef = useRef({ recent: [] });

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

        const findSong = key => state.songs.find(s => (s.songKey || getSongKey(s)) === key);
        if (playedRef.current.at(-1)?.key !== p.currentSongKey) playedRef.current = [...playedRef.current, { key: p.currentSongKey, artist: source.artist }].slice(-4);

        let candidate = null;
        let kind = null;
        let isFallback = false;

        let nextKey = nextFromSet(djSetRef.current, p.currentSongKey);
        if (nextKey) {
          const song = findSong(nextKey);
          if (song && song.driveFileId) {
            candidate = song;
            kind = 'link';
          }
        }

        if (!candidate) {
          const count = 3 + Math.floor(Math.random() * 3);
          const newSet = planNextSet({ source, ranked, count, rng: Math.random, recentArtists: playedRef.current.slice(0, -1).map(entry => entry.artist) });
          if (newSet?.keys?.length) {
            djSetRef.current = newSet;
            const firstKey = nextFromSet(newSet, p.currentSongKey);
            if (firstKey) {
              const song = findSong(firstKey);
              if (song && song.driveFileId) {
                candidate = song;
                kind = 'set-intro';
              }
            }
          }
        }

        let choice = null;
        if (!candidate) {
          choice = chooseDjCandidate(ranked, { history: p.djHistory });
          if (choice) {
            candidate = choice.song;
            isFallback = Boolean(choice.fallback);
            djSetRef.current = null;
            kind = null;
          }
        }

        if (!candidate || cancelled) return;

        const candidateKey = candidate.songKey || getSongKey(candidate);
        const rankedItem = ranked.find(item => (item.song?.songKey || getSongKey(item.song)) === candidateKey);
        const transition = choice?.transition || rankedItem?.transition || scoreDjTransition(source, candidate, transitionAtSeconds);

        const plan = planDjMix({ source, candidate, positionSeconds, duration: p.duration, prediction, transition, history: p.djHistory, fadeSeconds });
        if (plan?.transitionAtSeconds == null) return;

        const current = latest.current.player;
        if (current.currentSongKey !== p.currentSongKey || current.queueRevision !== p.queueRevision
          || Math.abs(current.progress / 100 * current.duration - positionSeconds) > 4) return;

        let commentaryText = null;
        if (p.djVoiceEnabled && kind) {
          try {
            const speakAllowed = shouldSpeak({
              kind,
              mix: plan,
              outgoing: source,
              incoming: candidate,
              rng: Math.random,
            });
            if (speakAllowed) {
              const historyMap = new Map();
              for (const ev of (state.playbackEvents || [])) {
                if (!ev?.songKey) continue;
                const isPlay = ev.eventType === 'playback-start'; // a finished play is also logged as complete: count starts only
                if (!isPlay) continue;
                const prev = historyMap.get(ev.songKey) || { playCount: 0, lastPlayedAt: null };
                const createdAt = ev.createdAt ? (Date.parse(ev.createdAt) || Number(ev.createdAt)) : null;
                const lastPlayedAt = createdAt && (!prev.lastPlayedAt || createdAt > prev.lastPlayedAt) ? createdAt : prev.lastPlayedAt;
                historyMap.set(ev.songKey, { playCount: prev.playCount + 1, lastPlayedAt });
              }

              const facts = factsFor({
                outgoing: source,
                incoming: candidate,
                set: djSetRef.current,
                mix: plan,
                history: historyMap,
                now: Date.now(),
              });

              const comm = commentaryFor({
                kind,
                facts,
                memory: commentaryMemoryRef.current || { recent: [] },
                rng: Math.random,
              });

              if (comm?.text) {
                commentaryText = comm.text;
                commentaryMemoryRef.current = comm.memory;
              }
            }
          } catch {
            /* never throw from speaking path */
          }
        }

        p.planDjTransition({ ...plan, sourceSongKey: p.currentSongKey, candidate, probability: prediction.probability,
          fallback: isFallback, sourceRhythm: source.djRhythm, candidateRhythm: candidate.djRhythm, commentaryText });
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
