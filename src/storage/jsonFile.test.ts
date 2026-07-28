import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readJsonFile, writeJsonFileAtomic } from './jsonFile.js';

function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzb-jsonfile-'));
  return path.join(dir, name);
}

test('readJsonFile returns the fallback and does not log when the file does not exist', (t) => {
  const errorSpy = t.mock.method(console, 'error');
  const file = tmpFile('missing.json');

  const result = readJsonFile(file, { fallback: true });

  assert.deepEqual(result, { fallback: true });
  assert.equal(errorSpy.mock.callCount(), 0);
});

test('readJsonFile parses valid JSON', () => {
  const file = tmpFile('valid.json');
  fs.writeFileSync(file, JSON.stringify({ a: 1 }));

  assert.deepEqual(readJsonFile(file, {}), { a: 1 });
});

test('readJsonFile falls back and logs on corrupted JSON', (t) => {
  const errorSpy = t.mock.method(console, 'error');
  const file = tmpFile('corrupted.json');
  fs.writeFileSync(file, '{not valid json');

  const result = readJsonFile(file, { fallback: true });

  assert.deepEqual(result, { fallback: true });
  assert.equal(errorSpy.mock.callCount(), 1);
});

test('writeJsonFileAtomic writes data readable back via readJsonFile', () => {
  const file = tmpFile('roundtrip.json');

  writeJsonFileAtomic(file, { hello: 'world' });

  assert.deepEqual(readJsonFile(file, {}), { hello: 'world' });
});

test('writeJsonFileAtomic overwrites existing content and leaves no temp file behind', () => {
  const file = tmpFile('overwrite.json');
  writeJsonFileAtomic(file, { version: 1 });

  writeJsonFileAtomic(file, { version: 2 });

  assert.deepEqual(readJsonFile(file, {}), { version: 2 });
  const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});
