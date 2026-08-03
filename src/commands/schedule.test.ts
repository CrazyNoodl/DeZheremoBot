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
const { setRatingSurveyEnabled } = await import('../services/ratingService.js');

function fakeCtx(status: string, userId: number) {
  const replies: string[] = [];
  const alerts: string[] = [];
  const sentMessages: { chatId: number; text: string; extra?: object }[] = [];
  const replyButtonTexts: string[][] = [];
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
    reply: async (
      text: string,
      extra?: { reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } },
    ) => {
      replies.push(text);
      const buttons = (extra?.reply_markup?.inline_keyboard ?? []).flat();
      replyButtonTexts.push(buttons.map((b) => b.text));
      return { message_id: 1 };
    },
    answerCbQuery: async (text?: string, extra?: { show_alert?: boolean }) => {
      if (extra?.show_alert && text) alerts.push(text);
    },
  };
  return { ctx: ctx as unknown as Context, rawCtx: ctx, replies, alerts, sentMessages, replyButtonTexts };
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
  // Mirrors scheduler.ts's own FINAL_REMINDER_POOL — sendTaggedReminder always uses the "final"
  // wording pool, randomized, so this checks pool membership rather than one fixed phrase.
  const finalReminderTexts = [
    'ДеЖеремо цього тижня! Хто ще не встиг — тисни кнопку 👇',
    'Наближається дедлайн — хто ще не встиг, тисни кнопку 👇',
    'Останній шанс запропонувати заклад цього тижня — тисни кнопку 👇',
  ];
  assert.ok(finalReminderTexts.some((t) => sentMessages[0].text.includes(t)));
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

// The enable/disable toggle moved to /admin's own "⭐ Опитування" category (live-cycle control,
// like pause/resume) — see commands/admin.test.ts's "rating_survey_toggle" coverage. This screen
// now only shows the (read-only) state for context and lets an admin change day/time.
test('"sched:rating" shows the day/time sub-screen without a toggle button', async () => {
  const userId = 20030;
  const chatId = -20030;

  const { ctx, rawCtx, replies } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `sched:rating:${chatId}`);
  await handleScheduleAction(ctx);

  assert.equal(replies.some((r) => /з оцінкою закладу/.test(r)), true);
  assert.equal(replies.some((r) => /Стан: увімкнено/.test(r)), true);
});

test('the "⭐ Опитування" summary button is hidden while the survey is disabled for that group', async () => {
  const userId = 20040;
  const chatId = -20040;
  setRatingSurveyEnabled(chatId, false);

  const { ctx, rawCtx, replies, replyButtonTexts } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `sched:select:${chatId}`);
  await handleScheduleAction(ctx);

  assert.equal(replies.some((r) => /вимкнено \(умикається в \/admin/.test(r)), true);
  assert.equal(
    replyButtonTexts.some((buttons) => buttons.includes('⭐ Опитування')),
    false,
  );
});

test('the "⭐ Опитування" summary button is shown once the survey is enabled again', async () => {
  const userId = 20041;
  const chatId = -20041;
  setRatingSurveyEnabled(chatId, false);
  setRatingSurveyEnabled(chatId, true);

  const { ctx, rawCtx, replyButtonTexts } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `sched:select:${chatId}`);
  await handleScheduleAction(ctx);

  assert.equal(
    replyButtonTexts.some((buttons) => buttons.includes('⭐ Опитування')),
    true,
  );
});

test('the rating sub-screen hides "✏️ Змінити день і час" while the survey is disabled', async () => {
  const userId = 20042;
  const chatId = -20042;
  setRatingSurveyEnabled(chatId, false);

  const { ctx, rawCtx, replyButtonTexts } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `sched:rating:${chatId}`);
  await handleScheduleAction(ctx);

  assert.equal(
    replyButtonTexts.some((buttons) => buttons.includes('✏️ Змінити день і час')),
    false,
  );
});

test('handleScheduleAction refuses "rating_edit" for a demoted admin and starts no wizard', async () => {
  const userId = 20032;
  const chatId = -20032;

  const { ctx, rawCtx, alerts } = fakeCtx('member', userId);
  withCallbackData(rawCtx, `sched:rating_edit:${chatId}`);
  await handleScheduleAction(ctx);

  assert.equal(alerts.some((a) => /Лише адміни/.test(a)), true);
  assert.equal(getScheduleEditState(userId), undefined);
});

test('a current admin tapping "rating_edit" then a weekday starts the rating time-entry step', async () => {
  const userId = 20033;
  const chatId = -20033;

  const { ctx, rawCtx } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `sched:rating_edit:${chatId}`);
  await handleScheduleAction(ctx);

  let state = getScheduleEditState(userId);
  assert.deepEqual(state, { flow: 'rating', step: 'weekday', chatId });

  withCallbackData(rawCtx, 'sched:day:2');
  await handleScheduleAction(ctx);

  state = getScheduleEditState(userId);
  assert.deepEqual(state, { flow: 'rating', step: 'time', chatId, weekday: 2 });
});

test('handleScheduleTextStep applies a rating day/time change and lands back on the rating screen', async () => {
  const userId = 20034;
  const chatId = -20034;
  setScheduleEditState(userId, { flow: 'rating', step: 'time', chatId, weekday: 4 });

  const { ctx, replies } = fakeCtx('administrator', userId);
  const handled = await handleScheduleTextStep(ctx, userId, '16:30');

  assert.equal(handled, true);
  const schedule = getSchedule(chatId);
  assert.equal(schedule.ratingSurveyWeekday, 4);
  assert.equal(schedule.ratingSurveyTime, '16:30');
  assert.equal(getScheduleEditState(userId), undefined); // wizard state cleared, not left dangling
  assert.equal(listAdminActions(chatId)[0]?.action, 'edit_rating');
  assert.equal(listAdminActions(chatId)[0]?.detail, 'weekday:4 time:16:30');
  assert.equal(replies.some((r) => /з оцінкою закладу/.test(r)), true); // landed on the rating screen, not the main summary
});

test('handleScheduleTextStep rejects an invalid rating time without mutating the schedule', async () => {
  const userId = 20035;
  const chatId = -20035;
  setScheduleEditState(userId, { flow: 'rating', step: 'time', chatId, weekday: 1 });

  const { ctx } = fakeCtx('administrator', userId);
  const handled = await handleScheduleTextStep(ctx, userId, 'nope');

  assert.equal(handled, true);
  assert.deepEqual(listAdminActions(chatId), []);
  assert.equal(getSchedule(chatId).ratingSurveyWeekday, DEFAULT_SCHEDULE.ratingSurveyWeekday);
});

test('"back" from the rating weekday step lands on the rating screen, not the main summary', async () => {
  const userId = 20037;
  const chatId = -20037;
  setScheduleEditState(userId, { flow: 'rating', step: 'weekday', chatId });

  const { ctx, rawCtx, replies } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, 'sched:back');
  await handleScheduleAction(ctx);

  assert.equal(getScheduleEditState(userId), undefined);
  assert.equal(replies.some((r) => /з оцінкою закладу/.test(r)), true);
  assert.equal(replies.some((r) => /Розклад цієї групи/.test(r)), false);
});

test('"back" from the rating time step lands on the rating screen, not the main summary', async () => {
  const userId = 20038;
  const chatId = -20038;
  setScheduleEditState(userId, { flow: 'rating', step: 'time', chatId, weekday: 3 });

  const { ctx, rawCtx, replies } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, 'sched:back');
  await handleScheduleAction(ctx);

  assert.equal(getScheduleEditState(userId), undefined);
  assert.equal(replies.some((r) => /з оцінкою закладу/.test(r)), true);
  assert.equal(replies.some((r) => /Розклад цієї групи/.test(r)), false);
});

test('"back" from the deadline wizard still lands on the main summary (unlike rating)', async () => {
  const userId = 20039;
  const chatId = -20039;
  setScheduleEditState(userId, { flow: 'deadline', step: 'weekday', chatId });

  const { ctx, rawCtx, replies } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, 'sched:back');
  await handleScheduleAction(ctx);

  assert.equal(getScheduleEditState(userId), undefined);
  assert.equal(replies.some((r) => /Розклад цієї групи/.test(r)), true);
});

test('handleScheduleTextStep refuses to apply a rating time change once the user is no longer admin', async () => {
  const userId = 20036;
  const chatId = -20036;
  setScheduleEditState(userId, { flow: 'rating', step: 'time', chatId, weekday: 1 });

  const { ctx, replies } = fakeCtx('member', userId);
  const handled = await handleScheduleTextStep(ctx, userId, '16:00');

  assert.equal(handled, true);
  assert.equal(replies.some((r) => /більше не адмін/.test(r)), true);
  assert.deepEqual(listAdminActions(chatId), []);
  assert.equal(getScheduleEditState(userId), undefined);
});
