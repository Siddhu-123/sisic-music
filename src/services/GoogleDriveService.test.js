import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeDriveQuery, SCOPES } from './GoogleDriveService.js';

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
