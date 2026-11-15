import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMediaMetadataInit,
  computeMediaPositionState,
  registerMediaSessionActions,
  syncMediaSessionState,
} from './playbackMediaSession.js';

function fakeSession() {
  const handlers = new Map();
  const calls = [];
  return {
    metadata: null,
    playbackState: 'none',
    positionUpdates: [],
    handlers,
    calls,
    setActionHandler(name, fn) {
      calls.push([name, Boolean(fn)]);
      handlers.set(name, fn);
    },
    setPositionState(state) {
      this.positionUpdates.push(state);
    },
  };
}

test('registerMediaSessionActions binds lock-screen controls without dropping unsupported actions', () => {
  const session = fakeSession();
  const baseSetActionHandler = session.setActionHandler.bind(session);
  session.setActionHandler = (name, fn) => {
    if (name === 'seekto') throw new TypeError('unsupported');
    baseSetActionHandler(name, fn);
  };
  const invoked = [];
  const controller = {
    audio: { duration: 200, currentTime: 50 },
    play: () => invoked.push('play'),
    pause: () => invoked.push('pause'),
    stop: () => invoked.push('stop'),
    playPrev: () => invoked.push('prev'),
    playNext: opts => invoked.push(['next', opts.reason]),
    seek: pct => invoked.push(['seek', pct]),
  };

  const cleanup = registerMediaSessionActions(session, controller);
  assert.equal(typeof session.handlers.get('play'), 'function');
  assert.equal(typeof session.handlers.get('pause'), 'function');
  session.handlers.get('play')();
  session.handlers.get('nexttrack')();
  session.handlers.get('seekforward')({ seekOffset: 10 });
  assert.deepEqual(invoked, ['play', ['next', 'user-media-session'], ['seek', 30]]);

  cleanup();
  assert.equal(session.handlers.get('play'), null);
  assert.equal(session.playbackState, 'none');
  assert.equal(session.metadata, null);
});

test('syncMediaSessionState keeps playbackState playing during transitions and clamps position', () => {
  const session = fakeSession();
  syncMediaSessionState(session, {
    currentSong: { songKey: 'a', track: 'Song A' },
    isPlaying: false,
    isPlayRequested: true,
    duration: 120,
    progress: 110,
    rpm: 33.33,
    pitchModifier: 1,
  });
  assert.equal(session.playbackState, 'playing');
  const lastPosition = session.positionUpdates.at(-1);
  assert.equal(lastPosition.duration, 120);
  assert.equal(lastPosition.position, 120);
  assert.ok(lastPosition.playbackRate > 0.7 && lastPosition.playbackRate < 0.8);

  syncMediaSessionState(session, { currentSong: null, isPlaying: false, isPlayRequested: false });
  assert.equal(session.playbackState, 'none');
  assert.equal(session.positionUpdates.at(-1), undefined);
  assert.equal(computeMediaPositionState({ duration: 0, progress: 50 }), undefined);
  assert.deepEqual(buildMediaMetadataInit({ track: 'T', artist: 'A' }), {
    title: 'T',
    artist: 'A',
    album: 'Sisic Music',
    artwork: [],
  });
});
