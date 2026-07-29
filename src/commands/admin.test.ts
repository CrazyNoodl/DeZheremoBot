import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Context } from 'telegraf';

// commands/admin.ts pulls in storage/groupSchedules.ts (via services/submissionService.ts's
// scheduler-adjacent imports) — same DEZHEREMO_DATA_DIR isolation as commands/schedule.test.ts.
process.env.DEZHEREMO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dzb-admin-cmd-'));
const { handleAdminAction } = await import('./admin.js');
const {
  declinePlace,
  getAllSubmissions,
  isGroupPaused,
  isSubmissionLocked,
  isUserBlocked,
  listBlockedUsersInGroup,
  lockSubmissions,
  submitPlace,
} = await import('../services/submissionService.js');

function fakeCtx(status: string, userId: number) {
  const alerts: string[] = [];
  const sentMessages: Array<{ chatId: number; text: string }> = [];
  const ctx = {
    from: { id: userId },
    chat: { id: userId },
    callbackQuery: undefined as { data: string; message?: { chat: { id: number }; message_id: number } } | undefined,
    telegram: {
      getChatMember: async () => {
        if (status === 'throw') throw new Error('boom');
        return { status };
      },
      editMessageText: async () => {
        throw new Error('no message tracked to edit in this test');
      },
      sendMessage: async (chatId: number, text: string) => {
        sentMessages.push({ chatId, text });
        return { message_id: 1 };
      },
    },
    reply: async () => ({ message_id: 1 }),
    answerCbQuery: async (text?: string, extra?: { show_alert?: boolean }) => {
      if (extra?.show_alert && text) alerts.push(text);
    },
  };
  return { ctx: ctx as unknown as Context, rawCtx: ctx, alerts, sentMessages };
}

function withCallbackData(rawCtx: { callbackQuery?: { data: string } }, data: string) {
  rawCtx.callbackQuery = { data };
}

test('handleAdminAction refuses "pause" for a user who is no longer an admin', async () => {
  const userId = 30001;
  const chatId = -30001;

  const { ctx, rawCtx, alerts } = fakeCtx('member', userId);
  withCallbackData(rawCtx, `admin:pause:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(alerts.some((a) => /Лише адміни/.test(a)), true);
  assert.equal(isGroupPaused(chatId), false);
});

test('handleAdminAction pauses and then resumes a group for a current admin', async () => {
  const userId = 30002;
  const chatId = -30002;

  const { ctx: pauseCtx, rawCtx: pauseRawCtx } = fakeCtx('administrator', userId);
  withCallbackData(pauseRawCtx, `admin:pause:${chatId}`);
  await handleAdminAction(pauseCtx);
  assert.equal(isGroupPaused(chatId), true);

  const { ctx: resumeCtx, rawCtx: resumeRawCtx } = fakeCtx('administrator', userId);
  withCallbackData(resumeRawCtx, `admin:resume:${chatId}`);
  await handleAdminAction(resumeCtx);
  assert.equal(isGroupPaused(chatId), false);
});

test('handleAdminAction refuses "draw" for a user who is no longer an admin', async () => {
  const userId = 30003;
  const chatId = -30003;
  submitPlace(chatId, 1, 'artem', 'https://www.instagram.com/somewhere');

  const { ctx, rawCtx, alerts, sentMessages } = fakeCtx('member', userId);
  withCallbackData(rawCtx, `admin:draw:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(alerts.some((a) => /Лише адміни/.test(a)), true);
  assert.equal(sentMessages.length, 0);
  assert.equal(getAllSubmissions(chatId).length, 1); // draw never ran, submission untouched
});

test('handleAdminAction "draw" picks a winner, clears submissions, unlocks, and announces to the group', async () => {
  const userId = 30004;
  const chatId = -30004;
  submitPlace(chatId, 1, 'artem', 'https://www.instagram.com/somewhere');
  lockSubmissions(chatId);

  const { ctx, rawCtx, sentMessages } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:draw:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].chatId, chatId);
  assert.match(sentMessages[0].text, /ДеЖеремо цього тижня/);
  assert.equal(getAllSubmissions(chatId).length, 0);
  assert.equal(isSubmissionLocked(chatId), false);
});

test('handleAdminAction "draw" with no submissions announces "nobody submitted" instead of a place', async () => {
  const userId = 30005;
  const chatId = -30005;

  const { ctx, rawCtx, sentMessages } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:draw:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /мовчали/);
});

test('handleAdminAction refuses "reopen" for a user who is no longer an admin', async () => {
  const userId = 30006;
  const chatId = -30006;
  lockSubmissions(chatId);

  const { ctx, rawCtx, alerts } = fakeCtx('member', userId);
  withCallbackData(rawCtx, `admin:reopen:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(alerts.some((a) => /Лише адміни/.test(a)), true);
  assert.equal(isSubmissionLocked(chatId), true);
});

test('handleAdminAction "reopen" unlocks without touching submissions', async () => {
  const userId = 30007;
  const chatId = -30007;
  submitPlace(chatId, 1, 'artem', 'https://www.instagram.com/somewhere');
  lockSubmissions(chatId);

  const { ctx, rawCtx } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:reopen:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(isSubmissionLocked(chatId), false);
  assert.equal(getAllSubmissions(chatId).length, 1);
});

test('handleAdminAction refuses "clearweek" for a user who is no longer an admin', async () => {
  const userId = 30008;
  const chatId = -30008;
  submitPlace(chatId, 1, 'artem', 'https://www.instagram.com/somewhere');

  const { ctx, rawCtx, alerts } = fakeCtx('member', userId);
  withCallbackData(rawCtx, `admin:clearweek:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(alerts.some((a) => /Лише адміни/.test(a)), true);
  assert.equal(getAllSubmissions(chatId).length, 1);
});

test('handleAdminAction "clearweek" clears submissions and unlocks without drawing or announcing', async () => {
  const userId = 30009;
  const chatId = -30009;
  submitPlace(chatId, 1, 'artem', 'https://www.instagram.com/somewhere');
  lockSubmissions(chatId);

  const { ctx, rawCtx, sentMessages } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:clearweek:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(getAllSubmissions(chatId).length, 0);
  assert.equal(isSubmissionLocked(chatId), false);
  assert.equal(sentMessages.length, 0);
});

test('handleAdminAction refuses "block" for a user who is no longer an admin', async () => {
  const userId = 30010;
  const chatId = -30010;
  const targetUserId = 1;
  submitPlace(chatId, targetUserId, 'artem', 'https://www.instagram.com/somewhere');

  const { ctx, rawCtx, alerts } = fakeCtx('member', userId);
  withCallbackData(rawCtx, `admin:block:${chatId}:${targetUserId}`);
  await handleAdminAction(ctx);

  assert.equal(alerts.some((a) => /Лише адміни/.test(a)), true);
  assert.equal(isUserBlocked(chatId, targetUserId), false);
});

test('handleAdminAction "block" blocks the target and drops their current-week submission', async () => {
  const userId = 30011;
  const chatId = -30011;
  const targetUserId = 1;
  submitPlace(chatId, targetUserId, 'artem', 'https://www.instagram.com/somewhere');

  const { ctx, rawCtx } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:block:${chatId}:${targetUserId}`);
  await handleAdminAction(ctx);

  assert.equal(isUserBlocked(chatId, targetUserId), true);
  assert.equal(getAllSubmissions(chatId).length, 0);
  assert.equal(listBlockedUsersInGroup(chatId)[0]?.username, 'artem');
});

test('handleAdminAction "unblock" reverses "block" and lets the target submit again', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });

  const userId = 30012;
  const chatId = -30012;
  const targetUserId = 1;
  submitPlace(chatId, targetUserId, 'artem', 'https://www.instagram.com/somewhere');

  const { ctx: blockCtx, rawCtx: blockRawCtx } = fakeCtx('administrator', userId);
  withCallbackData(blockRawCtx, `admin:block:${chatId}:${targetUserId}`);
  await handleAdminAction(blockCtx);
  assert.equal(isUserBlocked(chatId, targetUserId), true);

  const { ctx: unblockCtx, rawCtx: unblockRawCtx } = fakeCtx('administrator', userId);
  withCallbackData(unblockRawCtx, `admin:unblock:${chatId}:${targetUserId}`);
  await handleAdminAction(unblockCtx);

  assert.equal(isUserBlocked(chatId, targetUserId), false);
  t.mock.timers.tick(10_001); // past the resubmit cooldown, otherwise this looks rate_limited
  const result = submitPlace(chatId, targetUserId, 'artem', 'https://www.instagram.com/somewhere');
  assert.equal(result.ok, true);
});

test('handleAdminAction "draw" excludes a decliner from the pool but still clears their decline', async () => {
  const userId = 30014;
  const chatId = -30014;
  submitPlace(chatId, 1, 'artem', 'https://www.instagram.com/somewhere');
  declinePlace(chatId, 2, 'olya');

  const { ctx, rawCtx, sentMessages } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:draw:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /artem/);
  assert.equal(getAllSubmissions(chatId).length, 0);
});

test('handleAdminAction "block" can block a user who only declined this week, dropping their decline', async () => {
  const userId = 30015;
  const chatId = -30015;
  const targetUserId = 2;
  declinePlace(chatId, targetUserId, 'olya');

  const { ctx, rawCtx } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:block:${chatId}:${targetUserId}`);
  await handleAdminAction(ctx);

  assert.equal(isUserBlocked(chatId, targetUserId), true);
  assert.equal(getAllSubmissions(chatId).length, 0);
});

test('handleAdminAction refuses "blocklist" for a user who is no longer an admin', async () => {
  const userId = 30013;
  const chatId = -30013;

  const { ctx, rawCtx, alerts } = fakeCtx('member', userId);
  withCallbackData(rawCtx, `admin:blocklist:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(alerts.some((a) => /Лише адміни/.test(a)), true);
});
