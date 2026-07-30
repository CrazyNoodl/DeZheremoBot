import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listAdminActions, logAdminAction } from './auditLog.js';

test('logAdminAction() writes a row listAdminActions() can read back', () => {
  logAdminAction({ chatId: -14001, actorUserId: 1, actorName: 'artem', action: 'pause' });

  const [entry] = listAdminActions(-14001);

  assert.equal(entry.chatId, -14001);
  assert.equal(entry.actorUserId, 1);
  assert.equal(entry.actorName, 'artem');
  assert.equal(entry.action, 'pause');
  assert.equal(entry.detail, null);
});

test('detail defaults to null when omitted', () => {
  logAdminAction({ chatId: -14002, actorUserId: 1, actorName: 'artem', action: 'resume' });

  const [entry] = listAdminActions(-14002);

  assert.equal(entry.detail, null);
});

test('detail is stored when provided', () => {
  logAdminAction({ chatId: -14003, actorUserId: 1, actorName: 'artem', action: 'block', detail: 'target:42' });

  const [entry] = listAdminActions(-14003);

  assert.equal(entry.detail, 'target:42');
});

test('actions are isolated per chat', () => {
  logAdminAction({ chatId: -14004, actorUserId: 1, actorName: 'artem', action: 'pause' });

  assert.deepEqual(listAdminActions(-14005), []);
});

test('multiple calls append in ascending order, never overwriting a prior row', () => {
  logAdminAction({ chatId: -14006, actorUserId: 1, actorName: 'artem', action: 'pause' });
  logAdminAction({ chatId: -14006, actorUserId: 2, actorName: 'olya', action: 'resume' });

  const entries = listAdminActions(-14006);

  assert.equal(entries.length, 2);
  assert.ok(entries[0].id < entries[1].id);
  assert.equal(entries[0].action, 'pause');
  assert.equal(entries[1].action, 'resume');
});
