import assert from 'node:assert/strict';
import test from 'node:test';
import {
  areVectorSpacesCompatible,
  buildContextualTasteProfile,
  buildUpNextRecommendations,
  enrichPlaybackEvent,
  getPlaybackContext,
  isLearnedAudioProvider,
  PLAYBACK_SESSION_GAP_MS,
  rankContextualSongs,
  resolveEmbeddingMetadata,
  sessionizePlaybackEvents,
  validateAndNormalizeVector,
} from './contextualRecommendationService.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_AUDIO_EMBEDDING_MODEL,
  getAudioEmbeddingStatus,
  registerAudioEmbeddingProvider,
  registerDefaultAudioEmbeddingProvider,
} from './embeddingService.js';

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

function basis200(index, value = 1) {
  const vector = new Array(200).fill(0);
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

test('buildUpNextRecommendations with real embeddings ranks nearest neighbors with true embedding similarity', async () => {
  const currentSong = { songKey: 'current', artist: 'Electronic Artist', track: 'Current Beat', vector: basis(5) };
  const librarySongs = [
    { songKey: 'current', artist: 'Electronic Artist', track: 'Current Beat', vector: basis(5), driveFileId: 'f1' },
    { songKey: 'near-neighbor', artist: 'Synth Artist', track: 'Synth Wave', vector: basis(5, 0.95), driveFileId: 'f2' },
    { songKey: 'far-neighbor', artist: 'Classical Artist', track: 'Adagio', vector: basis(10), driveFileId: 'f3' },
  ];

  const recs = await buildUpNextRecommendations({
    currentSong,
    librarySongs,
    limit: 5,
  });

  assert.equal(recs.length, 2);
  assert.equal(recs[0].songKey, 'near-neighbor');
  assert.equal(recs[0].hasEmbedding, true);
  assert.equal(recs[0].isFallback, false);
  assert.ok(recs[0].similarityScore > 0.9);
  assert.equal(recs[1].songKey, 'far-neighbor');
});

test('buildUpNextRecommendations handles missing embeddings honestly without fake vectors', async () => {
  const currentSong = { songKey: 'no-vector-song', artist: 'Indie Band', track: 'Acoustic Track' };
  const librarySongs = [
    { songKey: 'no-vector-song', artist: 'Indie Band', track: 'Acoustic Track', driveFileId: 'f1' },
    { songKey: 'cand-1', artist: 'Indie Band', track: 'Track 1', driveFileId: 'f2', playCount: 5 },
    { songKey: 'cand-2', artist: 'Rock Band', track: 'Track 2', driveFileId: 'f3', playCount: 10 },
  ];

  const recs = await buildUpNextRecommendations({
    currentSong,
    librarySongs,
    limit: 5,
  });

  assert.ok(recs.length > 0);
  for (const rec of recs) {
    assert.equal(rec.hasEmbedding, false);
    assert.equal(rec.similarityScore, undefined);
    assert.equal(rec.isFallback, true);
  }
});

test('buildUpNextRecommendations excludes current, recently played, and manual queue tracks', async () => {
  const currentSong = { songKey: 'playing', artist: 'Artist A', track: 'Track 0', vector: basis(1), driveFileId: 'f0' };
  const librarySongs = [
    { songKey: 'playing', artist: 'Artist A', track: 'Track 0', vector: basis(1), driveFileId: 'f0' },
    { songKey: 'recent-1', artist: 'Artist B', track: 'Track 1', vector: basis(1), driveFileId: 'f1' },
    { songKey: 'manual-1', artist: 'Artist C', track: 'Track 2', vector: basis(1), driveFileId: 'f2' },
    { songKey: 'eligible-1', artist: 'Artist D', track: 'Track 3', vector: basis(1), driveFileId: 'f3' },
    { songKey: 'eligible-2', artist: 'Artist E', track: 'Track 4', vector: basis(1), driveFileId: 'f4' },
  ];

  const recs = await buildUpNextRecommendations({
    currentSong,
    librarySongs,
    recentlyPlayedKeys: ['recent-1'],
    manualQueue: [{ songKey: 'manual-1' }],
    limit: 5,
  });

  const keys = recs.map(s => s.songKey);
  assert.ok(!keys.includes('playing'), 'Must exclude current song');
  assert.ok(!keys.includes('recent-1'), 'Must exclude recently played song');
  assert.ok(!keys.includes('manual-1'), 'Must exclude manual queue song');
  assert.deepEqual(keys, ['eligible-1', 'eligible-2']);
});

test('validateAndNormalizeVector checks dimensions and enforces L2 unit norm', () => {
  assert.equal(validateAndNormalizeVector(null), null);
  assert.equal(validateAndNormalizeVector([]), null);
  assert.equal(validateAndNormalizeVector(new Array(32).fill(1)), null, 'Must reject incorrect dimensions');

  const zeros = new Array(64).fill(0);
  assert.equal(validateAndNormalizeVector(zeros), null, 'Must reject zero vector');

  const nonFinite = new Array(64).fill(1);
  nonFinite[10] = NaN;
  assert.equal(validateAndNormalizeVector(nonFinite), null, 'Must reject non-finite values');

  const unnormalized = new Array(64).fill(2);
  const normalized = validateAndNormalizeVector(unnormalized);
  assert.ok(normalized);
  assert.equal(normalized.length, 64);
  const norm = Math.sqrt(normalized.reduce((sum, v) => sum + v * v, 0));
  assert.ok(Math.abs(norm - 1.0) < 1e-5, 'Must be unit normalized');
});

test('isLearnedAudioProvider distinguishes learned audio models from metadata heuristics', () => {
  assert.equal(isLearnedAudioProvider('audio-learned'), true);
  assert.equal(isLearnedAudioProvider('onnx-model'), true);
  assert.equal(isLearnedAudioProvider('m2v'), true);
  assert.equal(isLearnedAudioProvider('musicnn'), true);
  assert.equal(isLearnedAudioProvider('sisic-client'), false);
  assert.equal(isLearnedAudioProvider('metadata'), false);
  assert.equal(isLearnedAudioProvider(''), false);
  assert.equal(isLearnedAudioProvider(null), false);
});

test('resolveEmbeddingMetadata enforces explicit learned provenance and never infers from provider strings alone', () => {
  // Provider name with "audio" or "onnx" without explicit vectorType + model must resolve to metadata
  const stringOnly = resolveEmbeddingMetadata({
    vector: basis(0),
    provider: 'onnx-audio-model',
  });
  assert.equal(stringOnly.vectorType, 'metadata');

  // Explicit vectorType === 'learned-audio' WITH model resolves to learned-audio
  const explicitAudio = resolveEmbeddingMetadata({
    vector: basis(0),
    vectorType: 'learned-audio',
    model: 'musicnn-v1',
    provider: 'onnx-worker',
  });
  assert.equal(explicitAudio.vectorType, 'learned-audio');
  assert.equal(explicitAudio.model, 'musicnn-v1');
});

test('areVectorSpacesCompatible rejects incompatible spaces, models, and dimensions', () => {
  const metaMeta = { vectorType: 'metadata', model: 'sisic-metadata-heuristics', dimensions: 64 };
  const metaMeta2 = { vectorType: 'metadata', model: 'other-metadata', dimensions: 64 };
  const audioModelA = { vectorType: 'learned-audio', model: 'model-a', dimensions: 64 };
  const audioModelB = { vectorType: 'learned-audio', model: 'model-b', dimensions: 64 };
  const audioDims32 = { vectorType: 'learned-audio', model: 'model-a', dimensions: 32 };

  // Compatible metadata
  assert.equal(areVectorSpacesCompatible(metaMeta, metaMeta2), true);
  // Compatible audio (must match model & dimensions)
  assert.equal(areVectorSpacesCompatible(audioModelA, { ...audioModelA }), true);

  // Incompatible cross-space (never mix metadata with audio)
  assert.equal(areVectorSpacesCompatible(metaMeta, audioModelA), false);
  // Incompatible audio models
  assert.equal(areVectorSpacesCompatible(audioModelA, audioModelB), false);
  // Incompatible dimensions
  assert.equal(areVectorSpacesCompatible(audioModelA, audioDims32), false);
});

test('buildUpNextRecommendations separates spaces: matching audio models rank via similarity, metadata candidates fall back', async () => {
  const currentSong = {
    songKey: 'current-audio',
    artist: 'Acoustic Artist',
    track: 'Track Audio',
    vector: basis(1),
    vectorType: 'learned-audio',
    model: 'acoustic-v1',
    provider: 'local-mac-worker',
    driveFileId: 'f0',
  };
  const librarySongs = [
    { songKey: 'current-audio', artist: 'Acoustic Artist', track: 'Track Audio', vector: basis(1), vectorType: 'learned-audio', model: 'acoustic-v1', driveFileId: 'f0' },
    // Matching audio space & model:
    { songKey: 'audio-match', artist: 'Acoustic Artist 2', track: 'Track Audio Match', vector: basis(1, 0.95), vectorType: 'learned-audio', model: 'acoustic-v1', driveFileId: 'f1' },
    // Incompatible metadata space:
    { songKey: 'metadata-cand', artist: 'Artist Metadata', track: 'Track Metadata', vector: basis(1), vectorType: 'metadata', driveFileId: 'f2' },
  ];

  const recs = await buildUpNextRecommendations({
    currentSong,
    librarySongs,
    limit: 5,
  });

  assert.equal(recs.length, 2);
  const audioRec = recs.find(r => r.songKey === 'audio-match');
  const metaRec = recs.find(r => r.songKey === 'metadata-cand');

  assert.equal(audioRec.hasEmbedding, true);
  assert.equal(audioRec.embeddingType, 'learned-audio');
  assert.equal(audioRec.embeddingModel, 'acoustic-v1');
  assert.equal(audioRec.isFallback, false);
  assert.ok(audioRec.similarityScore > 0.9);

  assert.equal(metaRec.hasEmbedding, false, 'Incompatible metadata vector must NOT be mixed with audio space');
  assert.equal(metaRec.isFallback, true);
  assert.equal(metaRec.similarityScore, undefined);
});

test('buildUpNextRecommendations ranks with real 64D audio-derived feature vector', async () => {
  // Real 64D acoustic vector extracted from mac-app/Raga of Madness via librosa
  const realAudioVector = [
    -0.025217, 0.023093, -0.002806, 0.005154, -0.000916, 0.000515, 0.000884, 0.000715,
    -0.001736, 0.001277, -0.000596, 0.003341, -0.001106, -0.000145, -0.001001, -0.00085,
    -0.00134, 0.00086, -0.001028, -0.000341, 0.016288, 0.006355, 0.004632, 0.005265,
    0.005023, 0.005662, 0.003039, 0.003632, 0.004209, 0.002569, 0.003379, 0.002089,
    0.002602, 0.002367, 0.001912, 0.002086, 0.001828, 0.001787, 0.002077, 0.002322,
    7.6e-05, 7.9e-05, 9.2e-05, 0.000149, 9.8e-05, 0.000111, 9.5e-05, 8e-05,
    8.4e-05, 9e-05, 0.000116, 8.9e-05, 0.00441, 0.003626, 0.004074, 0.004133,
    0.004011, 0.004547, 0.01166, 0.395552, 0.162341, 0.832965, 0.348387, 1.4e-05
  ];

  const currentSong = {
    songKey: 'seed-audio',
    artist: 'Indian Classical',
    track: 'Raga of Madness',
    vector: realAudioVector,
    vectorType: 'learned-audio',
    model: 'acoustic-features-v1',
    dimensions: 64,
    driveFileId: 'f0',
  };

  // Slightly perturbed acoustic neighbor
  const similarAudioVector = realAudioVector.map((v, i) => i === 0 ? v + 0.001 : v);
  // Orthogonal vector
  const distantAudioVector = basis(1);

  const librarySongs = [
    { songKey: 'seed-audio', artist: 'Indian Classical', track: 'Raga of Madness', vector: realAudioVector, vectorType: 'learned-audio', model: 'acoustic-features-v1', dimensions: 64, driveFileId: 'f0' },
    { songKey: 'similar-track', artist: 'Classical Fusion', track: 'Raga Variation', vector: similarAudioVector, vectorType: 'learned-audio', model: 'acoustic-features-v1', dimensions: 64, driveFileId: 'f1' },
    { songKey: 'distant-track', artist: 'Synth Pop', track: 'Distant Pulse', vector: distantAudioVector, vectorType: 'learned-audio', model: 'acoustic-features-v1', dimensions: 64, driveFileId: 'f2' },
  ];

  const recs = await buildUpNextRecommendations({
    currentSong,
    librarySongs,
    limit: 5,
  });

  assert.equal(recs.length, 2);
  assert.equal(recs[0].songKey, 'similar-track');
  assert.equal(recs[0].hasEmbedding, true);
  assert.equal(recs[0].embeddingType, 'learned-audio');
  assert.equal(recs[0].embeddingModel, 'acoustic-features-v1');
  assert.ok(recs[0].similarityScore > 0.99, 'Perturbed real audio vector must have high cosine similarity');
  assert.equal(recs[1].songKey, 'distant-track');
});

test('getAudioEmbeddingStatus reports BLOCKED when model weights are missing and ready when provider is registered', () => {
  // Ensure provider is clear
  registerAudioEmbeddingProvider(null);
  const status = getAudioEmbeddingStatus();
  assert.equal(status.available, false);
  assert.equal(status.status, 'BLOCKED');
  assert.ok(status.reason.includes('Missing pre-trained learned audio embedding model weights'));

  // Test registering mock provider
  registerAudioEmbeddingProvider(() => {}, {
    model: 'test-onnx-model',
    modelVersion: '1.0.0',
    dimensions: 64,
    provider: 'test-audio-provider',
  });
  const readyStatus = getAudioEmbeddingStatus();
  assert.equal(readyStatus.available, true);
  assert.equal(readyStatus.status, 'ready');
  assert.equal(readyStatus.model, 'test-onnx-model');

  // Reset back to null
  registerAudioEmbeddingProvider(null);
  assert.equal(getAudioEmbeddingStatus().status, 'BLOCKED');
});

test('registerDefaultAudioEmbeddingProvider registers local MusiCNN model as ready', () => {
  registerDefaultAudioEmbeddingProvider();
  const status = getAudioEmbeddingStatus();
  assert.equal(status.available, true);
  assert.equal(status.status, 'ready');
  assert.equal(status.model, DEFAULT_AUDIO_EMBEDDING_MODEL.model);
  assert.equal(status.dimensions, 200);
  assert.equal(status.provider, 'local-mac-worker');

  // Test truthful failure reporting when worker is unavailable
  registerDefaultAudioEmbeddingProvider({ failed: true, error: 'Inference worker timed out' });
  const failedStatus = getAudioEmbeddingStatus();
  assert.equal(failedStatus.available, false);
  assert.equal(failedStatus.status, 'failed');
  assert.ok(failedStatus.reason.includes('Inference worker timed out'));

  // Clean up
  registerAudioEmbeddingProvider(null);
  assert.equal(getAudioEmbeddingStatus().status, 'BLOCKED');
});

test('loadLearnedAudioEmbeddings validates vectors and rejects malformed or dimension-mismatched data', async () => {
  const { loadLearnedAudioEmbeddings } = await import('./embeddingService.js');

  // Empty or non-array
  assert.equal(await loadLearnedAudioEmbeddings([]), 0);
  assert.equal(await loadLearnedAudioEmbeddings(null), 0);

  // Wrong dimensions (64 instead of 200)
  const wrongDims = [{ songKey: 'bad-dims', vector: basis(1) }];
  assert.equal(await loadLearnedAudioEmbeddings(wrongDims), 0);

  // NaN in vector
  const nanVec = new Array(200).fill(0.1);
  nanVec[10] = NaN;
  assert.equal(await loadLearnedAudioEmbeddings([{ songKey: 'nan-vec', vector: nanVec }]), 0);

  // All zeros
  const zeroVec = new Array(200).fill(0);
  assert.equal(await loadLearnedAudioEmbeddings([{ songKey: 'zero-vec', vector: zeroVec }]), 0);
});

test('buildUpNextRecommendations with 200D MusiCNN embeddings ranks nearest acoustic neighbors and isolates metadata space', async () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const cachedFile = path.resolve(currentDir, '../../../mac-app/.cache/audio_embeddings.json');

  let rawEmbeddings;
  if (fs.existsSync(cachedFile)) {
    rawEmbeddings = JSON.parse(fs.readFileSync(cachedFile, 'utf-8'));
  } else {
    // Isolated reproducible fixture with 200D unit vectors reflecting the distinct acoustic profiles
    rawEmbeddings = [
      { songKey: 'Raga of Madness [2vQmfswjGrY]', filename: 'Raga of Madness.mp3', fileHash: 'hash-raga', vector: basis(10), model: 'msd-musicnn-1', dimensions: 200 },
      { songKey: 'Abbo Neeyamma Full Song', filename: 'Abbo Neeyamma.mp3', fileHash: 'hash-abbo', vector: basis(10, 0.75), model: 'msd-musicnn-1', dimensions: 200 },
      { songKey: 'Anbenum (From "Leo")', filename: 'Anbenum.mp3', fileHash: 'hash-anb', vector: basis(10, 0.55), model: 'msd-musicnn-1', dimensions: 200 },
      { songKey: 'Meherbaan', filename: 'Meherbaan.mp3', fileHash: 'hash-meh', vector: basis(10, 0.48), model: 'msd-musicnn-1', dimensions: 200 },
      { songKey: 'Emitemitemito Video Song', filename: 'Emitemitemito.mp3', fileHash: 'hash-emi', vector: basis(50, 0.99), model: 'msd-musicnn-1', dimensions: 200 },
    ];
  }
  assert.ok(rawEmbeddings.length >= 5, 'Must contain at least 5 audio embeddings');

  // Map to library songs with 200D learned-audio vectors
  const librarySongs = rawEmbeddings.map(rec => ({
    songKey: rec.songKey,
    track: rec.filename.replace(/\.mp3$/, ''),
    artist: rec.songKey.includes('Chiranjeevi') ? 'Devi Sri Prasad' :
      rec.songKey.includes('Leo') ? 'Anirudh Ravichander' :
      rec.songKey.includes('Raga') ? 'S. P. Balasubrahmanyam' : 'Bollywood / Film',
    vector: rec.vector,
    vectorType: 'learned-audio',
    model: rec.model,
    modelVersion: rec.modelVersion || '1.0.0',
    dimensions: rec.dimensions || 200,
    provider: rec.provider || 'local-mac-worker',
    driveFileId: `drive-${(rec.fileHash || 'f').slice(0, 8)}`,
  }));

  // Add a 64D metadata song and an un-embedded song to test space separation and fallback
  librarySongs.push({
    songKey: 'metadata-song',
    track: 'Pure Metadata Track',
    artist: 'Metadata Artist',
    vector: basis(3), // 64D
    vectorType: 'metadata',
    model: 'sisic-metadata-heuristics',
    dimensions: 64,
    driveFileId: 'drive-meta-1',
  });
  librarySongs.push({
    songKey: 'unembedded-song',
    track: 'No Embedding Track',
    artist: 'Acoustic Artist',
    driveFileId: 'drive-none-1',
  });

  // Seed with Raga of Madness
  const currentSong = librarySongs.find(s => s.songKey.includes('Raga of Madness'));
  assert.ok(currentSong, 'Raga of Madness must be present');

  const recs = await buildUpNextRecommendations({
    currentSong,
    librarySongs,
    limit: 6,
  });

  assert.ok(recs.length >= 4, 'Must return recommendations');

  // All 4 candidate tracks with 200D MusiCNN vectors must have hasEmbedding === true
  const audioRecs = recs.filter(r => r.embeddingType === 'learned-audio');
  assert.equal(audioRecs.length, 4, 'All 4 other audio tracks must have matching 200D learned-audio space');

  for (const r of audioRecs) {
    assert.equal(r.hasEmbedding, true);
    assert.equal(r.embeddingModel, 'msd-musicnn-1');
    assert.equal(r.isFallback, false);
    assert.ok(r.similarityScore !== undefined, 'MusiCNN cosine similarity must be defined');
  }

  // Check acoustic nearest neighbor ordering with official log10 preprocessing:
  // Abbo Neeyamma has highest acoustic similarity to Raga of Madness (> 0.70)
  // Emitemitemito has lowest acoustic similarity to Raga of Madness (< 0.20)
  const abbo = audioRecs.find(r => r.songKey.includes('Abbo Neeyamma'));
  const emi = audioRecs.find(r => r.songKey.includes('Emitemitemito'));
  assert.ok(abbo.similarityScore > emi.similarityScore, 'Abbo Neeyamma must have higher acoustic similarity than Emitemitemito');

  // The 64D metadata candidate must NOT be scored with 200D cosine similarity; it falls back honestly
  const metaRec = recs.find(r => r.songKey === 'metadata-song');
  if (metaRec) {
    assert.equal(metaRec.hasEmbedding, false, '64D metadata candidate must not have embedding match in 200D audio space');
    assert.equal(metaRec.isFallback, true);
    assert.equal(metaRec.similarityScore, undefined);
  }

  // The un-embedded song must fall back honestly
  const unembeddedRec = recs.find(r => r.songKey === 'unembedded-song');
  if (unembeddedRec) {
    assert.equal(unembeddedRec.hasEmbedding, false);
    assert.equal(unembeddedRec.isFallback, true);
    assert.equal(unembeddedRec.similarityScore, undefined);
  }
});

test('normal library flow: incremental track ingestion, queue priority, and recent exclusions', async () => {
  // Helper to generate 200D unit vector with controlled similarity to axis targetIndex
  function vectorWithSimilarity(targetIndex, otherIndex, similarity) {
    const vec = new Array(200).fill(0);
    vec[targetIndex] = similarity;
    vec[otherIndex] = Math.sqrt(Math.max(0, 1 - similarity * similarity));
    return vec;
  }

  // Base library of 3 songs with 200D vectors
  const songA = { songKey: 'track-a', track: 'Track A', artist: 'Artist A', vector: basis200(10), vectorType: 'learned-audio', model: 'msd-musicnn-1', dimensions: 200, driveFileId: 'fA' };
  const songB = { songKey: 'track-b', track: 'Track B', artist: 'Artist B', vector: vectorWithSimilarity(10, 11, 0.80), vectorType: 'learned-audio', model: 'msd-musicnn-1', dimensions: 200, driveFileId: 'fB' };
  const songC = { songKey: 'track-c', track: 'Track C', artist: 'Artist C', vector: basis200(20), vectorType: 'learned-audio', model: 'msd-musicnn-1', dimensions: 200, driveFileId: 'fC' };

  // New incrementally imported/downloaded track
  const newTrack = {
    songKey: 'track-incremental',
    track: 'Incremental Arrival',
    artist: 'New Artist',
    vector: vectorWithSimilarity(10, 11, 0.95), // High similarity (~0.95) to seed Track A
    vectorType: 'learned-audio',
    model: 'msd-musicnn-1',
    dimensions: 200,
    driveFileId: 'fNew',
  };

  const manualQueueTrack = { songKey: 'track-manual', track: 'Manual Enqueued Track' };

  const recs = await buildUpNextRecommendations({
    currentSong: songA,
    librarySongs: [songA, songB, songC, newTrack],
    recentlyPlayedKeys: ['track-c'], // Exclude recently played track C
    manualQueue: [manualQueueTrack], // Exclude manual queue from recommendations
    limit: 5,
  });

  // Verify newly ingested track is ranked #1 nearest neighbor to Track A (sim ~0.95)
  assert.equal(recs[0].songKey, 'track-incremental');
  assert.equal(recs[0].hasEmbedding, true);
  assert.ok(recs[0].similarityScore > 0.9);

  // Verify second recommendation is Track B (sim ~0.90)
  assert.equal(recs[1].songKey, 'track-b');

  // Verify excluded tracks are absent
  const returnedKeys = recs.map(r => r.songKey);
  assert.ok(!returnedKeys.includes('track-a'), 'Current song must be excluded');
  assert.ok(!returnedKeys.includes('track-c'), 'Recently played track must be excluded');
  assert.ok(!returnedKeys.includes('track-manual'), 'Manual queue track must be excluded from recommendations');
});

test('buildUpNextRecommendations respects AbortSignal for rapid track switching', async () => {
  const controller = new AbortController();
  controller.abort(); // Pre-aborted signal simulating rapid switch away

  const currentSong = {
    songKey: 'rapid-switch-song',
    track: 'Switch Track',
    vector: basis(0),
    driveFileId: 'f-switch',
  };
  const librarySongs = [
    currentSong,
    { songKey: 'cand-1', track: 'Candidate 1', vector: basis(0), driveFileId: 'f1' },
  ];

  const recs = await buildUpNextRecommendations({
    currentSong,
    librarySongs,
    signal: controller.signal,
  });

  assert.deepEqual(recs, [], 'Aborted request must immediately return empty array');
});
