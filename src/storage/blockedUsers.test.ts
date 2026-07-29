import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockUser, isBlocked, listBlockedUsers, unblockUser } from './blockedUsers.js';

test('a user is unblocked until blockUser() is called', () => {
  assert.equal(isBlocked(-4001, 1), false);
  blockUser(-4001, 1, 'artem', 999);
  assert.equal(isBlocked(-4001, 1), true);
});

test('unblockUser() reverses blockUser()', () => {
  blockUser(-4002, 1, 'artem', 999);
  unblockUser(-4002, 1);
  assert.equal(isBlocked(-4002, 1), false);
});

test('block state is isolated per chat', () => {
  blockUser(-4003, 1, 'artem', 999);
  assert.equal(isBlocked(-4004, 1), false);
});

test('block state is isolated per user within the same chat', () => {
  blockUser(-4005, 1, 'artem', 999);
  assert.equal(isBlocked(-4005, 2), false);
});

test('blockUser() is idempotent and keeps the latest username/blockedBy', () => {
  blockUser(-4006, 1, 'old-name', 999);
  assert.doesNotThrow(() => blockUser(-4006, 1, 'new-name', 998));
  const [entry] = listBlockedUsers(-4006);
  assert.equal(entry.username, 'new-name');
});

test('unblockUser() on a user who was never blocked does not throw', () => {
  assert.doesNotThrow(() => unblockUser(-4007, 1));
});

test('listBlockedUsers returns everyone blocked in that chat', () => {
  blockUser(-4008, 1, 'artem', 999);
  blockUser(-4008, 2, 'olya', 999);

  const blocked = listBlockedUsers(-4008);

  assert.equal(blocked.length, 2);
  assert.deepEqual(blocked.map((b) => b.userId).sort(), [1, 2]);
});
