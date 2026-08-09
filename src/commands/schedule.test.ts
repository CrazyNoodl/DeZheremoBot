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
const { getSchedule, MAX_TIME_SLOTS, updateReminderSchedule, updateTimeSlotPollWeekdays } = await import('../services/scheduleService.js');
const { isGroupPaused, pauseGroup } = await import('../services/submissionService.js');
const { DEFAULT_SCHEDULE } = await import('../storage/groupSchedules.js');
const { hasFiredToday } = await import('../storage/firedEvents.js');
const { getKyivNow } = await import('../utils/kyivTime.js');
const { listAdminActions } = await import('../storage/auditLog.js');
const { setRatingSurveyEnabled } = await import('../services/ratingService.js');
const { setTimeSlotPollEnabled } = await import('../services/timeSlotPollService.js');

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

// --- 🗓 Опитування про час config screen/wizards ---

test('the "🗓 Опитування про час" summary row is hidden while the poll is disabled (default)', async () => {
  const userId = 20050;
  const chatId = -20050;

  const { ctx, rawCtx, replies, replyButtonTexts } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `sched:select:${chatId}`);
  await handleScheduleAction(ctx);

  assert.equal(replies.some((r) => /вимкнено \(умикається в \/admin → 🧪/.test(r)), true);
  assert.equal(
    replyButtonTexts.some((buttons) => buttons.includes('🗓 Опитування про час')),
    false,
  );
});

test('the "🗓 Опитування про час" summary row appears once enabled', async () => {
  const userId = 20051;
  const chatId = -20051;
  setTimeSlotPollEnabled(chatId, true);

  const { ctx, rawCtx, replyButtonTexts } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `sched:select:${chatId}`);
  await handleScheduleAction(ctx);

  assert.equal(
    replyButtonTexts.some((buttons) => buttons.includes('🗓 Опитування про час')),
    true,
  );
});

test('"sched:timeslot" shows the config screen with current days/hours', async () => {
  const userId = 20052;
  const chatId = -20052;

  const { ctx, rawCtx, replies } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `sched:timeslot:${chatId}`);
  await handleScheduleAction(ctx);

  assert.equal(replies.some((r) => /Опитування про час/.test(r) && /Сб, Нд/.test(r)), true);
});

test('handleScheduleAction refuses "timeslot_days" for a demoted admin and starts no wizard', async () => {
  const userId = 20053;
  const chatId = -20053;

  const { ctx, rawCtx, alerts } = fakeCtx('member', userId);
  withCallbackData(rawCtx, `sched:timeslot_days:${chatId}`);
  await handleScheduleAction(ctx);

  assert.equal(alerts.some((a) => /Лише адміни/.test(a)), true);
  assert.equal(getScheduleEditState(userId), undefined);
});

test('toggling a day via "tsday" then finishing via "tsdays_done" applies the change', async () => {
  const userId = 20054;
  const chatId = -20054;

  const { ctx, rawCtx } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `sched:timeslot_days:${chatId}`);
  await handleScheduleAction(ctx);

  withCallbackData(rawCtx, 'sched:tsday:1'); // Monday, not in the default [6, 0]
  await handleScheduleAction(ctx);

  withCallbackData(rawCtx, 'sched:tsdays_done');
  await handleScheduleAction(ctx);

  assert.deepEqual(getSchedule(chatId).timeSlotPollWeekdays.sort(), [0, 1, 6]);
  assert.equal(getScheduleEditState(userId), undefined); // wizard state cleared, landed on config screen
  assert.equal(listAdminActions(chatId)[0]?.action, 'edit_timeslot_days');
});

test('"tsdays_done" with an empty selection is rejected with an alert, before any mutation', async () => {
  const userId = 20055;
  const chatId = -20055;
  setScheduleEditState(userId, { flow: 'timeslot_days', chatId, selected: new Set() });

  const { ctx, rawCtx, alerts } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, 'sched:tsdays_done');
  await handleScheduleAction(ctx);

  assert.equal(alerts.some((a) => /хоча б один день/.test(a)), true);
  assert.deepEqual(getSchedule(chatId), DEFAULT_SCHEDULE);
});

test('"tsdays_done" rejects a selection that includes the current deadline day, keeping the toggle screen', async () => {
  const userId = 20056;
  const chatId = -20056;
  // DEFAULT_SCHEDULE's deadlineWeekday is Friday (5).
  setScheduleEditState(userId, { flow: 'timeslot_days', chatId, selected: new Set([5, 6]) });

  const { ctx, rawCtx, replies } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, 'sched:tsdays_done');
  await handleScheduleAction(ctx);

  assert.equal(replies.some((r) => /День дедлайну не може бути серед днів опитування/.test(r)), true);
  assert.deepEqual(getSchedule(chatId).timeSlotPollWeekdays, DEFAULT_SCHEDULE.timeSlotPollWeekdays);
  assert.deepEqual(listAdminActions(chatId), []);
});

test('"back" from the timeslot-days wizard lands on the config screen, not the main summary', async () => {
  const userId = 20057;
  const chatId = -20057;
  setScheduleEditState(userId, { flow: 'timeslot_days', chatId, selected: new Set([6, 0]) });

  const { ctx, rawCtx, replies } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, 'sched:back');
  await handleScheduleAction(ctx);

  assert.equal(getScheduleEditState(userId), undefined);
  assert.equal(replies.some((r) => /Опитування про час/.test(r)), true);
  assert.equal(replies.some((r) => /Розклад цієї групи/.test(r)), false);
});

test('"sched:timeslot_times" then adding a time via text applies it and returns to the list', async () => {
  const userId = 20058;
  const chatId = -20058;

  const { ctx, rawCtx, replies } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, `sched:timeslot_times:${chatId}`);
  await handleScheduleAction(ctx);

  withCallbackData(rawCtx, 'sched:tstime_add');
  await handleScheduleAction(ctx);

  const handled = await handleScheduleTextStep(ctx, userId, '09:00');
  assert.equal(handled, true);

  const state = getScheduleEditState(userId);
  assert.ok(state?.flow === 'timeslot_times' && state.step === 'list');
  if (state?.flow === 'timeslot_times' && state.step === 'list') {
    // Default times are 10:00/10:30/11:00 — the new one is inserted in sorted order.
    assert.deepEqual(state.times, ['09:00', '10:00', '10:30', '11:00']);
  }
  assert.equal(replies.some((r) => /09:00/.test(r)), true);
});

test('adding an invalid time reprompts without mutating the in-progress list', async () => {
  const userId = 20059;
  const chatId = -20059;
  setScheduleEditState(userId, { flow: 'timeslot_times', step: 'add', chatId, times: ['10:00'] });

  const { ctx, replies } = fakeCtx('administrator', userId);
  const handled = await handleScheduleTextStep(ctx, userId, 'nope');

  assert.equal(handled, true);
  assert.equal(replies.some((r) => /Невірний формат/.test(r)), true);
  const state = getScheduleEditState(userId);
  assert.ok(state?.flow === 'timeslot_times' && state.step === 'add');
});

test('adding a time already in the list reprompts instead of adding a duplicate', async () => {
  const userId = 20060;
  const chatId = -20060;
  setScheduleEditState(userId, { flow: 'timeslot_times', step: 'add', chatId, times: ['10:00'] });

  const { ctx, replies } = fakeCtx('administrator', userId);
  const handled = await handleScheduleTextStep(ctx, userId, '10:00');

  assert.equal(handled, true);
  assert.equal(replies.some((r) => /вже є в списку/.test(r)), true);
});

test('"tstime_add" at MAX_TIME_SLOTS is rejected inline instead of starting the text prompt', async () => {
  const userId = 20061;
  const chatId = -20061;
  const times = Array.from({ length: MAX_TIME_SLOTS }, (_, i) => `1${i}:00`);
  setScheduleEditState(userId, { flow: 'timeslot_times', step: 'list', chatId, times });

  const { ctx, rawCtx, replies } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, 'sched:tstime_add');
  await handleScheduleAction(ctx);

  assert.equal(replies.some((r) => new RegExp(`максимум ${MAX_TIME_SLOTS}`).test(r)), true);
  const state = getScheduleEditState(userId);
  assert.ok(state?.flow === 'timeslot_times' && state.step === 'list'); // still on the list, no text prompt started
});

test('"tstime_remove" removes the given index from the in-progress list', async () => {
  const userId = 20062;
  const chatId = -20062;
  setScheduleEditState(userId, { flow: 'timeslot_times', step: 'list', chatId, times: ['10:00', '10:30', '11:00'] });

  const { ctx, rawCtx } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, 'sched:tstime_remove:1'); // removes '10:30'
  await handleScheduleAction(ctx);

  const state = getScheduleEditState(userId);
  assert.ok(state?.flow === 'timeslot_times' && state.step === 'list');
  if (state?.flow === 'timeslot_times' && state.step === 'list') {
    assert.deepEqual(state.times, ['10:00', '11:00']);
  }
});

test('"tstimes_done" persists the in-progress list and logs the audit action', async () => {
  const userId = 20063;
  const chatId = -20063;
  setScheduleEditState(userId, { flow: 'timeslot_times', step: 'list', chatId, times: ['09:00'] });

  const { ctx, rawCtx } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, 'sched:tstimes_done');
  await handleScheduleAction(ctx);

  assert.deepEqual(getSchedule(chatId).timeSlotPollTimes, ['09:00']);
  assert.equal(getScheduleEditState(userId), undefined);
  assert.equal(listAdminActions(chatId)[0]?.action, 'edit_timeslot_times');
  assert.equal(listAdminActions(chatId)[0]?.detail, 'times:09:00');
});

test('"back" from the times-list step lands on the config screen without persisting in-progress changes', async () => {
  const userId = 20064;
  const chatId = -20064;
  setScheduleEditState(userId, { flow: 'timeslot_times', step: 'list', chatId, times: ['09:00'] });

  const { ctx, rawCtx, replies } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, 'sched:back');
  await handleScheduleAction(ctx);

  assert.equal(getScheduleEditState(userId), undefined);
  assert.equal(replies.some((r) => /Опитування про час/.test(r)), true);
  // Never called tstimes_done, so the default times are still whatever they were before.
  assert.deepEqual(getSchedule(chatId).timeSlotPollTimes, DEFAULT_SCHEDULE.timeSlotPollTimes);
});

test('"back" from the "add a time" text-prompt step returns to the times-list, not the config screen', async () => {
  const userId = 20065;
  const chatId = -20065;
  setScheduleEditState(userId, { flow: 'timeslot_times', step: 'add', chatId, times: ['09:00'] });

  const { ctx, rawCtx } = fakeCtx('administrator', userId);
  withCallbackData(rawCtx, 'sched:back');
  await handleScheduleAction(ctx);

  const state = getScheduleEditState(userId);
  assert.ok(state?.flow === 'timeslot_times' && state.step === 'list');
  if (state?.flow === 'timeslot_times' && state.step === 'list') {
    assert.deepEqual(state.times, ['09:00']); // kept, not discarded
  }
});

test('handleScheduleAction refuses "tsdays_done" once the user is no longer admin, applying nothing', async () => {
  const userId = 20066;
  const chatId = -20066;
  setScheduleEditState(userId, { flow: 'timeslot_days', chatId, selected: new Set([1]) });

  const { ctx, rawCtx, alerts } = fakeCtx('member', userId);
  withCallbackData(rawCtx, 'sched:tsdays_done');
  await handleScheduleAction(ctx);

  assert.equal(alerts.some((a) => /Лише адміни/.test(a)), true);
  assert.deepEqual(getSchedule(chatId).timeSlotPollWeekdays, DEFAULT_SCHEDULE.timeSlotPollWeekdays);
  assert.equal(getScheduleEditState(userId), undefined);
});

test('updateDeadlineSchedule\'s new conflict check is reachable end-to-end via the deadline wizard', async () => {
  const userId = 20067;
  const chatId = -20067;
  updateTimeSlotPollWeekdays(chatId, [6, 0]);
  setScheduleEditState(userId, { flow: 'deadline', step: 'lockTime', chatId, weekday: 6 });

  const { ctx } = fakeCtx('administrator', userId);
  // Advances to drawTime step first, then the actual conflict check fires on that step's submit.
  await handleScheduleTextStep(ctx, userId, '18:00');
  const handled = await handleScheduleTextStep(ctx, userId, '18:15');

  assert.equal(handled, true);
  assert.equal(getSchedule(chatId).deadlineWeekday, DEFAULT_SCHEDULE.deadlineWeekday); // unchanged — Sat(6) is in timeSlotPollWeekdays
  assert.deepEqual(listAdminActions(chatId), []);
});
