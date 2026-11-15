import { bulkSeedSnapshotToDb, db } from '../db.js';
import { importGemmaVectors, RECS_V3_MODEL } from './gemmaVectors.js';
import { asSongRecord } from '../songIdentity.js';

let pendingHydration = null;

/**
 * Hydrates IndexedDB from local `mac-app/.cache` files when running under `vite dev`
 * with an empty local database (or missing v3 128D vectors / incomplete song cache)
 * so local review uses real data.
 */
export async function hydrateFromDevCache({ force = false, fetchImpl = fetch } = {}) {
  if (!import.meta.env.DEV || typeof fetchImpl !== 'function') {
    return { hydrated: false, songCount: 0, vectorCount: 0, eventCount: 0 };
  }
  if (pendingHydration && !force) return pendingHydration;

  pendingHydration = (async () => {
    try {
      const [existingCount, existingVecCount, existingV3Count, existingEventCount] = await Promise.all([
        db.songs.count(),
        db.songVectors.count(),
        db.songVectors.where('embeddingModel').equals(RECS_V3_MODEL).count(),
        db.playbackEvents.count(),
      ]);
      if (existingCount >= 4000 && existingV3Count > 0 && existingEventCount > 0 && !force) {
        return { hydrated: false, songCount: existingCount, vectorCount: existingVecCount, eventCount: existingEventCount };
      }

      const res = await fetchImpl('/@sisic-dev-cache/snapshot', { cache: 'no-store' });
      if (!res?.ok) return { hydrated: false, songCount: existingCount, vectorCount: existingVecCount, eventCount: existingEventCount };
      const snapshot = await res.json();
      if (!snapshot?.available || !Array.isArray(snapshot.songs) || snapshot.songs.length === 0) {
        return { hydrated: false, songCount: existingCount, vectorCount: existingVecCount, eventCount: existingEventCount };
      }

      const normalizedSongs = snapshot.songs.map(raw => asSongRecord(raw));
      if (existingCount === 0 || force) {
        await bulkSeedSnapshotToDb({
          songs: normalizedSongs,
          playlists: snapshot.playlists || [],
          playbackEvents: snapshot.playbackEvents || [],
        });
      } else {
        if (existingCount < normalizedSongs.length) {
          const existingRows = await db.songs.toArray();
          const byKey = new Map(existingRows.map(row => [row.songKey, row]));
          const toPut = [];
          for (const song of normalizedSongs) {
            const prev = byKey.get(song.songKey);
            if (!prev || (!prev.driveFileId && song.driveFileId)) {
              toPut.push(prev ? { ...prev, ...song, driveFileId: song.driveFileId || prev.driveFileId } : song);
            }
          }
          const chunkSize = 500;
          for (let start = 0; start < toPut.length; start += chunkSize) {
            await db.songs.bulkPut(toPut.slice(start, start + chunkSize));
          }
        }
        if (existingEventCount === 0 && Array.isArray(snapshot.playbackEvents) && snapshot.playbackEvents.length > 0) {
          const validEvents = snapshot.playbackEvents
            .filter(evt => evt && (evt.id || evt.eventId))
            .map(evt => ({ ...evt, eventId: evt.eventId || evt.id }));
          if (validEvents.length > 0) await db.playbackEvents.bulkPut(validEvents);
        }
      }

      let importedVectors = existingVecCount;
      if ((existingV3Count === 0 || force) && snapshot.vectorsPayload) {
        const vecRes = await importGemmaVectors(snapshot.vectorsPayload, normalizedSongs);
        importedVectors = vecRes?.imported || 0;
      }

      return {
        hydrated: true,
        songCount: normalizedSongs.length,
        vectorCount: importedVectors,
        eventCount: snapshot.playbackEvents?.length || 0,
        driveIndexSongs: normalizedSongs,
        drivePlaybackEvents: snapshot.playbackEvents || [],
      };
    } catch (error) {
      console.warn('Dev local cache hydration skipped:', error);
      return { hydrated: false, songCount: 0, vectorCount: 0, eventCount: 0 };
    } finally {
      pendingHydration = null;
    }
  })();

  return pendingHydration;
}
