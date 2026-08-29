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
  blockUserFromGroup,
  declinePlace,
  getAllSubmissions,
  isGroupPaused,
  isSubmissionLocked,
  isUserBlocked,
  listBlockedUsersInGroup,
  lockSubmissions,
  submitPlace,
} = await import('../services/submissionService.js');
const { listAdminActions } = await import('../storage/auditLog.js');
const { getRatingSelection } = await import('../storage/ratingSelectionState.js');
const { isRatingSurveyEnabled } = await import('../services/ratingService.js');
const { getLatestDraw } = await import('../storage/history.js');
const { addOrUpdateRating, markAsAbsent } = await import('../storage/placeRatings.js');
const { isTimeSlotPollEnabled, setTimeSlotPollEnabled } = await import('../services/timeSlotPollService.js');
const { addOrUpdateTimeSlotResponse } = await import('../storage/timeSlotResponses.js');

function fakeCtx(status: string, userId: number) {
  const alerts: string[] = [];
  const sentMessages: Array<{ chatId: number; text: string }> = [];
  const replies: string[] = [];
  const replyButtonTexts: string[][] = [];
  const replyButtons: Array<Array<{ text: string; callback_data: string }>> = [];
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
    reply: async (
      text: string,
      extra?: { reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } },
    ) => {
      replies.push(text);
      const buttons = (extra?.reply_markup?.inline_keyboard ?? []).flat();
      replyButtonTexts.push(buttons.map((b) => b.text));
      replyButtons.push(buttons);
      return { message_id: 1 };
    },
    answerCbQuery: async (text?: string, extra?: { show_alert?: boolean }) => {
      if (extra?.show_alert && text) alerts.push(text);
    },
  };
  return { ctx: ctx as unknown as Context, rawCtx: ctx, alerts, sentMessages, replies, replyButtonTexts, replyButtons };
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
  assert.deepEqual(listAdminActions(chatId), []);
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

  const entries = listAdminActions(chatId);
  assert.deepEqual(entries.map((e) => e.action), ['pause', 'resume']);
  assert.equal(entries[0].actorUserId, userId);
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
  assert.deepEqual(listAdminActions(chatId), []);
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

  const [entry] = listAdminActions(chatId);
  assert.equal(entry.action, 'draw');
  assert.equal(entry.actorUserId, userId);
  assert.match(entry.detail ?? '', /^winner:1$/);
});

test('handleAdminAction "draw" with no submissions announces "nobody submitted" instead of a place', async () => {
  const userId = 30005;
  const chatId = -30005;

  const { ctx, rawCtx, sentMessages } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:draw:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /мовчали/);

  const [entry] = listAdminActions(chatId);
  assert.equal(entry.action, 'draw');
  assert.equal(entry.detail, null);
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
  assert.deepEqual(listAdminActions(chatId), []);
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
  assert.equal(listAdminActions(chatId)[0]?.action, 'reopen');
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
  assert.deepEqual(listAdminActions(chatId), []);
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
  assert.equal(listAdminActions(chatId)[0]?.action, 'clearweek');
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
  assert.deepEqual(listAdminActions(chatId), []);
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

  const [entry] = listAdminActions(chatId);
  assert.equal(entry.action, 'block');
  assert.equal(entry.detail, `target:${targetUserId}`);
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

  assert.deepEqual(
    listAdminActions(chatId).map((e) => e.action),
    ['block', 'unblock'],
  );
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
  assert.equal(listAdminActions(chatId)[0]?.action, 'draw');
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
  assert.equal(listAdminActions(chatId)[0]?.detail, `target:${targetUserId}`);
});

test('handleAdminAction refuses "blocklist" for a user who is no longer an admin', async () => {
  const userId = 30013;
  const chatId = -30013;

  const { ctx, rawCtx, alerts } = fakeCtx('member', userId);
  withCallbackData(rawCtx, `admin:blocklist:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(alerts.some((a) => /Лише адміни/.test(a)), true);
});

test('handleAdminAction refuses "rating" for a user who is no longer an admin', async () => {
  const userId = 30016;
  const chatId = -30016;

  const { ctx, rawCtx, alerts, replies } = fakeCtx('member', userId);
  withCallbackData(rawCtx, `admin:rating:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(alerts.some((a) => /Лише адміни/.test(a)), true);
  assert.equal(replies.length, 0);
});

test('handleAdminAction "rating" opens the category hub showing enabled state by default', async () => {
  const userId = 30017;
  const chatId = -30017;

  const { ctx, rawCtx, replies, replyButtonTexts } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:rating:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(replies.some((r) => /Стан: увімкнено/.test(r)), true);
  assert.equal(replyButtonTexts[0]?.some((label) => /Вимкнути/.test(label)), true);
});

test('handleAdminAction "rating_targets" with no completed draw yet shows nothing to send', async () => {
  const userId = 30040;
  const chatId = -30040;

  const { ctx, rawCtx, replies } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:rating_targets:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(replies.some((r) => /нікого запитати/.test(r)), true);
});

test('a current admin tapping "rating_survey_toggle" flips the flag and logs it', async () => {
  const userId = 30041;
  const chatId = -30041;
  assert.equal(isRatingSurveyEnabled(chatId), true); // starts at the default (enabled)

  const { ctx, rawCtx, replies } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:rating_survey_toggle:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(isRatingSurveyEnabled(chatId), false);
  assert.equal(listAdminActions(chatId)[0]?.action, 'rating_toggle');
  assert.equal(listAdminActions(chatId)[0]?.detail, 'off');
  assert.equal(replies.some((r) => /Стан: вимкнено/.test(r)), true); // re-renders the hub with the new state
});

test('handleAdminAction refuses "rating_survey_toggle" for a demoted admin and leaves the flag untouched', async () => {
  const userId = 30042;
  const chatId = -30042;

  const { ctx, rawCtx, alerts } = fakeCtx('member', userId);
  withCallbackData(rawCtx, `admin:rating_survey_toggle:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(alerts.some((a) => /Лише адміни/.test(a)), true);
  assert.equal(isRatingSurveyEnabled(chatId), true);
  assert.deepEqual(listAdminActions(chatId), []);
});

test('handleAdminAction "rating_toggle" then "rating_send" DMs only the selected submitters', async () => {
  const userId = 30018;
  const chatId = -30018;
  submitPlace(chatId, 1, 'artem', 'https://www.instagram.com/somewhere');
  submitPlace(chatId, 2, 'olya', 'https://www.instagram.com/elsewhere');

  const { ctx: drawCtx, rawCtx: drawRawCtx } = fakeCtx('administrator', userId);
  withCallbackData(drawRawCtx, `admin:draw:${chatId}`);
  await handleAdminAction(drawCtx); // records the draw both submitters belong to

  const { ctx: openCtx, rawCtx: openRawCtx, replies } = fakeCtx('administrator', userId);
  withCallbackData(openRawCtx, `admin:rating_targets:${chatId}`);
  await handleAdminAction(openCtx);
  assert.equal(replies.some((r) => /Обери, кому надіслати/.test(r)), true);

  const { ctx: toggleCtx, rawCtx: toggleRawCtx } = fakeCtx('administrator', userId);
  withCallbackData(toggleRawCtx, `admin:rating_toggle:${chatId}:1`);
  await handleAdminAction(toggleCtx);
  assert.deepEqual(getRatingSelection(userId), { chatId, selected: new Set([1]) });

  const { ctx: sendCtx, rawCtx: sendRawCtx, sentMessages } = fakeCtx('administrator', userId);
  withCallbackData(sendRawCtx, `admin:rating_send:${chatId}`);
  await handleAdminAction(sendCtx);

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].chatId, 1); // DMed the selected user's own chat id, not user 2
  assert.equal(getRatingSelection(userId), undefined); // selection cleared after sending

  const entries = listAdminActions(chatId);
  assert.deepEqual(entries.map((e) => e.action), ['draw', 'send_rating_survey']);
  assert.equal(entries[1].detail, 'targets:1');
});

test('handleAdminAction "rating_all" DMs every submitter of the latest draw', async () => {
  const userId = 30019;
  const chatId = -30019;
  submitPlace(chatId, 1, 'artem', 'https://www.instagram.com/somewhere');
  submitPlace(chatId, 2, 'olya', 'https://www.instagram.com/elsewhere');

  const { ctx: drawCtx, rawCtx: drawRawCtx } = fakeCtx('administrator', userId);
  withCallbackData(drawRawCtx, `admin:draw:${chatId}`);
  await handleAdminAction(drawCtx);

  const { ctx, rawCtx, sentMessages } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:rating_all:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(sentMessages.length, 2);
  assert.deepEqual(
    sentMessages.map((m) => m.chatId).sort(),
    [1, 2],
  );
  const entries = listAdminActions(chatId);
  assert.deepEqual(entries.map((e) => e.action), ['draw', 'send_rating_survey']);
  assert.equal(entries[1].detail, 'all');
});

test('a submitter blocked after the draw is neither DMed by "rating_all" nor offered as a toggle target', async () => {
  const userId = 30022;
  const chatId = -30022;
  submitPlace(chatId, 1, 'artem', 'https://www.instagram.com/somewhere');
  submitPlace(chatId, 2, 'olya', 'https://www.instagram.com/elsewhere');

  const { ctx: drawCtx, rawCtx: drawRawCtx } = fakeCtx('administrator', userId);
  withCallbackData(drawRawCtx, `admin:draw:${chatId}`);
  await handleAdminAction(drawCtx);

  blockUserFromGroup(chatId, 2, 'olya', userId); // blocked only after this draw

  const { ctx: openCtx, rawCtx: openRawCtx, replyButtonTexts } = fakeCtx('administrator', userId);
  withCallbackData(openRawCtx, `admin:rating_targets:${chatId}`);
  await handleAdminAction(openCtx);
  assert.equal(replyButtonTexts[0]?.some((label) => /olya/.test(label)), false); // not offered as a toggle target
  assert.equal(replyButtonTexts[0]?.some((label) => /artem/.test(label)), true); // the still-unblocked one still is

  const { ctx, rawCtx, sentMessages } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:rating_all:${chatId}`);
  await handleAdminAction(ctx);

  assert.deepEqual(sentMessages.map((m) => m.chatId), [1]); // only the still-unblocked submitter
});

test('handleAdminAction "rating_send" with a stale/empty selection shows an alert and sends nothing', async () => {
  const userId = 30020;
  const chatId = -30020;
  submitPlace(chatId, 1, 'artem', 'https://www.instagram.com/somewhere');

  const { ctx: drawCtx, rawCtx: drawRawCtx } = fakeCtx('administrator', userId);
  withCallbackData(drawRawCtx, `admin:draw:${chatId}`);
  await handleAdminAction(drawCtx);

  // No "rating"/"rating_toggle" tap happened first, so there is nothing selected for this user/chat.
  const { ctx, rawCtx, alerts, sentMessages } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:rating_send:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(alerts.some((a) => /Вибір застарів/.test(a)), true);
  assert.equal(sentMessages.length, 0);
  // Only the setup "draw" was logged — the rejected rating_send performed no mutation to log.
  assert.deepEqual(listAdminActions(chatId).map((e) => e.action), ['draw']);
});

test('handleAdminAction "rating_place" with no completed draw yet shows nothing to change', async () => {
  const userId = 30060;
  const chatId = -30060;

  const { ctx, rawCtx, replies } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:rating_place:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(replies.some((r) => /нема що змінювати/.test(r)), true);
});

test('handleAdminAction "rating_place" after a draw lists that week\'s submitters, none checked yet', async () => {
  const userId = 30061;
  const chatId = -30061;
  submitPlace(chatId, 1, 'artem', 'https://www.instagram.com/somewhere');
  submitPlace(chatId, 2, 'olya', 'https://www.instagram.com/elsewhere');

  const { ctx: drawCtx, rawCtx: drawRawCtx } = fakeCtx('administrator', userId);
  withCallbackData(drawRawCtx, `admin:draw:${chatId}`);
  await handleAdminAction(drawCtx);

  const { ctx, rawCtx, replies, replyButtonTexts } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:rating_place:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(replies.some((r) => /Куди пішли по факту/.test(r)), true);
  assert.equal(replies.some((r) => /змінено вручну/.test(r)), false);
  assert.equal(replyButtonTexts[0]?.some((label) => label.includes('artem') && label.startsWith('◻️')), true);
  assert.equal(replyButtonTexts[0]?.some((label) => label.includes('olya') && label.startsWith('◻️')), true);
  assert.equal(replyButtonTexts[0]?.some((label) => /Скинути/.test(label)), false); // nothing overridden yet
});

test('handleAdminAction "rating_place_set" redirects the survey to that submitter\'s place and logs it', async () => {
  const userId = 30062;
  const chatId = -30062;
  submitPlace(chatId, 1, 'artem', 'https://www.instagram.com/somewhere');
  submitPlace(chatId, 2, 'olya', 'https://www.instagram.com/elsewhere');

  const { ctx: drawCtx, rawCtx: drawRawCtx } = fakeCtx('administrator', userId);
  withCallbackData(drawRawCtx, `admin:draw:${chatId}`);
  await handleAdminAction(drawCtx);

  const { ctx, rawCtx, replies, replyButtonTexts } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:rating_place_set:${chatId}:2`);
  await handleAdminAction(ctx);

  assert.equal(replies.some((r) => /змінено вручну/.test(r)), true);
  assert.equal(replyButtonTexts[0]?.some((label) => label.includes('olya') && label.startsWith('✅')), true);
  assert.equal(replyButtonTexts[0]?.some((label) => /Скинути/.test(label)), true);

  const entries = listAdminActions(chatId);
  assert.deepEqual(entries.map((e) => e.action), ['draw', 'override_rating_place']);
  assert.equal(entries[1].detail, 'target:2');

  // The redirected place is what the actual survey send now uses too.
  const { ctx: sendCtx, rawCtx: sendRawCtx, sentMessages } = fakeCtx('administrator', userId);
  withCallbackData(sendRawCtx, `admin:rating_all:${chatId}`);
  await handleAdminAction(sendCtx);
  assert.equal(sentMessages.some((m) => /elsewhere/.test(m.text)), true);
});

test('handleAdminAction "rating_place_set" with a stale submitter id changes nothing and logs nothing', async () => {
  const userId = 30063;
  const chatId = -30063;
  submitPlace(chatId, 1, 'artem', 'https://www.instagram.com/somewhere');

  const { ctx: drawCtx, rawCtx: drawRawCtx } = fakeCtx('administrator', userId);
  withCallbackData(drawRawCtx, `admin:draw:${chatId}`);
  await handleAdminAction(drawCtx);

  const { ctx, rawCtx, replies } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:rating_place_set:${chatId}:999`); // never submitted to this draw
  await handleAdminAction(ctx);

  assert.equal(replies.some((r) => /змінено вручну/.test(r)), false);
  assert.deepEqual(listAdminActions(chatId).map((e) => e.action), ['draw']);
});

test('handleAdminAction "rating_place_reset" returns the survey to the draw winner and logs it', async () => {
  const userId = 30064;
  const chatId = -30064;
  submitPlace(chatId, 1, 'artem', 'https://www.instagram.com/somewhere');
  submitPlace(chatId, 2, 'olya', 'https://www.instagram.com/elsewhere');

  const { ctx: drawCtx, rawCtx: drawRawCtx } = fakeCtx('administrator', userId);
  withCallbackData(drawRawCtx, `admin:draw:${chatId}`);
  await handleAdminAction(drawCtx);

  const { ctx: setCtx, rawCtx: setRawCtx } = fakeCtx('administrator', userId);
  withCallbackData(setRawCtx, `admin:rating_place_set:${chatId}:2`);
  await handleAdminAction(setCtx);

  const { ctx, rawCtx, replies, replyButtonTexts } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:rating_place_reset:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(replies.some((r) => /змінено вручну/.test(r)), false);
  assert.equal(replyButtonTexts[0]?.some((label) => /Скинути/.test(label)), false);

  const entries = listAdminActions(chatId);
  assert.deepEqual(entries.map((e) => e.action), ['draw', 'override_rating_place', 'reset_rating_place']);
});

test('handleAdminAction refuses "rating_place"/"rating_place_set"/"rating_place_reset" for a demoted admin', async () => {
  const userId = 30065;
  const chatId = -30065;
  submitPlace(chatId, 1, 'artem', 'https://www.instagram.com/somewhere');

  const { ctx: drawCtx, rawCtx: drawRawCtx } = fakeCtx('administrator', userId);
  withCallbackData(drawRawCtx, `admin:draw:${chatId}`);
  await handleAdminAction(drawCtx);

  for (const data of [`admin:rating_place:${chatId}`, `admin:rating_place_set:${chatId}:1`, `admin:rating_place_reset:${chatId}`]) {
    const { ctx, rawCtx, alerts, replies } = fakeCtx('member', userId);
    withCallbackData(rawCtx, data);
    await handleAdminAction(ctx);

    assert.equal(alerts.some((a) => /Лише адміни/.test(a)), true);
    assert.equal(replies.length, 0);
  }
  assert.deepEqual(listAdminActions(chatId).map((e) => e.action), ['draw']); // nothing rating-place-related logged
});

test('handleAdminAction "stats_top" shows nothing-yet text when the group has never had a winning draw', async () => {
  const userId = 30023;
  const chatId = -30023;

  const { ctx, rawCtx, replies } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:stats_top:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(replies.some((r) => /жодного розіграшу/.test(r)), true);
  assert.deepEqual(listAdminActions(chatId), []); // pure navigation, never logged
});

test('handleAdminAction "stats_top" ranks winning places by win count, each as a clickable link', async () => {
  const userId = 30024;
  const chatId = -30024;
  submitPlace(chatId, 1, 'artem', 'https://www.instagram.com/somewhere');

  const { ctx: drawCtx, rawCtx: drawRawCtx } = fakeCtx('administrator', userId);
  withCallbackData(drawRawCtx, `admin:draw:${chatId}`);
  await handleAdminAction(drawCtx);

  const { ctx, rawCtx, replies } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:stats_top:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(
    replies.some((r) => r.includes('<a href="https://www.instagram.com/somewhere">somewhere</a> — 1×')),
    true,
  );
});

test('handleAdminAction "stats_top" gives two different generic-fallback places distinct, clickable hints', async () => {
  const userId = 30027;
  const chatId = -30027;
  submitPlace(chatId, 1, 'artem', 'https://expz.menu/11111111-1111-1111-1111-1111111111aa');

  const { ctx: drawCtx, rawCtx: drawRawCtx } = fakeCtx('administrator', userId);
  withCallbackData(drawRawCtx, `admin:draw:${chatId}`);
  await handleAdminAction(drawCtx);

  submitPlace(chatId, 2, 'olya', 'https://expz.menu/22222222-2222-2222-2222-2222222222bb');
  const { ctx: drawCtx2, rawCtx: drawRawCtx2 } = fakeCtx('administrator', userId);
  withCallbackData(drawRawCtx2, `admin:draw:${chatId}`);
  await handleAdminAction(drawCtx2);

  const { ctx, rawCtx, replies } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:stats_top:${chatId}`);
  await handleAdminAction(ctx);

  const text = replies.at(-1) ?? '';
  assert.match(text, /<a href="https:\/\/expz\.menu\/11111111-1111-1111-1111-1111111111aa">заклад \(…11aa\)<\/a>/);
  assert.match(text, /<a href="https:\/\/expz\.menu\/22222222-2222-2222-2222-2222222222bb">заклад \(…22bb\)<\/a>/);
});

test('handleAdminAction "stats_activity" lists top participants and top raters', async () => {
  const userId = 30025;
  const chatId = -30025;
  submitPlace(chatId, 1, 'artem', 'https://www.instagram.com/somewhere');
  submitPlace(chatId, 2, 'olya', 'https://www.instagram.com/elsewhere');

  const { ctx: drawCtx, rawCtx: drawRawCtx } = fakeCtx('administrator', userId);
  withCallbackData(drawRawCtx, `admin:draw:${chatId}`);
  await handleAdminAction(drawCtx);

  const { ctx, rawCtx, replies } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:stats_activity:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(replies.some((r) => /artem/.test(r) && /olya/.test(r)), true);
  assert.equal(replies.some((r) => /Ще ніхто не оцінював/.test(r)), true); // nobody rated yet
});

test('handleAdminAction "stats_ratings" shows nothing-yet text when the group has never had a winning draw', async () => {
  const userId = 30037;
  const chatId = -30037;

  const { ctx, rawCtx, replies } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:stats_ratings:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(replies.some((r) => /жодного розіграшу/.test(r)), true);
  assert.deepEqual(listAdminActions(chatId), []); // pure navigation, never logged
});

test('handleAdminAction "stats_ratings" shows the average (absent excluded) plus every voter (absent included)', async () => {
  const userId = 30038;
  const chatId = -30038;
  // All three submit that week — recordDraw persists every submitter's row to submissions_history
  // (not just the winner's), which is what the real rating survey targets: everyone who submitted
  // that week is asked to rate whichever place actually won.
  submitPlace(chatId, 1, 'artem', 'https://www.instagram.com/somewhere');
  submitPlace(chatId, 2, 'olya', 'https://www.instagram.com/elsewhere');
  submitPlace(chatId, 3, 'ivan', 'https://www.instagram.com/thirdplace');

  const { ctx: drawCtx, rawCtx: drawRawCtx } = fakeCtx('administrator', userId);
  withCallbackData(drawRawCtx, `admin:draw:${chatId}`);
  await handleAdminAction(drawCtx);

  const drawId = getLatestDraw(chatId)!.id;
  addOrUpdateRating(drawId, 1, 4);
  addOrUpdateRating(drawId, 2, 2);
  markAsAbsent(drawId, 3);

  const { ctx, rawCtx, replies } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:stats_ratings:${chatId}`);
  await handleAdminAction(ctx);

  const text = replies.at(-1) ?? '';
  assert.match(text, /середня 3\.0★ \(2\)/); // (4 + 2) / 2, the absent tap excluded from this average
  assert.match(text, /@artem — 4★/);
  assert.match(text, /@olya — 2★/);
  assert.match(text, /@ivan — 🙅 не був/); // still listed among the voters
});

test('handleAdminAction "stats_ratings" groups a repeat winner\'s two visits from the same person into one line, not two', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });

  const userId = 30046;
  const chatId = -30046;
  // Same place wins two separate weeks; the same person answers the survey differently each time
  // (skipped the first, went to the second) — this used to render as two bullets for "@artem" that
  // read like an accidental duplicate rather than two distinct visits.
  submitPlace(chatId, 1, 'artem', 'https://www.instagram.com/samespot');
  const { ctx: drawCtx1, rawCtx: drawRawCtx1 } = fakeCtx('administrator', userId);
  withCallbackData(drawRawCtx1, `admin:draw:${chatId}`);
  await handleAdminAction(drawCtx1);
  markAsAbsent(getLatestDraw(chatId)!.id, 1);

  t.mock.timers.tick(10_001); // past submitPlace's own resubmit cooldown
  submitPlace(chatId, 1, 'artem', 'https://www.instagram.com/samespot');
  const { ctx: drawCtx2, rawCtx: drawRawCtx2 } = fakeCtx('administrator', userId);
  withCallbackData(drawRawCtx2, `admin:draw:${chatId}`);
  await handleAdminAction(drawCtx2);
  addOrUpdateRating(getLatestDraw(chatId)!.id, 1, 4);

  const { ctx, rawCtx, replies } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:stats_ratings:${chatId}`);
  await handleAdminAction(ctx);

  const text = replies.at(-1) ?? '';
  const artemLines = text.split('\n').filter((line) => line.includes('@artem'));
  assert.equal(artemLines.length, 1); // one line, not one bullet per visit
  assert.match(artemLines[0], /4★ \(\d\d\.\d\d\)/);
  assert.match(artemLines[0], /🙅 не був \(\d\d\.\d\d\)/);
});

test('handleAdminAction "stats_ratings" keeps a place with one lucky vote out of the main ranking', async () => {
  const userId = 30047;
  const chatId = -30047;

  // "reliableplace" wins three separate weeks, rated 4★ by three different people — a real sample.
  for (const submitterId of [1, 2, 3]) {
    submitPlace(chatId, submitterId, `user${submitterId}`, 'https://www.instagram.com/reliableplace');
    const { ctx: drawCtx, rawCtx: drawRawCtx } = fakeCtx('administrator', userId);
    withCallbackData(drawRawCtx, `admin:draw:${chatId}`);
    await handleAdminAction(drawCtx);
    addOrUpdateRating(getLatestDraw(chatId)!.id, submitterId, 4);
  }

  // "luckyplace" wins once and gets a single 5★ — too small a sample to outrank the place above.
  submitPlace(chatId, 4, 'user4', 'https://www.instagram.com/luckyplace');
  const { ctx: drawCtx2, rawCtx: drawRawCtx2 } = fakeCtx('administrator', userId);
  withCallbackData(drawRawCtx2, `admin:draw:${chatId}`);
  await handleAdminAction(drawCtx2);
  addOrUpdateRating(getLatestDraw(chatId)!.id, 4, 5);

  const { ctx, rawCtx, replies } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:stats_ratings:${chatId}`);
  await handleAdminAction(ctx);

  const text = replies.at(-1) ?? '';
  const reliableHeader = text.indexOf('🏆 Рейтинг');
  const lowDataHeader = text.indexOf('📉 Мало даних');
  const reliablePlace = text.indexOf('reliableplace');
  const luckyPlace = text.indexOf('luckyplace');
  // Sections, not just sort order: the 5★-but-single-vote place sits under its own "мало даних"
  // heading, entirely below the 4★/3-votes place's ranked section, despite the higher raw average.
  assert.equal(reliableHeader > -1 && lowDataHeader > reliableHeader, true);
  assert.equal(reliablePlace > reliableHeader && reliablePlace < lowDataHeader, true);
  assert.equal(luckyPlace > lowDataHeader, true);
});

test('handleAdminAction "stats_ratings" paginates at 5 places per page with working ‹ Попередні / Наступні › buttons', async () => {
  const userId = 30048;
  const chatId = -30048;

  // 6 different winning places (each a single, unrated draw) -> 2 pages of 5 + 1.
  for (let i = 0; i < 6; i++) {
    submitPlace(chatId, i + 1, `user${i}`, `https://www.instagram.com/place${i}`);
    const { ctx: drawCtx, rawCtx: drawRawCtx } = fakeCtx('administrator', userId);
    withCallbackData(drawRawCtx, `admin:draw:${chatId}`);
    await handleAdminAction(drawCtx);
  }

  const {
    ctx: page0Ctx,
    rawCtx: page0RawCtx,
    replies: page0Replies,
    replyButtons: page0Buttons,
  } = fakeCtx('administrator', userId);
  withCallbackData(page0RawCtx, `admin:stats_ratings:${chatId}:0`);
  await handleAdminAction(page0Ctx);
  const page0Text = page0Replies.at(-1) ?? '';
  assert.match(page0Text, /стор\. 1\/2/);
  assert.equal((page0Text.match(/\d+\. <a href=/g) ?? []).length, 5);
  assert.deepEqual(page0Buttons[0]?.map((b) => b.text), ['Наступні ›', '‹ Назад']);

  const nextButton = page0Buttons[0]?.find((b) => b.text === 'Наступні ›');
  const {
    ctx: page1Ctx,
    rawCtx: page1RawCtx,
    replies: page1Replies,
    replyButtons: page1Buttons,
  } = fakeCtx('administrator', userId);
  withCallbackData(page1RawCtx, nextButton!.callback_data);
  await handleAdminAction(page1Ctx);
  const page1Text = page1Replies.at(-1) ?? '';
  assert.match(page1Text, /стор\. 2\/2/);
  assert.equal((page1Text.match(/\d+\. <a href=/g) ?? []).length, 1);
  assert.deepEqual(page1Buttons[0]?.map((b) => b.text), ['‹ Попередні', '‹ Назад']);
});

test('handleAdminAction "stats_ratings" ranks places by average rating, unrated places last', async () => {
  const userId = 30039;
  const chatId = -30039;

  // A different submitter per draw, not the same one resubmitting three times in a row — the
  // latter would trip submitPlace's own 10s rate limit (see CLAUDE.md's "Submission + public
  // announcement"), rejecting the 2nd/3rd change and leaving those draws with no real winner.
  submitPlace(chatId, 1, 'artem', 'https://www.instagram.com/lowrated');
  const { ctx: drawCtx1, rawCtx: drawRawCtx1 } = fakeCtx('administrator', userId);
  withCallbackData(drawRawCtx1, `admin:draw:${chatId}`);
  await handleAdminAction(drawCtx1);
  addOrUpdateRating(getLatestDraw(chatId)!.id, 1, 2);

  submitPlace(chatId, 2, 'olya', 'https://www.instagram.com/highrated');
  const { ctx: drawCtx2, rawCtx: drawRawCtx2 } = fakeCtx('administrator', userId);
  withCallbackData(drawRawCtx2, `admin:draw:${chatId}`);
  await handleAdminAction(drawCtx2);
  addOrUpdateRating(getLatestDraw(chatId)!.id, 2, 5);

  submitPlace(chatId, 3, 'ivan', 'https://www.instagram.com/neverrated');
  const { ctx: drawCtx3, rawCtx: drawRawCtx3 } = fakeCtx('administrator', userId);
  withCallbackData(drawRawCtx3, `admin:draw:${chatId}`);
  await handleAdminAction(drawCtx3);

  const { ctx, rawCtx, replies } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:stats_ratings:${chatId}`);
  await handleAdminAction(ctx);

  const text = replies.at(-1) ?? '';
  const highIndex = text.indexOf('highrated');
  const lowIndex = text.indexOf('lowrated');
  const neverIndex = text.indexOf('neverrated');
  assert.equal(highIndex > -1 && lowIndex > highIndex && neverIndex > lowIndex, true);
  assert.match(text, /ще немає оцінок/);
});

test('handleAdminAction "select" shows the hub with 4 category buttons, not individual actions', async () => {
  const userId = 30028;
  const chatId = -30028;

  const { ctx, rawCtx, replyButtonTexts } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:select:${chatId}`);
  await handleAdminAction(ctx);

  assert.deepEqual(replyButtonTexts[0], ['🔄 Цикл тижня', '🚫 Учасники', '⭐ Опитування', '🧪 Експериментальні функції']);
});

test('handleAdminAction "cycle" shows pause/draw/reopen/clearweek plus a back button, and is refused for a demoted admin', async () => {
  const userId = 30029;
  const chatId = -30029;
  lockSubmissions(chatId); // so "🔓 Відкрити прийом заявок" is present too

  const { ctx, rawCtx, replyButtonTexts } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:cycle:${chatId}`);
  await handleAdminAction(ctx);

  assert.deepEqual(replyButtonTexts[0], [
    '⏸ Призупинити цикл',
    '🔓 Відкрити прийом заявок',
    '🔀 Провести жеребкування зараз',
    '🧹 Скинути тиждень (без розіграшу)',
    '‹ Назад',
  ]);

  const { ctx: demotedCtx, rawCtx: demotedRawCtx, alerts, replies } = fakeCtx('member', userId);
  withCallbackData(demotedRawCtx, `admin:cycle:${chatId}`);
  await handleAdminAction(demotedCtx);
  assert.equal(alerts.some((a) => /Лише адміни/.test(a)), true);
  assert.equal(replies.length, 0);
});

test('handleAdminAction "experimental" shows a statistics entry and a back button', async () => {
  const userId = 30030;
  const chatId = -30030;

  const { ctx, rawCtx, replies, replyButtonTexts } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:experimental:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(replies.some((r) => /Експериментальні функції/.test(r)), true);
  assert.deepEqual(replyButtonTexts[0], [
    '📊 Статистика',
    '🗓 Опитування про час',
    '🩺 Діагностика планувальника',
    '📜 Лог дій адмінів',
    '‹ Назад',
  ]);
});

test('handleAdminAction "stats" back button returns to the experimental hub, not the main hub', async () => {
  const userId = 30031;
  const chatId = -30031;

  const { ctx, rawCtx, replyButtons } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:stats:${chatId}`);
  await handleAdminAction(ctx);

  const backButton = replyButtons[0]?.find((b) => b.text === '‹ Назад');
  assert.equal(backButton?.callback_data, `admin:experimental:${chatId}`);
});

test('handleAdminAction refuses "stats"/"stats_top"/"stats_activity"/"stats_ratings" for a demoted admin', async () => {
  const chatId = -30026;

  for (const data of [
    `admin:stats:${chatId}`,
    `admin:stats_top:${chatId}`,
    `admin:stats_activity:${chatId}`,
    `admin:stats_ratings:${chatId}`,
  ]) {
    const { ctx, rawCtx, alerts, replies } = fakeCtx('member', 30026);
    withCallbackData(rawCtx, data);
    await handleAdminAction(ctx);

    assert.equal(alerts.some((a) => /Лише адміни/.test(a)), true);
    assert.equal(replies.length, 0);
  }
});

test('handleAdminAction refuses "rating_toggle"/"rating_all"/"rating_send" for a demoted admin', async () => {
  const chatId = -30021;
  submitPlace(chatId, 1, 'artem', 'https://www.instagram.com/somewhere');

  const { ctx: drawCtx, rawCtx: drawRawCtx } = fakeCtx('administrator', 30021);
  withCallbackData(drawRawCtx, `admin:draw:${chatId}`);
  await handleAdminAction(drawCtx);

  for (const data of [`admin:rating_toggle:${chatId}:1`, `admin:rating_all:${chatId}`, `admin:rating_send:${chatId}`]) {
    const { ctx, rawCtx, alerts, sentMessages } = fakeCtx('member', 30021);
    withCallbackData(rawCtx, data);
    await handleAdminAction(ctx);

    assert.equal(alerts.some((a) => /Лише адміни/.test(a)), true);
    assert.equal(sentMessages.length, 0);
  }
  assert.deepEqual(listAdminActions(chatId).map((e) => e.action), ['draw']); // nothing rating-related logged
});

test('handleAdminAction "diagnostics" shows the "no tick yet" state and a back button to the experimental hub, refuses a demoted admin', async () => {
  const userId = 30032;
  const chatId = -30032;

  const { ctx, rawCtx, replies, replyButtons } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:diagnostics:${chatId}`);
  await handleAdminAction(ctx);

  // This test file's process never calls scheduler.ts's runSchedulerTick, so getLastTickAt() is
  // still null here — the neutral "not yet ticked" branch, not the 🔴 stuck one.
  assert.equal(replies.some((r) => /ще не було жодного тіка/.test(r)), true);
  assert.equal(replies.some((r) => /Розмір БД/.test(r)), true);
  const backButton = replyButtons[0]?.find((b) => b.text === '‹ Назад');
  assert.equal(backButton?.callback_data, `admin:experimental:${chatId}`);
  assert.deepEqual(listAdminActions(chatId), []); // pure navigation, never logged

  const { ctx: demotedCtx, rawCtx: demotedRawCtx, alerts, replies: demotedReplies } = fakeCtx('member', userId);
  withCallbackData(demotedRawCtx, `admin:diagnostics:${chatId}`);
  await handleAdminAction(demotedCtx);
  assert.equal(alerts.some((a) => /Лише адміни/.test(a)), true);
  assert.equal(demotedReplies.length, 0);
});

test('handleAdminAction "auditlog" shows an empty-log message when the chat has no admin_actions yet', async () => {
  const userId = 30033;
  const chatId = -30033;

  const { ctx, rawCtx, replies, replyButtons } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:auditlog:${chatId}:0`);
  await handleAdminAction(ctx);

  assert.equal(replies.some((r) => /Ще немає жодної дії в журналі/.test(r)), true);
  assert.deepEqual(replyButtons[0]?.map((b) => b.text), ['‹ Назад']);
});

test('handleAdminAction "auditlog" lists logged actions newest-first with actor/label/detail', async () => {
  const userId = 30034;
  const chatId = -30034;

  const { ctx: pauseCtx, rawCtx: pauseRawCtx } = fakeCtx('administrator', userId);
  withCallbackData(pauseRawCtx, `admin:pause:${chatId}`);
  await handleAdminAction(pauseCtx);

  const { ctx: resumeCtx, rawCtx: resumeRawCtx } = fakeCtx('administrator', userId);
  withCallbackData(resumeRawCtx, `admin:resume:${chatId}`);
  await handleAdminAction(resumeCtx);

  const { ctx, rawCtx, replies } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:auditlog:${chatId}:0`);
  await handleAdminAction(ctx);

  const text = replies.at(-1) ?? '';
  assert.match(text, /стор\. 1\/1/);
  // Newest (resume) first, oldest (pause) last.
  const resumeIndex = text.indexOf('Відновив цикл');
  const pauseIndex = text.indexOf('Призупинив цикл');
  assert.equal(resumeIndex >= 0 && pauseIndex >= 0 && resumeIndex < pauseIndex, true);
});

test('handleAdminAction "auditlog" resolves a target/targets id to @username instead of showing the raw id', async () => {
  const userId = 30044;
  const chatId = -30044;
  const targetUserId = 1;
  submitPlace(chatId, targetUserId, 'artem', 'https://www.instagram.com/somewhere');

  const { ctx: blockCtx, rawCtx: blockRawCtx } = fakeCtx('administrator', userId);
  withCallbackData(blockRawCtx, `admin:block:${chatId}:${targetUserId}`);
  await handleAdminAction(blockCtx);

  const { ctx, rawCtx, replies } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:auditlog:${chatId}:0`);
  await handleAdminAction(ctx);

  const text = replies.at(-1) ?? '';
  assert.match(text, /\(@artem\)/);
  assert.doesNotMatch(text, new RegExp(`target:${targetUserId}`));
});

test('handleAdminAction "auditlog" falls back to a bare id when no username can be resolved', async () => {
  const userId = 30045;
  const chatId = -30045;
  const targetUserId = 999999;

  const { ctx: blockCtx, rawCtx: blockRawCtx } = fakeCtx('administrator', userId);
  withCallbackData(blockRawCtx, `admin:block:${chatId}:${targetUserId}`);
  await handleAdminAction(blockCtx);

  const { ctx, rawCtx, replies } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:auditlog:${chatId}:0`);
  await handleAdminAction(ctx);

  const text = replies.at(-1) ?? '';
  assert.match(text, new RegExp(`\\(id${targetUserId}\\)`));
});

test('handleAdminAction "auditlog" paginates at 10 entries per page with working ‹ Новіші / Старіші › buttons', async () => {
  const userId = 30035;
  const chatId = -30035;

  // 12 logged actions (pause/resume alternating) -> 2 pages, 10 + 2.
  for (let i = 0; i < 12; i++) {
    const action = i % 2 === 0 ? 'pause' : 'resume';
    const { ctx, rawCtx } = fakeCtx('administrator', userId);
    withCallbackData(rawCtx, `admin:${action}:${chatId}`);
    await handleAdminAction(ctx);
  }

  const { ctx: page0Ctx, rawCtx: page0RawCtx, replies: page0Replies, replyButtons: page0Buttons } = fakeCtx(
    'administrator',
    userId,
  );
  withCallbackData(page0RawCtx, `admin:auditlog:${chatId}:0`);
  await handleAdminAction(page0Ctx);
  assert.match(page0Replies.at(-1) ?? '', /стор\. 1\/2/);
  assert.deepEqual(page0Buttons[0]?.map((b) => b.text), ['Старіші ›', '‹ Назад']);

  const nextButton = page0Buttons[0]?.find((b) => b.text === 'Старіші ›');
  const { ctx: page1Ctx, rawCtx: page1RawCtx, replies: page1Replies, replyButtons: page1Buttons } = fakeCtx(
    'administrator',
    userId,
  );
  withCallbackData(page1RawCtx, nextButton!.callback_data);
  await handleAdminAction(page1Ctx);
  assert.match(page1Replies.at(-1) ?? '', /стор\. 2\/2/);
  assert.deepEqual(page1Buttons[0]?.map((b) => b.text), ['‹ Новіші', '‹ Назад']);
});

test('handleAdminAction refuses "auditlog" for a demoted admin', async () => {
  const userId = 30036;
  const chatId = -30036;

  const { ctx, rawCtx, alerts, replies } = fakeCtx('member', userId);
  withCallbackData(rawCtx, `admin:auditlog:${chatId}:0`);
  await handleAdminAction(ctx);

  assert.equal(alerts.some((a) => /Лише адміни/.test(a)), true);
  assert.equal(replies.length, 0);
});

test('handleAdminAction "timeslot" shows the disabled-by-default state and a back button', async () => {
  const userId = 30050;
  const chatId = -30050;

  const { ctx, rawCtx, replies, replyButtons } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:timeslot:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(replies.some((r) => /Опитування про доступність/.test(r) && /Стан: вимкнено/.test(r)), true);
  const backButton = replyButtons[0]?.find((b) => b.text === '‹ Назад');
  assert.equal(backButton?.callback_data, `admin:experimental:${chatId}`);
});

test('a current admin tapping "timeslot_toggle" flips the flag and logs it', async () => {
  const userId = 30051;
  const chatId = -30051;
  assert.equal(isTimeSlotPollEnabled(chatId), false); // starts at the default (disabled)

  const { ctx, rawCtx, replies } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:timeslot_toggle:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(isTimeSlotPollEnabled(chatId), true);
  assert.equal(listAdminActions(chatId)[0]?.action, 'toggle_timeslot_poll');
  assert.equal(listAdminActions(chatId)[0]?.detail, 'on');
  assert.equal(replies.some((r) => /Стан: увімкнено/.test(r)), true); // re-renders the screen with the new state
});

test('handleAdminAction refuses "timeslot_toggle" for a demoted admin and leaves the flag untouched', async () => {
  const userId = 30052;
  const chatId = -30052;

  const { ctx, rawCtx, alerts } = fakeCtx('member', userId);
  withCallbackData(rawCtx, `admin:timeslot_toggle:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(alerts.some((a) => /Лише адміни/.test(a)), true);
  assert.equal(isTimeSlotPollEnabled(chatId), false);
  assert.deepEqual(listAdminActions(chatId), []);
});

test('handleAdminAction "draw" appends a day/time suggestion when the poll is enabled and answered', async () => {
  const userId = 30053;
  const chatId = -30053;
  setTimeSlotPollEnabled(chatId, true);
  submitPlace(chatId, 1, 'artem', 'https://www.instagram.com/somewhere');
  // Default timeSlotPollWeekdays is [6, 0] (Sat/Sun) — vote for Saturday.
  addOrUpdateTimeSlotResponse(chatId, 1, { days: [6], daysAny: false, times: ['10:00'], timesAny: false });

  const { ctx, rawCtx, sentMessages } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:draw:${chatId}`);
  await handleAdminAction(ctx);

  assert.match(sentMessages[0].text, /Як щодо суботи о 10:00 — вам підходить\?/);
});

test('handleAdminAction "draw" omits the suggestion line when the poll is disabled', async () => {
  const userId = 30054;
  const chatId = -30054;
  submitPlace(chatId, 1, 'artem', 'https://www.instagram.com/somewhere');
  addOrUpdateTimeSlotResponse(chatId, 1, { days: [6], daysAny: false, times: ['10:00'], timesAny: false });

  const { ctx, rawCtx, sentMessages } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `admin:draw:${chatId}`);
  await handleAdminAction(ctx);

  assert.equal(/Як щодо/.test(sentMessages[0].text), false);
});
