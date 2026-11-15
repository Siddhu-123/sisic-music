import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import zlib from 'node:zlib';
import { buildUpNextRecommendations } from './contextualRecommendationService.js';
import {
  buildSessionCooccurrenceGraph,
  deserializeCooccurrenceGraph,
  extractRecentAnchorKeys,
  scoreCooccurrenceCandidate,
  serializeCooccurrenceGraph,
  topCooccurrenceCandidates,
} from './sessionCooccurrence.js';
import {
  extractMatchingZipEntries,
  mergeExternalHistoryPack,
} from './externalHistoryImporter.js';

function createTestZipBlob(files) {
  const localParts = [];
  const cdParts = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const raw = Buffer.from(content, 'utf8');
    const comp = zlib.deflateRawSync(raw);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(8, 8);
    lfh.writeUInt32LE(comp.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBytes.length, 26);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt32LE(offset, 42);

    localParts.push(lfh, nameBytes, comp);
    cdParts.push(cd, nameBytes);
    offset += lfh.length + nameBytes.length + comp.length;
  }

  const cdTotalSize = cdParts.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cdTotalSize, 12);
  eocd.writeUInt32LE(offset, 16);

  return new Blob([...localParts, ...cdParts, eocd]);
}

describe('sessionCooccurrence & externalHistoryImporter', () => {
  it('builds normalized co-occurrence neighbors, serializes round-trip, and boosts up-next ranking', async () => {
    const t0 = Date.parse('2026-10-15T12:00:00Z');
    const events = [];
    for (let s = 0; s < 5; s++) {
      const base = t0 + s * 3600_000;
      events.push(
        { songKey: 'artist a::track a', eventType: 'playback-start', queueId: `q-${s}`, createdAt: new Date(base).toISOString() },
        { songKey: 'artist a::track a', eventType: 'playback-complete', queueId: `q-${s}`, createdAt: new Date(base + 180_000).toISOString() },
        { songKey: 'artist b::track b', eventType: 'playback-start', queueId: `q-${s}`, createdAt: new Date(base + 185_000).toISOString() },
        { songKey: 'artist b::track b', eventType: 'playback-complete', queueId: `q-${s}`, createdAt: new Date(base + 360_000).toISOString() },
        { songKey: 'artist c::skipped c', eventType: 'playback-start', queueId: `q-${s}`, createdAt: new Date(base + 365_000).toISOString() },
        { songKey: 'artist c::skipped c', eventType: 'user-skip', positionSeconds: 8, queueId: `q-${s}`, createdAt: new Date(base + 373_000).toISOString() },
      );
    }

    const graph = buildSessionCooccurrenceGraph(events, { now: t0 + 10 * 3600_000 });
    assert.ok(graph.edgeCount >= 2);
    assert.ok(scoreCooccurrenceCandidate(graph, ['artist a::track a'], 'artist b::track b') > 0.2);
    assert.equal(scoreCooccurrenceCandidate(graph, ['artist a::track a'], 'artist c::skipped c'), 0);

    const anchors = extractRecentAnchorKeys(events.slice(-6), 3);
    assert.deepEqual(anchors, ['artist b::track b', 'artist a::track a']);
    assert.deepEqual(topCooccurrenceCandidates(graph, ['artist a::track a'], 5), ['artist b::track b']);

    const roundTrip = deserializeCooccurrenceGraph(serializeCooccurrenceGraph(graph));
    assert.equal(roundTrip.edgeCount, graph.edgeCount);
    assert.equal(
      scoreCooccurrenceCandidate(roundTrip, ['artist a::track a'], 'artist b::track b'),
      scoreCooccurrenceCandidate(graph, ['artist a::track a'], 'artist b::track b'),
    );

    const songs = [
      { songKey: 'artist a::track a', track: 'Track A', artist: 'Artist A', vector: [1, 0, 0, 0] },
      { songKey: 'artist b::track b', track: 'Track B', artist: 'Artist B', vector: [0, 1, 0, 0] },
      { songKey: 'artist c::skipped c', track: 'Skipped C', artist: 'Artist C', vector: [0.9, 0.1, 0, 0] },
      { songKey: 'artist d::soundalike d', track: 'Soundalike D', artist: 'Artist D', vector: [0.95, 0.05, 0, 0] },
    ];
    const recs = await buildUpNextRecommendations({
      currentSong: songs[0],
      librarySongs: songs,
      playbackEvents: events,
      limit: 2,
      collabGraph: roundTrip,
      collabWeight: 1.5,
    });
    assert.equal(recs[0].songKey, 'artist b::track b');
  });

  it('extracts targeted ZIP entries via central directory slice and merges sources cleanly', async () => {
    const zipBlob = createTestZipBlob({
      'Takeout/YouTube and YouTube Music/videos/big.mp4': 'ignore binary video payload',
      'Takeout/YouTube and YouTube Music/history/watch-history.html': '<html>ytm-ok</html>',
    });
    const matched = await extractMatchingZipEntries(zipBlob, name => name.endsWith('watch-history.html'));
    assert.equal(matched.size, 1);
    assert.equal(
      matched.get('Takeout/YouTube and YouTube Music/history/watch-history.html'),
      '<html>ytm-ok</html>',
    );

    const step1 = mergeExternalHistoryPack(null, {
      source: 'spotify',
      spotifyEvents: [{ songKey: 'a', eventType: 'playback-complete', createdAt: '2025-01-01T00:00:00Z' }],
      likedSongKeys: ['l1'],
      summary: { matchedStreams: 1 },
    });
    const step2 = mergeExternalHistoryPack(step1, {
      source: 'youtube-music',
      youtubeMusicEvents: [{ songKey: 'b', eventType: 'playback-complete', createdAt: '2026-11-01T00:00:00Z' }],
      likedSongKeys: ['l2'],
      summary: { matchedStreams: 1 },
    });
    assert.equal(step2.events.length, 2);
    assert.deepEqual(step2.likedSongKeys.sort(), ['l1', 'l2']);
    assert.equal(step2.sources.spotify.matchedStreams, 1);
    assert.equal(step2.sources.youtubeMusic.matchedStreams, 1);
  });
});
