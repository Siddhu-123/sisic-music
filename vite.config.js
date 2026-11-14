import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  cacheDir: 'node_modules/.vite/sisic-music',
  base: './', // Using relative paths to make it easier for GitHub Pages sub-directories
  plugins: [react()],
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
