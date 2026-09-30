import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exceedsDownloadDuration,
  formatDurationSeconds,
  getKnownDurationSeconds,
  MAX_DOWNLOAD_DURATION_SECONDS,
  parseDurationSeconds,
} from './downloadPolicy.js';

test('download duration policy parses numeric and clock-formatted durations', () => {
  assert.equal(parseDurationSeconds(480), 480);
  assert.equal(parseDurationSeconds('8:00'), 480);
  assert.equal(parseDurationSeconds('1:02:03'), 3723);
  assert.equal(parseDurationSeconds('unknown'), null);
});

test('download duration policy allows exactly eight minutes and rejects longer songs', () => {
  assert.equal(exceedsDownloadDuration({ durationSeconds: MAX_DOWNLOAD_DURATION_SECONDS }), false);
  assert.equal(exceedsDownloadDuration({ durationSeconds: 481 }), true);
  assert.equal(formatDurationSeconds(481), '8:01');
  assert.equal(formatDurationSeconds(MAX_DOWNLOAD_DURATION_SECONDS + 0.1), '8:01');
});

test('download duration policy falls back to duration metadata on the job', () => {
  assert.equal(getKnownDurationSeconds({ durationMs: 481000 }), 481);
  assert.equal(getKnownDurationSeconds({ downloadJob: { sourceDuration: '9:12' } }), 552);
});
