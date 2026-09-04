import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeDriveQuery, GoogleDriveService, isAudioFileMetadata, SCOPES, SOURCE_FEEDBACK_FILENAME } from './GoogleDriveService.js';

test('isAudioFileMetadata rejects Sisic JSON records', () => {
  assert.equal(isAudioFileMetadata({ name: 'sisic-job-song.json', mimeType: 'application/json' }), false);
  assert.equal(isAudioFileMetadata({ name: 'Artist - Track.mp3', mimeType: 'audio/mpeg' }), true);
});

test('findSongInIndex does not trust a stale non-audio Drive ID', async () => {
  const service = new GoogleDriveService();
  service.readSongIndex = async () => ({ songs: [{
    songKey: 'artist::track',
    artist: 'Artist',
    track: 'Track',
    driveFileId: 'job-json-id',
    filename: 'Artist - Track.mp3',
  }] });
  service.getAudioFileMetadata = async () => null;

  const result = await service.findSongInIndex({ artist: 'Artist', track: 'Track' }, 'folder-id');
  assert.equal(result, null);
});

test('SCOPES avoids full Drive read/write access while retaining app writes and library reads', () => {
  assert.ok(SCOPES.includes('https://www.googleapis.com/auth/drive.file'));
  assert.ok(SCOPES.includes('https://www.googleapis.com/auth/drive.readonly'));
  assert.ok(!SCOPES.split(' ').includes('https://www.googleapis.com/auth/drive'));
});

test('escapeDriveQuery sanitizes single quotes, backslashes, and control characters', () => {
  assert.strictEqual(escapeDriveQuery("Don't Stop Believin'"), "Don\\'t Stop Believin\\'");
  assert.strictEqual(escapeDriveQuery('Path\\To\\Song'), 'Path\\\\To\\\\Song');
  assert.strictEqual(escapeDriveQuery("AC/DC - Back in Black (1980)\0"), "AC/DC - Back in Black (1980)");
  assert.strictEqual(escapeDriveQuery("Line1\nLine2\r\t"), "Line1Line2");
  assert.strictEqual(escapeDriveQuery("Artist 'name' with \\slash\\ and 'quotes'"), "Artist \\'name\\' with \\\\slash\\\\ and \\'quotes\\'");
  assert.strictEqual(escapeDriveQuery(null), '');
  assert.strictEqual(escapeDriveQuery(undefined), '');
});

test('selectDownloadCandidate requeues the existing canonical job with the chosen URL', async () => {
  const service = new GoogleDriveService();
  const originalJob = {
    jobId: 'job-1',
    songKey: 'artist::track',
    artist: 'Artist',
    track: 'Track',
    status: 'needs-review',
    attempts: 1,
    replacementForFileId: 'old-audio',
    reviewCandidates: [{ candidateId: 'old-result' }],
  };
  let queue = { schemaVersion: 1, revision: 4, storageMode: 'canonical', jobs: [originalJob] };
  const feedback = [];
  service.readQueueIndex = async () => queue;
  service.writeJsonIndex = async (_folderId, filename, body) => {
    assert.equal(filename, 'sisic-queue.json');
    queue = body;
  };
  service.recordSourceFeedback = async (_folderId, _song, candidate, decision) => {
    feedback.push({ candidate, decision });
  };

  const result = await service.selectDownloadCandidate(
    'folder-id',
    { artist: 'Artist', track: 'Track', songKey: 'artist::track', downloadJob: originalJob },
    {
      candidateId: 'new-result',
      videoId: 'new-result',
      url: 'https://www.youtube.com/watch?v=new-result',
      title: 'Artist - Track Lyrics',
      uploader: 'Artist - Topic',
      duration: 200,
    },
  );

  assert.equal(result.queued, true);
  assert.equal(result.job.jobId, 'job-1');
  assert.equal(result.job.status, 'queued');
  assert.equal(result.job.attempts, 0);
  assert.equal(result.job.sourceUrl, 'https://www.youtube.com/watch?v=new-result');
  assert.equal(result.job.sourceSelectionMode, 'reviewed-youtube-candidate');
  assert.equal(result.job.durationSeconds, 200);
  assert.equal(result.job.allowLongDownload, false);
  assert.deepEqual(result.job.reviewCandidates, []);
  assert.equal(result.job.replacementForFileId, 'old-audio');
  assert.deepEqual(feedback, [{
    candidate: {
      candidateId: 'new-result',
      videoId: 'new-result',
      url: 'https://www.youtube.com/watch?v=new-result',
      title: 'Artist - Track Lyrics',
      uploader: 'Artist - Topic',
      duration: 200,
    },
    decision: 'accepted',
  }]);
  assert.equal(queue.jobs[0].sourceVideoId, 'new-result');
});

test('trashDownloadRequest cancels a review job without deleting the song', async () => {
  const service = new GoogleDriveService();
  const reviewJob = {
    jobId: 'job-review',
    songKey: 'artist::track',
    artist: 'Artist',
    track: 'Track',
    status: 'needs-review',
    reviewCandidates: [{ candidateId: 'long-result' }],
  };
  let queue = { schemaVersion: 1, revision: 1, storageMode: 'canonical', jobs: [reviewJob] };
  service.readQueueIndex = async () => queue;
  service.writeJsonIndex = async (_folderId, filename, body) => {
    assert.equal(filename, 'sisic-queue.json');
    queue = body;
  };

  const result = await service.trashDownloadRequest(
    'folder-id',
    { artist: 'Artist', track: 'Track', songKey: 'artist::track', downloadJob: reviewJob },
  );

  assert.equal(result.trashed, true);
  assert.equal(queue.jobs[0].status, 'cancelled');
  assert.equal(queue.jobs[0].reviewState, 'trashed');
  assert.equal(queue.jobs[0].lastError, 'Download request trashed by user.');
});

test('recordSourceFeedback writes one shared feedback index', async () => {
  const service = new GoogleDriveService();
  let written = null;
  service.mutateJsonIndex = async (_folderId, filename, key, defaults, mutator) => {
    assert.equal(filename, SOURCE_FEEDBACK_FILENAME);
    assert.equal(key, 'decisions');
    const decisions = await mutator([], {});
    written = { filename, decisions };
    return written;
  };

  const entry = await service.recordSourceFeedback(
    'folder-id',
    { artist: 'Artist', track: 'Track' },
    { candidateId: 'result-1', url: 'https://youtu.be/result-1', title: 'Track Lyrics', uploader: 'Artist' },
    'rejected',
  );

  assert.equal(written.filename, SOURCE_FEEDBACK_FILENAME);
  assert.equal(written.decisions.length, 1);
  assert.equal(written.decisions[0].songKey, 'artist::track');
  assert.equal(entry.decision, 'rejected');
});
