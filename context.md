# Sisic Music: project context

A handoff note for the next person or AI session working on this repo. Last updated 2026-09-30.

## What the app is

A private, client-side music player (React 19 + Vite, IndexedDB via Dexie). Songs come from a Spotify library export and play from Google Drive or an offline cache. Everything personal (taste profile, recommendations, galaxy map) is computed in the browser.

Main features:
- **Vinyl turntable player.** Real-time platter physics, scratching, a tonearm used as a seek control, and a 33⅓/45 RPM pitch fader.
- **Taste profile.** Built from playback events, likes and play counts.
- **Recommendations.** Explore mixes, "More like this", Up Next, and a DJ mode with crossfade.
- **Galaxy.** A 3D WebGL map of the library, grouped into clusters by similarity.
- **Other:** light/dark theme toggle, playlists (create/delete), Drive tasks and offline downloads, and a Cloudflare backend for auth.

## Branches and deployment

| Branch | Purpose |
|---|---|
| `main` | Source of truth. Has every feature (all feature branches were merged in on 2026-09-30). |
| `gh-pages` | Built site served by GitHub Pages. Currently a build of `main` at `4c68d7d`. |
| `claude/kind-tesla-teoaly` | Temp branch for new updates. It is `main` plus the improvements below, not yet merged or deployed. |
| `claude/archive-old-fixes` | Old work built on a pre-merge `main`. Superseded; safe to delete. |
| `feature/backend-dj-galaxy`, `feature/contextual-sequential-recommender` | Fully merged into `main`. Delete on GitHub (the session's git proxy can't delete branches). |

**Deploying:** run `npm run deploy` from `main`. It builds, then pushes `dist/` to `gh-pages`. The build needs these variables in `.env` (the values are public in the built JavaScript anyway):
- `VITE_GOOGLE_CLIENT_ID`
- `VITE_SPOTIFY_JSON_FILE_ID`
- `VITE_DRIVE_FOLDER_ID`

**Local UI preview without Google login:** `npm run dev`, then open `/?ui-preview`. Seed songs from the browser console with `import('/src/db.js')` and `syncLibraryToDb(...)`.

**Checks:** `npm run lint`, `npm test` (132 tests, all passing on the temp branch), `npm run build`.

## Key files

- `src/App.jsx`: app shell, views, playback wiring
- `src/components/Turntable.jsx`, `src/vinylPhysics.js`, `src/services/VinylAudioEngine.js`: player and physics
- `src/components/views/ConstellationView.jsx`, `src/services/galaxyService.js`: the galaxy
- `src/services/tasteEmbeddingService.js`: 64D metadata embedding (v2) and `getSongEmbedding`
- `src/services/contextualRecommendationService.js`: sessions, taste profile, ranking, Up Next
- `src/services/exploreService.js`, `src/services/djModeService.js`: Explore mixes and DJ mode
- `src/services/embeddingService.js`: learned-audio embeddings (`msd-musicnn-1`, 200D, from the local Mac worker)
- `src/db.js`: Dexie schema. Stored embeddings carry `vectorType`, `model` and `dimensions`.
- `src/App.css`, `src/responsive-ui.css`, `src/player-reference.css`: styles. `responsive-ui.css` loads last, so its rules win.

## Embedding rules

These are important: breaking them makes the galaxy and the rankings meaningless.

1. **Never mix vector spaces.**
   - Learned-audio vectors are 200D (`vectorType: 'learned-audio'`, `model: 'msd-musicnn-1'`).
   - Metadata vectors are 64D.
   - Compare vectors only within one space. Use `resolveEmbeddingMetadata` and `areVectorSpacesCompatible` to check.
2. **Metadata vectors are versioned.**
   - The current model is `metadata-ngram-v2` (`METADATA_EMBEDDING_MODEL`).
   - `getSongEmbedding(song)` ignores stored v1 vectors (`metadata-ngram-v1`, or provider `sisic-client` without the v2 model) and ignores audio vectors. It recomputes instead, with a memoised cache.
   - If the metadata algorithm changes, bump the model name.
3. **The galaxy uses one space for the whole map** (`chooseGalaxySpace`).
   - "Sound" mode uses audio vectors. It is chosen when at least 12 songs, and at least 25% of the library, share one audio model.
   - Otherwise every song uses metadata ("Tags" mode).

## Work on the temp branch (not yet in `main`)

1. **Recommendations**
   - Metadata embedding v2: weighted title/mood/artist blocks, whole-word mood markers, signed artist hash.
   - Likes and play counts feed the taste vector.
   - Stale sessions fade out (6-hour half-life); recent skips are penalised.
   - Likes are passed to Explore, DJ mode and Up Next.
   - Explore never uses the "Open format"/"Discovery" fallback labels for mixes or filters.
   - "More like this" match % is plain cosine similarity, so unrelated songs no longer show as 50%+ matches.
   - Fixed a 200D test fixture that was building 64D vectors.
2. **Galaxy**
   - New `galaxyService`: single vector space, seeded k-means++, PCA to 3D in any dimension, framing inside the unit sphere so the cloud stays on screen.
   - Clusters get readable, numbered-if-duplicate labels; clicking a cluster plays it as a mix, hovering one dims the others.
   - Sound/Tags toggle.
   - Rendering fixes: aspect-correct projection, tap-to-play on touch, zoom without rebuilding WebGL, colours that don't wash out to white, a memoised song list.
3. **UI**
   - Drive storage summary shows only on Home/Drive Tasks.
   - Swipe rows on phones for the storage summary, Explore filters and galaxy clusters.
   - No grey scrollbar band under card rows.
   - The card play button is no longer announced as a menu.
4. **Turntable**
   - 33 means 33⅓ RPM, in the engine and the platter.
   - A record scratched while paused settles to rest.
   - The lifted tonearm rests off the record (`TONEARM_LIFTED_ANGLE = -9`).

**Next step:** review the temp branch, merge it into `main`, then `npm run deploy`.

## Known gaps and ideas

- These screens haven't been reviewed in depth: Queue panel, Equalizer, Song Info, Duplicates, Drive Tasks.
- Real Drive playback can't be tested in `?ui-preview` mode (the audio loading waits on Drive state).
- Tonearm angles are constants tuned for the desktop layout. The mobile layout sweeps roughly −4°→22°.
- The galaxy caps at 1,200 songs for performance.
