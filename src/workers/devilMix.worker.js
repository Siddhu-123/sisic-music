import { buildDevilMix } from '../services/mixEngine.js';

self.onmessage = event => {
  const { requestId, songs, gemmaVectors, events } = event.data || {};
  try {
    const ordered = buildDevilMix({ songs, gemmaVectors, events });
    self.postMessage({ requestId, songKeys: ordered.map(song => song.songKey) });
  } catch (error) {
    self.postMessage({ requestId, error: error?.message || String(error) });
  }
};
