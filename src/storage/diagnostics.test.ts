import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { formatBytes, getFileSizeBytes, getStorageDiagnostics } from './diagnostics.js';

test('getFileSizeBytes returns the real byte count for an existing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzb-diag-'));
  const filePath = path.join(dir, 'sample.txt');
  fs.writeFileSync(filePath, 'x'.repeat(1234));

  assert.equal(getFileSizeBytes(filePath), 1234);
});

test('getFileSizeBytes returns null for a missing path instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzb-diag-'));
  assert.equal(getFileSizeBytes(path.join(dir, 'does-not-exist.db')), null);
});

test('getFileSizeBytes returns null for the ":memory:" test-db placeholder', () => {
  assert.equal(getFileSizeBytes(':memory:'), null);
});

// Under the test npm script both DEZHEREMO_STATE_DB/DEZHEREMO_HISTORY_DB are ':memory:', so this
// documents that getStorageDiagnostics degrades to both fields null rather than throwing when
// there's no real file behind either DB connection.
test('getStorageDiagnostics reports null for both sizes when the DBs are in-memory', () => {
  assert.deepEqual(getStorageDiagnostics(), { stateDbBytes: null, historyDbBytes: null });
});

test('formatBytes renders bytes, KB, and MB with the expected precision', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 * 1024 - 1), '1024.0 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(1024 * 1024 * 2.5), '2.5 MB');
});
