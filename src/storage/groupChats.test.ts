import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// groupChats.ts loads its state once at import time from a hardcoded-by-default path, so the only
// way to isolate a test run is to point DEZHEREMO_DATA_DIR at a fresh temp dir *before* importing —
// a dynamic import() (unlike a static one) runs at this exact point in the file, not hoisted above it.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzb-groupchats-'));
process.env.DEZHEREMO_DATA_DIR = dataDir;

// Pre-seed the legacy bare-array format before the module's one-time load() runs, to exercise the migration path.
fs.writeFileSync(path.join(dataDir, 'groupChats.json'), JSON.stringify([-6000]));

const { addGroupChat, getGroupChatTitle, listGroupChats, removeGroupChat } = await import('./groupChats.js');

test('legacy bare-array format migrates to "title unknown yet"', () => {
  assert.equal(listGroupChats().includes(-6000), true);
  assert.equal(getGroupChatTitle(-6000), undefined); // empty string is treated as absent
});

test('addGroupChat adds a chat and getGroupChatTitle returns its title', () => {
  addGroupChat(-6001, 'Test Group');
  assert.equal(listGroupChats().includes(-6001), true);
  assert.equal(getGroupChatTitle(-6001), 'Test Group');
});

test('addGroupChat with an empty title keeps getGroupChatTitle reporting it as absent', () => {
  addGroupChat(-6002, '');
  assert.equal(getGroupChatTitle(-6002), undefined);
});

test('removeGroupChat removes the chat', () => {
  addGroupChat(-6003, 'Removable');
  removeGroupChat(-6003);
  assert.equal(listGroupChats().includes(-6003), false);
});

test('changes are persisted to disk', () => {
  addGroupChat(-6004, 'Persisted Group');
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'groupChats.json'), 'utf-8'));
  assert.equal(raw['-6004'], 'Persisted Group');
});
