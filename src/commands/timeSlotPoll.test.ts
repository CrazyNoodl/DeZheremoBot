import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Context } from 'telegraf';

// commands/timeSlotPoll.ts pulls in storage/groupSchedules.ts (via services/scheduleService.ts),
// which loads its state from DEZHEREMO_DATA_DIR once at import time — same isolation approach as
// commands/schedule.test.ts.
process.env.DEZHEREMO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dzb-timeslotpoll-cmd-'));
const { handleTimeSlotPollAction, maybeOfferTimeSlotPoll } = await import('./timeSlotPoll.js');
const { updateTimeSlotPollTimes, updateTimeSlotPollWeekdays } = await import('../services/scheduleService.js');
const { setTimeSlotPollEnabled } = await import('../services/timeSlotPollService.js');
const { blockUserFromGroup, lockSubmissions, pauseGroup } = await import('../services/submissionService.js');
const { addOrUpdateTimeSlotResponse, getTimeSlotResponse } = await import('../storage/timeSlotResponses.js');
const { getTimeSlotWizardState } = await import('../storage/timeSlotWizardState.js');
const { setMenuMessage } = await import('../storage/menuMessages.js');

function fakeCtx(status: string, userId: number, opts: { callbackData?: string; tappedMessageId?: number } = {}) {
  const replies: string[] = [];
  const alerts: Array<{ text?: string; show_alert?: boolean }> = [];
  const ctx = {
    from: { id: userId },
    chat: { id: userId }, // private chat id, distinct per test via userId
    callbackQuery: {
      data: opts.callbackData ?? 'tsp:open',
      ...(opts.tappedMessageId !== undefined ? { message: { message_id: opts.tappedMessageId } } : {}),
    },
    telegram: {
      getChatMember: async () => {
        if (status === 'throw') throw new Error('boom');
        return { status };
      },
      editMessageText: async () => {
        throw new Error('no message tracked to edit in this test'); // forces the fallback-to-reply path every time
      },
    },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: 42 };
    },
    answerCbQuery: async (text?: string, extra?: { show_alert?: boolean }) => {
      alerts.push({ text, show_alert: extra?.show_alert });
    },
  };
  return { ctx: ctx as unknown as Context, replies, alerts };
}

// Every test below is scoped to its own chatId/userId pair, so a fresh setMenuMessage tracks a
// card for that private chat the same way commands/menu.ts's own SUBMIT_ACTION flow would have
// already done before this ever triggers.
function track(userId: number, groupChatId: number): void {
  setMenuMessage(userId, userId, 999, groupChatId);
}

test('maybeOfferTimeSlotPoll does nothing when the poll is disabled for that chat', async () => {
  const userId = 60001;
  const groupChatId = -60001;
  track(userId, groupChatId);
  const { ctx, replies } = fakeCtx('member', userId);

  await maybeOfferTimeSlotPoll(ctx, groupChatId, userId);

  assert.equal(replies.length, 0);
  assert.equal(getTimeSlotWizardState(userId), undefined);
});

test('maybeOfferTimeSlotPoll starts the day-picker when enabled and nothing answered yet', async () => {
  const userId = 60002;
  const groupChatId = -60002;
  setTimeSlotPollEnabled(groupChatId, true);
  track(userId, groupChatId);
  const { ctx, replies } = fakeCtx('member', userId);

  await maybeOfferTimeSlotPoll(ctx, groupChatId, userId);

  assert.equal(replies.some((r) => /Коли ти зазвичай вільний/.test(r)), true);
  const state = getTimeSlotWizardState(userId);
  assert.equal(state?.step, 'days');
  assert.equal(state?.groupChatId, groupChatId);
});

test('maybeOfferTimeSlotPoll does nothing when this user already answered this week', async () => {
  const userId = 60003;
  const groupChatId = -60003;
  setTimeSlotPollEnabled(groupChatId, true);
  track(userId, groupChatId);
  addOrUpdateTimeSlotResponse(groupChatId, userId, { days: [6], daysAny: false, times: [], timesAny: false });
  const { ctx, replies } = fakeCtx('member', userId);

  await maybeOfferTimeSlotPoll(ctx, groupChatId, userId);

  assert.equal(replies.length, 0);
  assert.equal(getTimeSlotWizardState(userId), undefined);
});

test('"tsp:open" seeds the wizard from an existing response instead of starting fresh', async () => {
  const userId = 60004;
  const groupChatId = -60004;
  setTimeSlotPollEnabled(groupChatId, true);
  track(userId, groupChatId);
  addOrUpdateTimeSlotResponse(groupChatId, userId, { days: [6, 0], daysAny: false, times: [], timesAny: false });

  const { ctx } = fakeCtx('member', userId, { callbackData: 'tsp:open' });
  await handleTimeSlotPollAction(ctx);

  const state = getTimeSlotWizardState(userId);
  assert.deepEqual(Array.from(state?.selectedDays ?? []).sort(), [0, 6]);
});

test('tapping a day toggles it in the wizard, and cancels "Будь-коли" if it was set', async () => {
  const userId = 60005;
  const groupChatId = -60005;
  setTimeSlotPollEnabled(groupChatId, true);
  track(userId, groupChatId);
  await maybeOfferTimeSlotPoll(fakeCtx('member', userId).ctx, groupChatId, userId);
  const { ctx: anyCtx } = fakeCtx('member', userId, { callbackData: 'tsp:day_any' });
  await handleTimeSlotPollAction(anyCtx); // turn "any" on first
  assert.equal(getTimeSlotWizardState(userId)?.daysAny, true);

  const { ctx } = fakeCtx('member', userId, { callbackData: 'tsp:day:6' });
  await handleTimeSlotPollAction(ctx);

  const state = getTimeSlotWizardState(userId);
  assert.equal(state?.daysAny, false); // explicit pick cancelled "any"
  assert.equal(state?.selectedDays.has(6), true);
});

test('tapping "Будь-коли" on the day screen clears any explicit picks', async () => {
  const userId = 60006;
  const groupChatId = -60006;
  setTimeSlotPollEnabled(groupChatId, true);
  track(userId, groupChatId);
  await maybeOfferTimeSlotPoll(fakeCtx('member', userId).ctx, groupChatId, userId);
  await handleTimeSlotPollAction(fakeCtx('member', userId, { callbackData: 'tsp:day:6' }).ctx);
  assert.equal(getTimeSlotWizardState(userId)?.selectedDays.has(6), true);

  await handleTimeSlotPollAction(fakeCtx('member', userId, { callbackData: 'tsp:day_any' }).ctx);

  const state = getTimeSlotWizardState(userId);
  assert.equal(state?.daysAny, true);
  assert.equal(state?.selectedDays.size, 0);
});

test('"days_done" with nothing selected reprompts instead of proceeding', async () => {
  const userId = 60007;
  const groupChatId = -60007;
  setTimeSlotPollEnabled(groupChatId, true);
  track(userId, groupChatId);
  await maybeOfferTimeSlotPoll(fakeCtx('member', userId).ctx, groupChatId, userId);

  const { ctx, replies } = fakeCtx('member', userId, { callbackData: 'tsp:days_done' });
  await handleTimeSlotPollAction(ctx);

  assert.equal(replies.some((r) => /Вибери хоча б один день/.test(r)), true);
  assert.equal(getTimeSlotWizardState(userId)?.step, 'days');
});

test('"days_done" with configured hours moves to the time screen instead of saving', async () => {
  const userId = 60008;
  const groupChatId = -60008;
  setTimeSlotPollEnabled(groupChatId, true);
  updateTimeSlotPollTimes(groupChatId, ['10:00', '11:00']);
  track(userId, groupChatId);
  await maybeOfferTimeSlotPoll(fakeCtx('member', userId).ctx, groupChatId, userId);
  await handleTimeSlotPollAction(fakeCtx('member', userId, { callbackData: 'tsp:day:6' }).ctx);

  const { ctx, replies } = fakeCtx('member', userId, { callbackData: 'tsp:days_done' });
  await handleTimeSlotPollAction(ctx);

  assert.equal(getTimeSlotWizardState(userId)?.step, 'times');
  assert.equal(replies.some((r) => /А о котрій зазвичай зручно/.test(r)), true);
  assert.equal(getTimeSlotResponse(groupChatId, userId), undefined); // not saved yet
});

test('"days_done" with no configured hours saves immediately, skipping the time screen entirely', async () => {
  const userId = 60009;
  const groupChatId = -60009;
  setTimeSlotPollEnabled(groupChatId, true);
  updateTimeSlotPollTimes(groupChatId, []);
  track(userId, groupChatId);
  await maybeOfferTimeSlotPoll(fakeCtx('member', userId).ctx, groupChatId, userId);
  await handleTimeSlotPollAction(fakeCtx('member', userId, { callbackData: 'tsp:day:6' }).ctx);

  const { ctx, replies } = fakeCtx('member', userId, { callbackData: 'tsp:days_done' });
  await handleTimeSlotPollAction(ctx);

  assert.equal(getTimeSlotWizardState(userId), undefined); // wizard finished, state cleared
  const response = getTimeSlotResponse(groupChatId, userId);
  assert.deepEqual(response?.days, [6]);
  assert.equal(replies.some((r) => /Дякуємо, записали/.test(r)), true);
});

test('toggling an hour then saving persists both days and times', async () => {
  const userId = 60010;
  const groupChatId = -60010;
  setTimeSlotPollEnabled(groupChatId, true);
  updateTimeSlotPollTimes(groupChatId, ['10:00', '11:00']);
  track(userId, groupChatId);
  await maybeOfferTimeSlotPoll(fakeCtx('member', userId).ctx, groupChatId, userId);
  await handleTimeSlotPollAction(fakeCtx('member', userId, { callbackData: 'tsp:day:0' }).ctx);
  await handleTimeSlotPollAction(fakeCtx('member', userId, { callbackData: 'tsp:days_done' }).ctx);
  await handleTimeSlotPollAction(fakeCtx('member', userId, { callbackData: 'tsp:time:1' }).ctx); // index 1 -> '11:00'

  await handleTimeSlotPollAction(fakeCtx('member', userId, { callbackData: 'tsp:save' }).ctx);

  const response = getTimeSlotResponse(groupChatId, userId);
  assert.deepEqual(response?.days, [0]);
  assert.deepEqual(response?.times, ['11:00']);
  assert.equal(getTimeSlotWizardState(userId), undefined);
});

test('tapping "Будь-коли" on the time screen clears any explicit hour picks', async () => {
  const userId = 60011;
  const groupChatId = -60011;
  setTimeSlotPollEnabled(groupChatId, true);
  updateTimeSlotPollTimes(groupChatId, ['10:00', '11:00']);
  track(userId, groupChatId);
  await maybeOfferTimeSlotPoll(fakeCtx('member', userId).ctx, groupChatId, userId);
  await handleTimeSlotPollAction(fakeCtx('member', userId, { callbackData: 'tsp:day:6' }).ctx);
  await handleTimeSlotPollAction(fakeCtx('member', userId, { callbackData: 'tsp:days_done' }).ctx);
  await handleTimeSlotPollAction(fakeCtx('member', userId, { callbackData: 'tsp:time:0' }).ctx);

  await handleTimeSlotPollAction(fakeCtx('member', userId, { callbackData: 'tsp:time_any' }).ctx);

  const state = getTimeSlotWizardState(userId);
  assert.equal(state?.timesAny, true);
  assert.equal(state?.selectedTimes.size, 0);
});

test('"back_to_days" returns to the day step, keeping the already-made day selection', async () => {
  const userId = 60012;
  const groupChatId = -60012;
  setTimeSlotPollEnabled(groupChatId, true);
  updateTimeSlotPollTimes(groupChatId, ['10:00']);
  track(userId, groupChatId);
  await maybeOfferTimeSlotPoll(fakeCtx('member', userId).ctx, groupChatId, userId);
  await handleTimeSlotPollAction(fakeCtx('member', userId, { callbackData: 'tsp:day:6' }).ctx);
  await handleTimeSlotPollAction(fakeCtx('member', userId, { callbackData: 'tsp:days_done' }).ctx);

  const { ctx, replies } = fakeCtx('member', userId, { callbackData: 'tsp:back_to_days' });
  await handleTimeSlotPollAction(ctx);

  const state = getTimeSlotWizardState(userId);
  assert.equal(state?.step, 'days');
  assert.equal(state?.selectedDays.has(6), true); // kept, not discarded
  assert.equal(replies.some((r) => /Коли ти зазвичай вільний/.test(r)), true);
});

test('"back" from the day screen cancels the whole flow without saving anything', async () => {
  const userId = 60013;
  const groupChatId = -60013;
  setTimeSlotPollEnabled(groupChatId, true);
  track(userId, groupChatId);
  await maybeOfferTimeSlotPoll(fakeCtx('member', userId).ctx, groupChatId, userId);
  await handleTimeSlotPollAction(fakeCtx('member', userId, { callbackData: 'tsp:day:6' }).ctx);

  const { ctx } = fakeCtx('member', userId, { callbackData: 'tsp:back' });
  await handleTimeSlotPollAction(ctx);

  assert.equal(getTimeSlotWizardState(userId), undefined);
  assert.equal(getTimeSlotResponse(groupChatId, userId), undefined);
});

test('handleTimeSlotPollAction refuses a user who left the group since the picker was offered', async () => {
  const userId = 60014;
  const groupChatId = -60014;
  setTimeSlotPollEnabled(groupChatId, true);
  track(userId, groupChatId);
  await maybeOfferTimeSlotPoll(fakeCtx('member', userId).ctx, groupChatId, userId);

  const { ctx, replies } = fakeCtx('kicked', userId, { callbackData: 'tsp:day:6' });
  await handleTimeSlotPollAction(ctx);

  assert.equal(replies.some((r) => /не в цій групі/.test(r)), true);
  assert.equal(getTimeSlotWizardState(userId)?.selectedDays.has(6), false); // nothing applied
});

test('handleTimeSlotPollAction refuses a blocked user and clears the in-progress wizard', async () => {
  const userId = 60015;
  const groupChatId = -60015;
  setTimeSlotPollEnabled(groupChatId, true);
  track(userId, groupChatId);
  await maybeOfferTimeSlotPoll(fakeCtx('member', userId).ctx, groupChatId, userId);
  blockUserFromGroup(groupChatId, userId, 'tester', 999);

  const { ctx, replies } = fakeCtx('member', userId, { callbackData: 'tsp:day:6' });
  await handleTimeSlotPollAction(ctx);

  assert.equal(replies.some((r) => /заблокували/.test(r)), true);
  assert.equal(getTimeSlotWizardState(userId), undefined);
});

test('handleTimeSlotPollAction refuses once the group is paused, showing the paused notice', async () => {
  const userId = 60016;
  const groupChatId = -60016;
  setTimeSlotPollEnabled(groupChatId, true);
  track(userId, groupChatId);
  await maybeOfferTimeSlotPoll(fakeCtx('member', userId).ctx, groupChatId, userId);
  pauseGroup(groupChatId);

  const { ctx, replies } = fakeCtx('member', userId, { callbackData: 'tsp:days_done' });
  await handleTimeSlotPollAction(ctx);

  assert.equal(replies.some((r) => /на паузі/.test(r)), true);
});

test('handleTimeSlotPollAction refuses once submissions are locked, showing the locked notice', async () => {
  const userId = 60017;
  const groupChatId = -60017;
  setTimeSlotPollEnabled(groupChatId, true);
  track(userId, groupChatId);
  await maybeOfferTimeSlotPoll(fakeCtx('member', userId).ctx, groupChatId, userId);
  lockSubmissions(groupChatId);

  const { ctx, replies } = fakeCtx('member', userId, { callbackData: 'tsp:days_done' });
  await handleTimeSlotPollAction(ctx);

  assert.equal(replies.some((r) => /закрито/.test(r)), true);
});

test('handleTimeSlotPollAction shows a staleness toast and applies nothing when the tapped card is not the tracked one', async () => {
  const userId = 60018;
  const groupChatId = -60018;
  setTimeSlotPollEnabled(groupChatId, true);
  track(userId, groupChatId); // tracked message id is 999

  const { ctx, alerts } = fakeCtx('member', userId, { callbackData: 'tsp:day:6', tappedMessageId: 12345 });
  await handleTimeSlotPollAction(ctx);

  assert.equal(alerts.some((a) => a.show_alert && /застаріла/.test(a.text ?? '')), true);
  assert.equal(getTimeSlotWizardState(userId), undefined);
});

test('updateTimeSlotPollWeekdays affects which days the wizard offers', async () => {
  const userId = 60019;
  const groupChatId = -60019;
  setTimeSlotPollEnabled(groupChatId, true);
  updateTimeSlotPollWeekdays(groupChatId, [1, 3]);
  updateTimeSlotPollTimes(groupChatId, []); // so "days_done" saves immediately below
  track(userId, groupChatId);

  const { ctx } = fakeCtx('member', userId);
  await maybeOfferTimeSlotPoll(ctx, groupChatId, userId);
  await handleTimeSlotPollAction(fakeCtx('member', userId, { callbackData: 'tsp:day:1' }).ctx);
  await handleTimeSlotPollAction(fakeCtx('member', userId, { callbackData: 'tsp:days_done' }).ctx);

  assert.deepEqual(getTimeSlotResponse(groupChatId, userId)?.days, [1]);
});
