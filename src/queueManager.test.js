import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeQueue,
  insertAfter,
  insertAtEnd,
  nextQueueIndex,
  previousQueueIndex,
  removeAt,
  reorderQueue,
  restoreQueueState,
  serializeQueueState,
} from './queueManager.js';

const songs = ['a', 'b', 'c'].map(songKey => ({ songKey }));

test('queue operations deduplicate, insert, remove, and reorder', () => {
  assert.deepEqual(dedupeQueue([songs[0], songs[1], songs[0]]).map(song => song.songKey), ['a', 'b']);
  assert.deepEqual(insertAfter(songs, 0, { songKey: 'd' }).map(song => song.songKey), ['a', 'd', 'b', 'c']);
  assert.deepEqual(insertAtEnd(songs, { songKey: 'd' }).map(song => song.songKey), ['a', 'b', 'c', 'd']);
  assert.deepEqual(removeAt(songs, 1).map(song => song.songKey), ['a', 'c']);
  assert.deepEqual(reorderQueue(songs, 0, 2).map(song => song.songKey), ['b', 'c', 'a']);
});

test('next and previous honor repeat-all and stop at boundaries when off', () => {
  assert.equal(nextQueueIndex({ length: 3, currentIndex: 2 }), -1);
  assert.equal(nextQueueIndex({ length: 3, currentIndex: 2, repeatMode: 'all' }), 0);
  assert.equal(nextQueueIndex({ length: 1, currentIndex: 0, repeatMode: 'all', avoidCurrent: true }), -1);
  assert.equal(previousQueueIndex({ length: 3, currentIndex: 0 }), 0);
  assert.equal(previousQueueIndex({ length: 3, currentIndex: 0, repeatMode: 'all' }), 2);
});

test('queue persistence restores a safe bounded state', () => {
  const restored = restoreQueueState(serializeQueueState({
    queue: songs,
    queueIndex: 99,
    repeatMode: 'all',
    positionSeconds: 12.5,
    isPlaying: true,
    djModeEnabled: true,
    djHistory: { candidateKeys: ['a', 'b'], timingBuckets: [15, 20] },
  }));
  assert.deepEqual(restored.queue.map(song => song.songKey), ['a', 'b', 'c']);
  assert.equal(restored.queueIndex, 2);
  assert.equal(restored.repeatMode, 'all');
  assert.equal(restored.positionSeconds, 12.5);
  assert.equal(restored.isPlaying, true);
  assert.equal(restored.djModeEnabled, true);
  assert.deepEqual(restored.djHistory, { candidateKeys: ['a', 'b'], timingBuckets: [15, 20] });
});


test('corrupt queue entries preserve the selected identity and discard transient audio in both orders', () => {
  const restored = restoreQueueState({ queue: [null, { songKey: 'a', blob: 'large' }, { songKey: 'a' }, { songKey: 'b' }],
    queueIndex: 3, originalQueue: [{ songKey: 'a', localFile: 'large' }, { songKey: 'missing' }],
    positionSeconds: 'bad', crossfadeSeconds: 100, volume: 5, repeatMode: 'invalid' });
  assert.equal(restored.queue[restored.queueIndex].songKey, 'b');
  assert.deepEqual(restored.originalQueue, [{ songKey: 'a' }]);
  assert.equal(restored.positionSeconds, 0); assert.equal(restored.volume, 1);
  assert.equal(restored.crossfadeSeconds, 12); assert.equal(restored.repeatMode, 'off');
  assert.equal(restoreQueueState('{oops'), null);
  assert.deepEqual(reorderQueue(songs, 0.5, 2), songs);
});

test('queue persistence safely restores manualQueue', () => {
  const serialized = serializeQueueState({
    queue: songs,
    queueIndex: 0,
    manualQueue: [songs[1], { songKey: 'external', track: 'External' }],
  });
  const restored = restoreQueueState(serialized);
  assert.equal(restored.manualQueue.length, 2);
  assert.equal(restored.manualQueue[0].songKey, 'b');
  assert.equal(restored.manualQueue[1].songKey, 'external');
});
