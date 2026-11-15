import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function sisicDevCachePlugin() {
  return {
    name: 'sisic-dev-cache',
    configureServer(server) {
      server.middlewares.use('/@sisic-dev-cache/snapshot', (_req, res) => {
        try {
          const cacheRoot = path.resolve(__dirname, '../mac-app/.cache');
          const readJson = relPath => {
            const full = path.join(cacheRoot, relPath);
            return fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, 'utf8')) : null;
          };
          const songsDoc = readJson('sisic-songs.json');
          const playlistsDoc = readJson('sisic-playlists.json');
          const playbackDoc = readJson('sisic-playback-log.json');
          const vectorsDoc = readJson('embeddinggemma2/vectors-v3.json');
          const mergedHistoryDoc = readJson('sisic-merged-history.json');

          const payload = {
            available: Boolean(songsDoc?.songs?.length),
            songs: Array.isArray(songsDoc?.songs) ? songsDoc.songs : [],
            playlists: Array.isArray(playlistsDoc?.playlists) ? playlistsDoc.playlists : [],
            playbackEvents: Array.isArray(playbackDoc?.events) ? playbackDoc.events : [],
            vectorsPayload: vectorsDoc?.model && Array.isArray(vectorsDoc?.songs) ? vectorsDoc : null,
            mergedHistoryPack: mergedHistoryDoc?.events?.length ? mergedHistoryDoc : null,
          };
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(payload));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ available: false, error: err.message }));
        }
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  cacheDir: 'node_modules/.vite/sisic-music',
  base: './', // Using relative paths to make it easier for GitHub Pages sub-directories
  plugins: [react(), sisicDevCachePlugin()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/react-dom/') || id.includes('/node_modules/react/')) {
            return 'vendor-react';
          }
          if (id.includes('/node_modules/dexie')) {
            return 'vendor-dexie';
          }
          if (id.includes('/node_modules/lucide-react/')) {
            return 'vendor-lucide';
          }
          if (/\/src\/services\/(contextualRecommendationService|behaviourLearning|flowPath|mixEngine|exploreService|tasteEmbeddingService|galaxyService|djSetPlanner|devilMixClient|infiniteRadio|gemmaVectors)/.test(id)) {
            return 'recs-engine';
          }
        },
      },
    },
  },
})
