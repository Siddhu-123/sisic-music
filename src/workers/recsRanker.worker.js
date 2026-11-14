import { buildUpNextRecommendations, rankContextualSongs } from '../services/contextualRecommendationService.js';

self.onmessage = async event => {
  const { requestId, mode, payload } = event.data || {};
  try {
    if (mode === 'up-next') {
      const songs = await buildUpNextRecommendations(payload || {});
      self.postMessage({ requestId, songKeys: songs.map(s => s.songKey), items: songs });
      return;
    }
    if (mode === 'rank-contextual') {
      const ranked = rankContextualSongs(payload?.songs || [], payload?.options || {});
      self.postMessage({ requestId, songKeys: ranked.map(s => s.songKey), items: ranked });
      return;
    }
    self.postMessage({ requestId, error: `Unknown recs worker mode: ${mode}` });
  } catch (error) {
    self.postMessage({ requestId, error: error?.message || String(error) });
  }
};
