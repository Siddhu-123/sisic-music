import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildContextualTasteProfile,
  enrichPlaybackEvent,
  getPlaybackContext,
  PLAYBACK_SESSION_GAP_MS,
  rankContextualSongs,
  sessionizePlaybackEvents,
} from './contextualRecommendationService.js';

const baseTime = Date.parse('2026-08-01T10:00:00.000Z');

function playbackEvent(songKey, eventType, offsetMs, extra = {}) {
  return {
    id: `${songKey}-${eventType}-${offsetMs}`,
    songKey,
    eventType,
    createdAt: new Date(baseTime + offsetMs).toISOString(),
    positionSeconds: 0,
    durationSeconds: 200,
    ...extra,
  };
}

function basis(index, value = 1) {
  const vector = new Array(64).fill(0);
  vector[index] = value;
  return vector;
}

test('playback context captures time and coarse device context', () => {
  const date = new Date(2026, 0, 1, 9, 30);
  assert.deepEqual(getPlaybackContext(date, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), {
    weekday: date.getDay(),
    hour: 9,
    timeBucket: 'morning',
    deviceType: 'mobile',
    sourceSurface: 'player',
  });
});

test('event enrichment assigns stable sessions and records skip reasons', () => {
  const state = {};
  const first = enrichPlaybackEvent(playbackEvent('a', 'playback-start', 0), state, { userAgent: 'Mozilla/5.0' });
  const sameSession = enrichPlaybackEvent(playbackEvent('b', 'playback-start', 10 * 60 * 1000), state, { userAgent: 'Mozilla/5.0' });
  const nextSession = enrichPlaybackEvent(playbackEvent('c', 'user-skip', 2 * PLAYBACK_SESSION_GAP_MS + 1), state, { userAgent: 'Mozilla/5.0' });

  assert.equal(first.sessionId, sameSession.sessionId);
  assert.notEqual(first.sessionId, nextSession.sessionId);
  assert.equal(nextSession.skipReason, 'user-skip');
  assert.equal(first.context.deviceType, 'desktop');
  assert.equal(first.sourceSurface, 'player');
});

test('sessionization separates inactivity and classifies played versus skipped tracks', () => {
  const sessions = sessionizePlaybackEvents([
    playbackEvent('a', 'playback-start', 0),
    playbackEvent('a', 'user-skip', 30 * 1000, { positionSeconds: 12 }),
    playbackEvent('b', 'playback-start', 60 * 1000),
    playbackEvent('b', 'playback-complete', 180 * 1000, { positionSeconds: 200 }),
    playbackEvent('c', 'playback-start', 2 * PLAYBACK_SESSION_GAP_MS + 1000),
  ]);

  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].tracks.find(track => track.songKey === 'a').status, 'skipped');
  assert.equal(sessions[0].tracks.find(track => track.songKey === 'b').status, 'played');
  assert.deepEqual(sessions[1].trackKeys, ['c']);
});

test('contextual profile keeps played and skipped vectors separate', () => {
  const songs = [
    { songKey: 'a', artist: 'Artist A', track: 'Played', vector: basis(0) },
    { songKey: 'b', artist: 'Artist B', track: 'Skipped', vector: basis(1) },
  ];
  const profile = buildContextualTasteProfile(songs, [
    playbackEvent('a', 'playback-start', 0),
    playbackEvent('a', 'playback-complete', 180 * 1000, { positionSeconds: 200 }),
    playbackEvent('b', 'playback-start', 200 * 1000),
    playbackEvent('b', 'user-skip', 220 * 1000, { positionSeconds: 8 }),
  ], { now: baseTime + 10 * 60 * 1000 });

  assert.equal(profile.sessionCount, 1);
  assert.equal(profile.positiveSignalCount, 1);
  assert.equal(profile.negativeSignalCount, 1);
  assert.ok(profile.vector[0] > 0.99);
  assert.ok(profile.negativeVector[1] > 0.99);
});

test('contextual ranking penalizes skipped and recently played songs while diversifying artists', () => {
  const songs = [
    { songKey: 'a', artist: 'Artist A', track: 'Played', vector: basis(0) },
    { songKey: 'b', artist: 'Artist B', track: 'Skipped', vector: basis(1) },
    { songKey: 'c', artist: 'Artist C', track: 'Neutral', vector: basis(2) },
    { songKey: 'd', artist: 'Artist A', track: 'Second A', vector: basis(0, 0.99) },
  ];
  const profile = buildContextualTasteProfile(songs, [
    playbackEvent('a', 'playback-start', 0),
    playbackEvent('a', 'playback-complete', 180 * 1000, { positionSeconds: 200 }),
    playbackEvent('b', 'playback-start', 200 * 1000),
    playbackEvent('b', 'user-skip', 220 * 1000, { positionSeconds: 8 }),
  ], { now: baseTime + 10 * 60 * 1000 });
  const ranked = rankContextualSongs(songs, { profile, now: baseTime + 10 * 60 * 1000, limit: 4 });

  assert.ok(ranked.findIndex(song => song.songKey === 'b') > ranked.findIndex(song => song.songKey === 'c'));
  assert.equal(ranked[0].songKey, 'd');
  assert.ok(ranked.findIndex(song => song.songKey === 'a') > 0);
});
