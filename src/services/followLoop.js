// Periodic timer loop driving the beat follower PLL during DJ mixes.
// Repeatedly samples playback positions and rates, computes step corrections, and applies them.

export function createFollowLoop(options = {}) {
  const {
    step,
    read,
    apply,
    intervalMs = 100,
    maxErrorSeconds,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    onStop,
  } = options;

  let isRunning = false;
  let stopReason = null;
  let timerHandle = null;
  let ticks = 0;
  let applied = 0;
  let skipped = 0;
  let lastErrorSeconds = null;
  let lastRate = null;
  let error = null;

  function tick() {
    ticks++;
    try {
      const reading = read();
      if (reading == null) {
        skipped++;
        return;
      }

      const result = step(reading);
      if (!result || !Number.isFinite(result.rate)) {
        skipped++;
        return;
      }

      if (typeof result.errorSeconds === 'number' && !Number.isNaN(result.errorSeconds)) {
        lastErrorSeconds = result.errorSeconds;
      }
      if (typeof result.rate === 'number' && !Number.isNaN(result.rate)) {
        lastRate = result.rate;
      }

      if (maxErrorSeconds != null) {
        if (!Number.isFinite(result.errorSeconds)) {
          skipped++;
          return;
        }
        if (Math.abs(result.errorSeconds) > maxErrorSeconds) {
          stop('lost-lock');
          return;
        }
      }

      apply(result.rate, result);
      applied++;
    } catch (err) {
      error = err;
      stop('error');
    }
  }

  function start() {
    if (isRunning) {
      return;
    }
    isRunning = true;
    timerHandle = setIntervalFn(tick, intervalMs);
  }

  function stop(reason = 'stopped') {
    if (!isRunning) {
      return;
    }
    isRunning = false;
    stopReason = reason;
    if (timerHandle !== null) {
      clearIntervalFn(timerHandle);
      timerHandle = null;
    }
    if (typeof onStop === 'function') {
      onStop(reason);
    }
  }

  function stats() {
    return {
      ticks,
      applied,
      skipped,
      lastErrorSeconds,
      lastRate,
      error,
      stopReason,
    };
  }

  return {
    start,
    stop,
    get running() {
      return isRunning;
    },
    get stopReason() {
      return stopReason;
    },
    stats,
  };
}
