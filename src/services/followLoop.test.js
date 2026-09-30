// Tests for createFollowLoop timer management and error handling.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFollowLoop } from './followLoop.js';

function createFakeTimer() {
  let tickCallback = null;
  const timerId = Symbol('timerId');
  let setCalls = 0;
  let clearCalls = 0;
  const clearedHandles = [];

  const setIntervalFn = (cb) => {
    tickCallback = cb;
    setCalls++;
    return timerId;
  };

  const clearIntervalFn = (handle) => {
    clearCalls++;
    clearedHandles.push(handle);
  };

  const tick = () => {
    if (!tickCallback) {
      throw new Error('No tick callback registered');
    }
    tickCallback();
  };

  return {
    setIntervalFn,
    clearIntervalFn,
    tick,
    get setCalls() {
      return setCalls;
    },
    get clearCalls() {
      return clearCalls;
    },
    get clearedHandles() {
      return clearedHandles;
    },
    get timerId() {
      return timerId;
    },
  };
}

test('start() twice creates exactly one timer', () => {
  const timer = createFakeTimer();
  const loop = createFollowLoop({
    read: () => ({ outTime: 1, inTime: 1, outRate: 1 }),
    step: () => ({ rate: 1, errorSeconds: 0 }),
    apply: () => {},
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  });

  assert.equal(loop.running, false);
  loop.start();
  assert.equal(loop.running, true);
  assert.equal(timer.setCalls, 1);

  loop.start();
  assert.equal(loop.running, true);
  assert.equal(timer.setCalls, 1);

  loop.stop();
  assert.equal(timer.clearCalls, 1);
  assert.equal(timer.clearedHandles[0], timer.timerId);
});

test('a tick applies the rate (apply called with the rate and the full result)', () => {
  const timer = createFakeTimer();
  const calls = [];
  const expectedResult = { rate: 1.05, errorSeconds: 0.02 };

  const loop = createFollowLoop({
    read: () => ({ outTime: 1.0, inTime: 1.02, outRate: 1.0 }),
    step: () => expectedResult,
    apply: (rate, result) => {
      calls.push({ rate, result });
    },
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  });

  loop.start();
  timer.tick();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].rate, 1.05);
  assert.deepEqual(calls[0].result, expectedResult);

  const stats = loop.stats();
  assert.equal(stats.ticks, 1);
  assert.equal(stats.applied, 1);
  assert.equal(stats.skipped, 0);
  assert.equal(stats.lastRate, 1.05);
  assert.equal(stats.lastErrorSeconds, 0.02);

  loop.stop();
  assert.equal(timer.clearCalls, 1);
});

test('a null reading skips the tick (no step, no apply)', () => {
  const timer = createFakeTimer();
  let stepCalled = false;
  let applyCalled = false;

  const loop = createFollowLoop({
    read: () => null,
    step: () => {
      stepCalled = true;
      return { rate: 1, errorSeconds: 0 };
    },
    apply: () => {
      applyCalled = true;
    },
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  });

  loop.start();
  timer.tick();

  assert.equal(stepCalled, false);
  assert.equal(applyCalled, false);

  const stats = loop.stats();
  assert.equal(stats.ticks, 1);
  assert.equal(stats.skipped, 1);
  assert.equal(stats.applied, 0);

  loop.stop();
  assert.equal(timer.clearCalls, 1);
});

test('a non-finite rate (e.g. NaN) skips the tick (no apply)', () => {
  const timer = createFakeTimer();
  let applyCalled = false;
  let currentRate = NaN;

  const loop = createFollowLoop({
    read: () => ({ outTime: 1, inTime: 1, outRate: 1 }),
    step: () => ({ rate: currentRate, errorSeconds: 0.01 }),
    apply: () => {
      applyCalled = true;
    },
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  });

  loop.start();

  timer.tick();
  assert.equal(applyCalled, false);
  assert.equal(loop.stats().ticks, 1);
  assert.equal(loop.stats().skipped, 1);
  assert.equal(loop.stats().applied, 0);

  currentRate = Infinity;
  timer.tick();
  assert.equal(applyCalled, false);
  assert.equal(loop.stats().ticks, 2);
  assert.equal(loop.stats().skipped, 2);
  assert.equal(loop.stats().applied, 0);

  currentRate = -Infinity;
  timer.tick();
  assert.equal(applyCalled, false);
  assert.equal(loop.stats().ticks, 3);
  assert.equal(loop.stats().skipped, 3);
  assert.equal(loop.stats().applied, 0);

  loop.stop();
  assert.equal(timer.clearCalls, 1);
});

test('a large error stops with reason "lost-lock" and does not apply; loop is no longer running', () => {
  const timer = createFakeTimer();
  const stopReasons = [];
  let applyCalled = false;

  const loop = createFollowLoop({
    read: () => ({ outTime: 1, inTime: 2, outRate: 1 }),
    step: () => ({ rate: 1.1, errorSeconds: 0.7 }),
    apply: () => {
      applyCalled = true;
    },
    maxErrorSeconds: 0.5,
    onStop: (reason) => {
      stopReasons.push(reason);
    },
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  });

  loop.start();
  assert.equal(loop.running, true);

  timer.tick();

  assert.equal(applyCalled, false);
  assert.equal(loop.running, false);
  assert.deepEqual(stopReasons, ['lost-lock']);
  assert.equal(timer.clearCalls, 1);
  assert.equal(timer.clearedHandles[0], timer.timerId);

  const stats = loop.stats();
  assert.equal(stats.ticks, 1);
  assert.equal(stats.applied, 0);
  assert.equal(stats.skipped, 0);
  assert.equal(stats.lastRate, 1.1);
  assert.equal(stats.lastErrorSeconds, 0.7);
});

test('stop() is idempotent and onStop fires exactly once, with the default reason "stopped"', () => {
  const timer = createFakeTimer();
  const stopReasons = [];

  const loop = createFollowLoop({
    read: () => ({ outTime: 1, inTime: 1, outRate: 1 }),
    step: () => ({ rate: 1, errorSeconds: 0 }),
    apply: () => {},
    onStop: (reason) => {
      stopReasons.push(reason);
    },
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  });

  loop.stop();
  assert.equal(stopReasons.length, 0);
  assert.equal(timer.clearCalls, 0);

  loop.start();
  assert.equal(loop.running, true);

  loop.stop();
  assert.equal(loop.running, false);
  assert.deepEqual(stopReasons, ['stopped']);
  assert.equal(timer.clearCalls, 1);
  assert.equal(timer.clearedHandles[0], timer.timerId);

  loop.stop();
  loop.stop('other');
  assert.deepEqual(stopReasons, ['stopped']);
  assert.equal(timer.clearCalls, 1);
});

test('an exception thrown by step stops with reason "error", does not escape, and is recorded in stats().error', () => {
  const timer = createFakeTimer();
  const stopReasons = [];
  const testError = new Error('step failure');

  const loop = createFollowLoop({
    read: () => ({ outTime: 1, inTime: 1, outRate: 1 }),
    step: () => {
      throw testError;
    },
    apply: () => {},
    onStop: (reason) => {
      stopReasons.push(reason);
    },
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  });

  loop.start();
  assert.doesNotThrow(() => {
    timer.tick();
  });

  assert.equal(loop.running, false);
  assert.deepEqual(stopReasons, ['error']);
  assert.equal(loop.stats().error, testError);
  assert.equal(timer.clearCalls, 1);
  assert.equal(timer.clearedHandles[0], timer.timerId);
});

test('an exception thrown by read or apply stops with reason "error", does not escape, and increments stats', () => {
  const timer1 = createFakeTimer();
  const readError = new Error('read failure');
  const loop1 = createFollowLoop({
    read: () => {
      throw readError;
    },
    step: () => ({ rate: 1, errorSeconds: 0 }),
    apply: () => {},
    setIntervalFn: timer1.setIntervalFn,
    clearIntervalFn: timer1.clearIntervalFn,
  });

  loop1.start();
  assert.doesNotThrow(() => {
    timer1.tick();
  });
  assert.equal(loop1.running, false);
  assert.equal(loop1.stats().error, readError);
  assert.equal(loop1.stats().ticks, 1);
  assert.equal(loop1.stats().applied, 0);

  const timer2 = createFakeTimer();
  const applyError = new Error('apply failure');
  const loop2 = createFollowLoop({
    read: () => ({ outTime: 1, inTime: 1, outRate: 1 }),
    step: () => ({ rate: 1.02, errorSeconds: 0.01 }),
    apply: () => {
      throw applyError;
    },
    setIntervalFn: timer2.setIntervalFn,
    clearIntervalFn: timer2.clearIntervalFn,
  });

  loop2.start();
  assert.doesNotThrow(() => {
    timer2.tick();
  });
  assert.equal(loop2.running, false);
  assert.equal(loop2.stats().error, applyError);
  assert.equal(loop2.stats().ticks, 1);
  assert.equal(loop2.stats().applied, 0);
});

test('stats() counts ticks, applied and skipped correctly across a sequence of ticks', () => {
  const timer = createFakeTimer();
  let stepCallCount = 0;
  let applyCallCount = 0;

  let mode = 'normal';

  const loop = createFollowLoop({
    read: () => {
      if (mode === 'null-read') {
        return null;
      }
      return { outTime: 1, inTime: 1, outRate: 1 };
    },
    step: () => {
      stepCallCount++;
      if (mode === 'nan-rate') {
        return { rate: NaN, errorSeconds: 0.1 };
      }
      return { rate: 1.0 + stepCallCount * 0.01, errorSeconds: 0.01 * stepCallCount };
    },
    apply: () => {
      applyCallCount++;
    },
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  });

  loop.start();

  mode = 'normal';
  timer.tick();
  assert.equal(loop.stats().ticks, 1);
  assert.equal(loop.stats().applied, 1);
  assert.equal(loop.stats().skipped, 0);
  assert.equal(loop.stats().lastRate, 1.01);
  assert.equal(loop.stats().lastErrorSeconds, 0.01);

  mode = 'null-read';
  timer.tick();
  assert.equal(loop.stats().ticks, 2);
  assert.equal(loop.stats().applied, 1);
  assert.equal(loop.stats().skipped, 1);
  assert.equal(loop.stats().lastRate, 1.01);
  assert.equal(loop.stats().lastErrorSeconds, 0.01);

  mode = 'nan-rate';
  timer.tick();
  assert.equal(loop.stats().ticks, 3);
  assert.equal(loop.stats().applied, 1);
  assert.equal(loop.stats().skipped, 2);
  assert.equal(loop.stats().lastRate, 1.01);
  assert.equal(loop.stats().lastErrorSeconds, 0.01);

  mode = 'normal';
  timer.tick();
  assert.equal(loop.stats().ticks, 4);
  assert.equal(loop.stats().applied, 2);
  assert.equal(loop.stats().skipped, 2);
  assert.equal(loop.stats().lastRate, 1.03);
  assert.equal(loop.stats().lastErrorSeconds, 0.03);

  assert.equal(applyCallCount, 2);
  assert.equal(loop.stats().error, null);

  loop.stop();
  assert.equal(timer.clearCalls, 1);
  assert.equal(timer.clearedHandles[0], timer.timerId);
});

test('an undefined reading and a non-finite error skip the tick when a limit is set', () => {
  let reading;
  let error = NaN;
  const timers = [];
  const applied = [];
  const loop = createFollowLoop({
    read: () => reading,
    step: () => ({ rate: 1, errorSeconds: error }),
    apply: rate => applied.push(rate),
    maxErrorSeconds: 0.3,
    setIntervalFn: fn => { timers.push(fn); return 1; },
    clearIntervalFn: () => {},
  });
  loop.start();
  timers[0]();
  reading = { outTime: 1, inTime: 1, outRate: 1 };
  timers[0]();
  assert.deepEqual(applied, []);
  assert.equal(loop.stats().skipped, 2);
  error = 0.01;
  timers[0]();
  assert.deepEqual(applied, [1]);
});
