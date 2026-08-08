import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { snapshotDatabaseFile } from './backupSnapshot.js';

function makeSourceDb(dir: string, rows: string[]): string {
  const sourcePath = path.join(dir, 'source.db');
  const db = new DatabaseSync(sourcePath);
  db.exec('CREATE TABLE items (value TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO items (value) VALUES (?)');
  for (const value of rows) insert.run(value);
  db.close();
  return sourcePath;
}

function readValues(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare('SELECT value FROM items ORDER BY rowid').all() as Array<{ value: string }>).map(
      (row) => row.value,
    );
  } finally {
    db.close();
  }
}

test('snapshotDatabaseFile produces a queryable copy with the same rows as the source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzb-backup-'));
  const sourcePath = makeSourceDb(dir, ['alpha', 'beta']);
  const destPath = path.join(dir, 'snapshot.db');

  snapshotDatabaseFile(sourcePath, destPath);

  assert.equal(fs.existsSync(destPath), true);
  assert.deepEqual(readValues(destPath), ['alpha', 'beta']);
});

test('snapshotDatabaseFile is independent of the source afterward — later source writes do not leak into an existing snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzb-backup-'));
  const sourcePath = makeSourceDb(dir, ['first']);
  const destPath = path.join(dir, 'snapshot.db');

  snapshotDatabaseFile(sourcePath, destPath);
  assert.deepEqual(readValues(destPath), ['first']);

  const db = new DatabaseSync(sourcePath);
  db.prepare('INSERT INTO items (value) VALUES (?)').run('second');
  db.close();

  assert.deepEqual(readValues(destPath), ['first']); // untouched by the source write above
});

test('snapshotDatabaseFile overwrites a stale destination from a previous run rather than refusing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzb-backup-'));
  const destPath = path.join(dir, 'snapshot.db');

  snapshotDatabaseFile(makeSourceDb(dir, ['old']), destPath);
  assert.deepEqual(readValues(destPath), ['old']);

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dzb-backup-'));
  snapshotDatabaseFile(makeSourceDb(dir2, ['new-one', 'new-two']), destPath);
  assert.deepEqual(readValues(destPath), ['new-one', 'new-two']);
});
