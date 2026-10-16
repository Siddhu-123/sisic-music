# Sisic EmbeddingGemma service

FastAPI service that embeds audio clips with the shared EmbeddingGemma 2 model and stores vectors in the same SQLite schema used by `backfill_mac.py`.

- Model: `embeddinggemma-2@fp32/clip30/v1` (768 dimensions, fp32 on CPU).
- Clips: 16 kHz mono float32 PCM, up to 30 seconds. The shared core chooses first-pass offsets at 20%, 50%, and 80%; full coverage tiles the song and aligns the final clip to its end.
- The VM keeps only queued PCM spool files until each vector is stored. It removes the PCM file after success or error.
- `POST /clips` enqueues audio; `GET /jobs` reports queue progress; `GET /vectors` syncs stored vectors by timestamp; `POST /query` embeds search text; `GET /neighbors` finds cosine neighbors; `GET /health` is public.

All other endpoints require `Authorization: Bearer <token>`. Configure `SISIC_EMBED_TOKEN` in the environment. The deploy script creates a random token in `/etc/sisic-embed.env` if that file is absent.

The Mac backfill and VM use `sisic_embed/core.py`, `store.py`, and the same `(file_hash, offset_s, model)` clip key. Point both processes to the same database only when they can safely share the filesystem; otherwise sync vectors through the service API.

See [deploy/DEPLOY.md](deploy/DEPLOY.md) for VM setup.
