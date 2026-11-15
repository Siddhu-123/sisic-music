import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeAffinities, outcomeWeight, buildSkipTrainingRows } from './behaviourLearning.js';
import { fitAndEvaluatePersonalRanker } from './personalRanker.js';
import {
  buildSpotifyLibraryIndex,
  classifySpotifyOutcome,
  convertSpotifyStreamsToPlaybackEvents,
  matchSpotifyRecord,
  SPOTIFY_SESSION_GAP_MS,
} from './spotifyHistory.js';

const LIBRARY = [
  {
    songKey: 'anirudh ravichander::naa ready',
    track: 'Naa Ready',
    artist: 'Anirudh Ravichander',
    album: 'Leo',
    durationSeconds: 248,
  },
  {
    songKey: 'd imman sid sriram::kannana kanne from viswasam',
    track: 'Kannana Kanne (From "Viswasam")',
    artist: 'D. Imman, Sid Sriram',
    album: 'Viswasam (Original Motion Picture Soundtrack)',
    durationSeconds: 268,
  },
  {
    songKey: 'sid sriram::samajavaragamana lofi mix',
    track: 'Samajavaragamana (Lofi Mix)',
    artist: 'Sid Sriram',
    album: 'Lofi Telugu',
    durationSeconds: 185,
  },
];

describe('spotifyHistory', () => {
  it('matches exact tracks and multi-artist soundtrack credits cleanly', () => {
    const index = buildSpotifyLibraryIndex(LIBRARY);

    const exact = matchSpotifyRecord({
      master_metadata_track_name: 'Naa Ready',
      master_metadata_album_artist_name: 'Anirudh Ravichander',
    }, index);
    assert.equal(exact?.songKey, 'anirudh ravichander::naa ready');
    assert.equal(exact?.matchTier, 'exactKey');

    const coArtist = matchSpotifyRecord({
      master_metadata_track_name: 'Kannana Kanne',
      master_metadata_album_artist_name: 'Sid Sriram',
      master_metadata_album_album_name: 'Viswasam',
    }, index);
    assert.equal(coArtist?.songKey, 'd imman sid sriram::kannana kanne from viswasam');
    assert.equal(coArtist?.matchTier, 'artistTokenTrack');
  });

  it('does not collide studio tracks against lofi, slowed, live, or remix variants', () => {
    const index = buildSpotifyLibraryIndex(LIBRARY);

    const studioQueryAgainstLofiOnly = matchSpotifyRecord({
      master_metadata_track_name: 'Samajavaragamana',
      master_metadata_album_artist_name: 'Sid Sriram',
    }, index);
    assert.equal(studioQueryAgainstLofiOnly, null);

    const exactVariant = matchSpotifyRecord({
      master_metadata_track_name: 'Samajavaragamana (Lofi Mix)',
      master_metadata_album_artist_name: 'Sid Sriram',
    }, index);
    assert.equal(exactVariant?.songKey, 'sid sriram::samajavaragamana lofi mix');
  });

  it('classifies completions, explicit skips, partials, and non-skip quick stops', () => {
    assert.equal(classifySpotifyOutcome({
      ms_played: 180000,
      reason_end: 'trackdone',
      skipped: false,
    }, 248).outcome, 'complete');

    const skip = classifySpotifyOutcome({
      ms_played: 4500,
      reason_end: 'fwdbtn',
      skipped: true,
    }, 248);
    assert.equal(skip.outcome, 'skip');
    assert.equal(skip.positionSeconds, 4.5);

    assert.equal(classifySpotifyOutcome({
      ms_played: 45000,
      reason_end: 'endplay',
      skipped: false,
    }, 248).outcome, 'partial');

    assert.equal(classifySpotifyOutcome({
      ms_played: 5000,
      reason_end: 'logout',
      skipped: false,
    }, 248).outcome, 'ignore');
  });

  it('converts Spotify records into session-grouped playbackEvents compatible with ranker signals', () => {
    const t0 = Date.parse('2025-10-01T10:00:00Z');
    const records = [
      {
        ts: new Date(t0 + SPOTIFY_SESSION_GAP_MS + 500_000).toISOString(),
        ms_played: 4000,
        master_metadata_track_name: 'Samajavaragamana (Lofi Mix)',
        master_metadata_album_artist_name: 'Sid Sriram',
        reason_start: 'trackdone',
        reason_end: 'fwdbtn',
        skipped: true,
      },
      {
        ts: new Date(t0).toISOString(),
        ms_played: 248000,
        master_metadata_track_name: 'Naa Ready',
        master_metadata_album_artist_name: 'Anirudh Ravichander',
        reason_start: 'clickrow',
        reason_end: 'trackdone',
        skipped: false,
      },
      {
        ts: new Date(t0 + 250_000).toISOString(),
        ms_played: 200000,
        master_metadata_track_name: 'Kannana Kanne',
        master_metadata_album_artist_name: 'Sid Sriram',
        reason_start: 'trackdone',
        reason_end: 'trackdone',
        skipped: false,
      },
    ];

    const { events, stats } = convertSpotifyStreamsToPlaybackEvents(records, LIBRARY);
    assert.deepEqual(stats, {
      totalRecords: 3,
      matchedStreams: 3,
      exactMatches: 2,
      artistTokenMatches: 1,
      uniqueMatchedSongs: 3,
      completes: 2,
      skips: 1,
      partials: 0,
      sessions: 2,
    });

    assert.deepEqual(
      events.map(e => `${e.queueId}:${e.positionInQueue}:${e.eventType}`),
      [
        'spotify-s1:0:playback-start',
        'spotify-s1:0:playback-complete',
        'spotify-s1:1:playback-start',
        'spotify-s1:1:playback-complete',
        'spotify-s2:0:playback-start',
        'spotify-s2:0:user-skip',
      ],
    );

    assert.equal(outcomeWeight(events[1]), 0.5);
    assert.equal(outcomeWeight(events[5]), -1.0);

    const affinities = computeAffinities(events, { now: new Date(t0 + SPOTIFY_SESSION_GAP_MS + 600_000) });
    assert.ok((affinities.get('anirudh ravichander::naa ready')?.score || 0) > 0);
    assert.equal(affinities.get('sid sriram::samajavaragamana lofi mix')?.skips, 1);

    const skipRows = buildSkipTrainingRows(events, { affinities });
    assert.deepEqual(skipRows.map(r => r.label), [0, 0, 1]);
  });

  it('bounds fitAndEvaluatePersonalRanker to recent maxSessions while preserving full eventCount', () => {
    const t0 = Date.parse('2026-01-01T10:00:00Z');
    const records = [];
    for (let s = 0; s < 10; s++) {
      const base = t0 + s * (SPOTIFY_SESSION_GAP_MS + 600_000);
      records.push(
        {
          ts: new Date(base).toISOString(),
          ms_played: 248000,
          master_metadata_track_name: 'Naa Ready',
          master_metadata_album_artist_name: 'Anirudh Ravichander',
          reason_end: 'trackdone',
          skipped: false,
        },
        {
          ts: new Date(base + 250_000).toISOString(),
          ms_played: 200000,
          master_metadata_track_name: 'Kannana Kanne',
          master_metadata_album_artist_name: 'Sid Sriram',
          reason_end: 'trackdone',
          skipped: false,
        },
        {
          ts: new Date(base + 460_000).toISOString(),
          ms_played: 4000,
          master_metadata_track_name: 'Samajavaragamana (Lofi Mix)',
          master_metadata_album_artist_name: 'Sid Sriram',
          reason_end: 'fwdbtn',
          skipped: true,
        },
      );
    }
    const { events } = convertSpotifyStreamsToPlaybackEvents(records, LIBRARY);
    const bounded = fitAndEvaluatePersonalRanker({
      songs: LIBRARY,
      playbackEvents: events,
      now: t0 + 12 * (SPOTIFY_SESSION_GAP_MS + 600_000),
      maxSessions: 4,
      minTrainPairs: 1,
      minHoldoutOutcomes: 1,
    });
    assert.equal(bounded.eventCount, events.length);
    assert.equal(bounded.evalReport.trainEvents + bounded.evalReport.evalEvents, 24);
  });
});
