import assert from 'node:assert/strict';
import test from 'node:test';
import { computeDevilMix } from './devilMixClient.js';
import { buildDevilMix } from './mixEngine.js';

function fixture() {
  const songs = [];
  const gemmaVectors = new Map();
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let cluster = 0; cluster < axes.length; cluster++) for (let i = 0; i < 8; i++) {
    const songKey = `c${cluster}-${i}`;
    const vector = axes[cluster];
    songs.push({ songKey, artist: `Artist ${cluster}`, bpm: 100 + cluster, key: `${cluster + 1}A`, energy: cluster / 2 });
    gemmaVectors.set(songKey, { vector, startVector: vector, endVector: vector });
  }
  return { songs, gemmaVectors, events: [] };
}

test('falls back to buildDevilMix when workers are unavailable', async () => {
  const context = fixture();
  const expected = buildDevilMix(context);
  const result = await computeDevilMix(context);
  assert.deepEqual(result.map(song => song.songKey), expected.map(song => song.songKey));
});

test('maps worker song keys to songs and falls back on an error reply', async () => {
  const context = fixture();
  const expected = buildDevilMix(context);
  let repliesWithError = false;
  const createWorker = () => ({
    postMessage(message) {
      queueMicrotask(() => {
        this.onmessage({ data: repliesWithError
          ? { requestId: message.requestId, error: 'worker failed' }
          : { requestId: message.requestId, songKeys: [...message.songs].reverse().map(song => song.songKey) } });
      });
    },
    terminate() {},
  });

  const reversed = await computeDevilMix(context, { createWorker });
  assert.deepEqual(reversed, [...context.songs].reverse());
  assert.strictEqual(reversed[0], context.songs.at(-1));

  repliesWithError = true;
  const fallback = await computeDevilMix(context, { createWorker });
  assert.deepEqual(fallback.map(song => song.songKey), expected.map(song => song.songKey));
});
