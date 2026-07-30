import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Context } from 'telegraf';

// commands/schedule.ts pulls in storage/groupSchedules.ts (via services/scheduleService.ts), which
// loads its state from DEZHEREMO_DATA_DIR once at import time — same isolation approach as
// services/scheduleService.test.ts and storage/groupSchedules.test.ts.
process.env.DEZHEREMO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dzb-schedule-cmd-'));
const { handleScheduleAction, handleScheduleTextStep } = await import('./schedule.js');
const { getScheduleEditState, setScheduleEditState } = await import('../storage/scheduleEditState.js');
const { getSchedule, updateReminderSchedule } = await import('../services/scheduleService.js');
const { isGroupPaused, pauseGroup } = await import('../services/submissionService.js');
const { DEFAULT_SCHEDULE } = await import('../storage/groupSchedules.js');
const { hasFiredToday } = await import('../storage/firedEvents.js');
const { getKyivNow } = await import('../kyivTime.js');
const { listAdminActions } = await import('../storage/auditLog.js');

function fakeCtx(status: string, userId: number) {
  const replies: string[] = [];
  const alerts: string[] = [];
  const sentMessages: { chatId: number; text: string; extra?: object }[] = [];
  const ctx = {
    from: { id: userId },
    chat: { id: userId },
    botInfo: { username: 'TestBot' },
    callbackQuery: undefined as { data: string; message?: { chat: { id: number }; message_id: number } } | undefined,
    telegram: {
      getChatMember: async () => {
        if (status === 'throw') throw new Error('boom');
        return { status };
      },
      editMessageText: async () => {
        throw new Error('no message tracked to edit in this test');
      },
      getChatMembersCount: async () => 1,
      sendMessage: async (chatId: number, text: string, extra?: object) => {
        sentMessages.push({ chatId, text, extra });
        return { message_id: 999 };
      },
    },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: 1 };
    },
    answerCbQuery: async (text?: string, extra?: { show_alert?: boolean }) => {
      if (extra?.show_alert && text) alerts.push(text);
    },
  };
  return { ctx: ctx as unknown as Context, rawCtx: ctx, replies, alerts, sentMessages };
}

function withCallbackData(rawCtx: { callbackQuery?: { data: string } }, data: string) {
  rawCtx.callbackQuery = { data };
}

// These cover the gap where handleScheduleAction only ever re-verified admin status for the
// `select` action — every other action (edit_reminder/edit_deadline/reset/day/days_done/back)
// trusted the chatId embedded in callback_data or tracked edit state without checking whether the
// user pressing the button is still an admin of that group right now.
test('handleScheduleAction refuses "reset" for a user who is no longer an admin', async () => {
  const userId = 20001;
  const chatId = -20001;
  updateReminderSchedule(chatId, [2, 4], '09:00'); // non-default, to prove reset never runs

  const { ctx, rawCtx, alerts } = fakeCtx('member', userId);
  withCallbackData(rawCtx, `sched:reset:${chatId}`);
  await handleScheduleAction(ctx);

  assert.equal(alerts.some((a) => /Лише адміни/.test(a)), true);
  assert.deepEqual(getSchedule(chatId), { ...DEFAULT_SCHEDULE, reminderWeekdays: [2, 4], reminderTime: '09:00' });
  assert.deepEqual(listAdminActions(chatId), []);
});

test('handleScheduleAction refuses "edit_reminder" for a demoted admin and clears any stale edit state', async () => {
  const userId = 20002;
  const chatId = -20002;
  setScheduleEditState(userId, { flow: 'deadline', step: 'weekday', chatId });

  const { ctx, rawCtx } = fakeCtx('member', userId);
  withCallbackData(rawCtx, `sched:edit_reminder:${chatId}`);
  await handleScheduleAction(ctx);

  assert.equal(getScheduleEditState(userId), undefined);
});

test('handleScheduleAction refuses to continue an in-progress wizard once the user is no longer admin', async () => {
  const userId = 20003;
  const chatId = -20003;
  setScheduleEditState(userId, { flow: 'reminder', step: 'weekdays', chatId, selected: new Set([1]) });

  const { ctx, rawCtx } = fakeCtx('member', userId);
  withCallbackData(rawCtx, 'sched:day:3');
  await handleScheduleAction(ctx);

  assert.equal(getScheduleEditState(userId), undefined);
});

test('handleScheduleAction still lets a current admin continue an in-progress wizard', async () => {
  const userId = 20004;
  const chatId = -20004;
  setScheduleEditState(userId, { flow: 'reminder', step: 'weekdays', chatId, selected: new Set([1]) });

  const { ctx, rawCtx } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, 'sched:day:3');
  await handleScheduleAction(ctx);

  const state = getScheduleEditState(userId);
  assert.ok(state?.flow === 'reminder' && state.step === 'weekdays');
  if (state?.flow === 'reminder' && state.step === 'weekdays') {
    assert.deepEqual(Array.from(state.selected).sort(), [1, 3]);
  }
});

test('handleScheduleAction still refuses "select" for a non-admin (pre-existing behavior)', async () => {
  const userId = 20005;
  const chatId = -20005;

  const { ctx, rawCtx, alerts } = fakeCtx('left', userId);
  withCallbackData(rawCtx, `sched:select:${chatId}`);
  await handleScheduleAction(ctx);

  assert.equal(alerts.some((a) => /Лише адміни/.test(a)), true);
});

test('handleScheduleAction refuses "remind" for a user who is no longer an admin and sends nothing', async () => {
  const userId = 20020;
  const chatId = -20020;

  const { ctx, rawCtx, alerts, sentMessages } = fakeCtx('member', userId);
  withCallbackData(rawCtx, `sched:remind:${chatId}`);
  await handleScheduleAction(ctx);

  assert.equal(alerts.some((a) => /Лише адміни/.test(a)), true);
  assert.deepEqual(sentMessages, []);
  assert.deepEqual(listAdminActions(chatId), []);
});

test('handleScheduleAction sends a tagged reminder and marks it fired when a current admin taps "remind"', async () => {
  const userId = 20021;
  const chatId = -20021;

  const { ctx, rawCtx, sentMessages } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `sched:remind:${chatId}`);
  await handleScheduleAction(ctx);

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].chatId, chatId);
  assert.match(sentMessages[0].text, /ДеЖеремо цього тижня/);
  assert.equal(hasFiredToday(chatId, 'reminder', getKyivNow().date), true);
  assert.equal(listAdminActions(chatId)[0]?.action, 'remind');
});

test('"reset" does not clear a group\'s paused state — pause is independent of schedule config', async () => {
  const userId = 20010;
  const chatId = -20010;
  pauseGroup(chatId);

  const { ctx, rawCtx } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `sched:reset:${chatId}`);
  await handleScheduleAction(ctx);

  assert.deepEqual(getSchedule(chatId), DEFAULT_SCHEDULE);
  assert.equal(isGroupPaused(chatId), true);
  assert.equal(listAdminActions(chatId)[0]?.action, 'reset_schedule');
});

test('handleScheduleTextStep refuses to apply a time change once the user is no longer admin', async () => {
  const userId = 20006;
  const chatId = -20006;
  setScheduleEditState(userId, { flow: 'reminder', step: 'time', chatId, weekdays: [1, 3] });

  const { ctx, replies } = fakeCtx('member', userId);
  const handled = await handleScheduleTextStep(ctx, userId, '11:00');

  assert.equal(handled, true);
  assert.equal(replies.some((r) => /більше не адмін/.test(r)), true);
  assert.deepEqual(getSchedule(chatId), DEFAULT_SCHEDULE);
  assert.equal(getScheduleEditState(userId), undefined);
  assert.deepEqual(listAdminActions(chatId), []);
});

test('handleScheduleTextStep applies a time change when the user is still admin', async () => {
  const userId = 20007;
  const chatId = -20007;
  setScheduleEditState(userId, { flow: 'reminder', step: 'time', chatId, weekdays: [1, 3] });

  const { ctx } = fakeCtx('administrator', userId);
  const handled = await handleScheduleTextStep(ctx, userId, '11:00');

  assert.equal(handled, true);
  assert.deepEqual(getSchedule(chatId), { ...DEFAULT_SCHEDULE, reminderWeekdays: [1, 3], reminderTime: '11:00' });

  const [entry] = listAdminActions(chatId);
  assert.equal(entry.action, 'edit_reminder');
  assert.equal(entry.detail, 'days:1,3 time:11:00');
});

test('handleScheduleTextStep does not log an audit entry for an invalid time (no mutation happened)', async () => {
  const userId = 20008;
  const chatId = -20008;
  setScheduleEditState(userId, { flow: 'reminder', step: 'time', chatId, weekdays: [1, 3] });

  const { ctx } = fakeCtx('administrator', userId);
  const handled = await handleScheduleTextStep(ctx, userId, 'not-a-time');

  assert.equal(handled, true);
  assert.deepEqual(listAdminActions(chatId), []);
});
