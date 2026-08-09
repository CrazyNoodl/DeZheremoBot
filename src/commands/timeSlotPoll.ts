import { Markup, type Context } from 'telegraf';
import { isChatMember } from './access.js';
import {
  buildMenuKeyboard,
  buildMenuText,
  isStaleMenuTap,
  renderGateIfBlocked,
  STALE_MENU_TAP_MESSAGE,
  TIME_SLOT_POLL_ACTION,
  updateMenuMessage,
} from './menuMessage.js';
import { safeAnswerCbQuery } from './panel.js';
import { getSchedule } from '../services/scheduleService.js';
import { isTimeSlotPollEnabled } from '../services/timeSlotPollService.js';
import { getMenuMessage } from '../storage/menuMessages.js';
import { addOrUpdateTimeSlotResponse, getTimeSlotResponse, type TimeSlotResponse } from '../storage/timeSlotResponses.js';
import {
  clearTimeSlotWizardState,
  getTimeSlotWizardState,
  setTimeSlotWizardState,
  type TimeSlotWizardState,
} from '../storage/timeSlotWizardState.js';

export { TIME_SLOT_POLL_ACTION };

// Same weekday labeling/ordering as every other file's own copy (schedule.ts, admin.ts,
// menuMessage.ts) — duplicated rather than shared, one short const array with no reason to depend
// on another file's copy.
const WEEKDAY_LABELS = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

function orderedConfiguredDays(configured: number[]): number[] {
  return WEEK_ORDER.filter((day) => configured.includes(day));
}

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

function startWizard(userId: number, groupChatId: number, seed?: TimeSlotResponse): void {
  setTimeSlotWizardState(userId, {
    groupChatId,
    step: 'days',
    selectedDays: new Set(seed?.days ?? []),
    daysAny: seed?.daysAny ?? false,
    selectedTimes: new Set(seed?.times ?? []),
    timesAny: seed?.timesAny ?? false,
  });
}

function buildDaysText(error?: string): string {
  const prefix = error ? `${error}\n\n` : '';
  return `${prefix}🗓 Коли ти зазвичай вільний(а) цього тижня? Обери день(-і) 👇`;
}

// "🕐 Будь-коли" is mutually exclusive with specific picks on this same screen: tapping it clears
// any explicit day toggles (since they'd be redundant with "any day works"), and tapping a
// specific day cancels "any" back off — see CLAUDE.md's design discussion for this feature.
function buildDaysKeyboard(groupChatId: number, state: TimeSlotWizardState) {
  const schedule = getSchedule(groupChatId);
  const dayButtons = orderedConfiguredDays(schedule.timeSlotPollWeekdays).map((day) =>
    Markup.button.callback(`${state.selectedDays.has(day) ? '✅' : '◻️'} ${WEEKDAY_LABELS[day]}`, `tsp:day:${day}`),
  );
  return Markup.inlineKeyboard([
    ...chunk(dayButtons, 4),
    [Markup.button.callback(`${state.daysAny ? '✅' : '◻️'} 🕐 Будь-коли`, 'tsp:day_any')],
    [Markup.button.callback('✅ Готово', 'tsp:days_done')],
    [Markup.button.callback('‹ Назад', 'tsp:back')],
  ]);
}

async function renderDaysScreen(ctx: Context, userId: number, error?: string): Promise<void> {
  const state = getTimeSlotWizardState(userId);
  if (!state) return;
  await updateMenuMessage(ctx, state.groupChatId, userId, buildDaysText(error), buildDaysKeyboard(state.groupChatId, state));
}

function buildTimesText(error?: string): string {
  const prefix = error ? `${error}\n\n` : '';
  return `${prefix}🕐 А о котрій зазвичай зручно? Обери годину(-и) 👇`;
}

function buildTimesKeyboard(groupChatId: number, state: TimeSlotWizardState) {
  const schedule = getSchedule(groupChatId);
  const timeButtons = schedule.timeSlotPollTimes.map((time, index) =>
    Markup.button.callback(`${state.selectedTimes.has(time) ? '✅' : '◻️'} ${time}`, `tsp:time:${index}`),
  );
  return Markup.inlineKeyboard([
    ...chunk(timeButtons, 3),
    [Markup.button.callback(`${state.timesAny ? '✅' : '◻️'} 🕐 Будь-коли`, 'tsp:time_any')],
    [Markup.button.callback('✅ Зберегти', 'tsp:save')],
    [Markup.button.callback('‹ Назад', 'tsp:back_to_days')],
  ]);
}

async function renderTimesScreen(ctx: Context, userId: number, error?: string): Promise<void> {
  const state = getTimeSlotWizardState(userId);
  if (!state) return;
  await updateMenuMessage(ctx, state.groupChatId, userId, buildTimesText(error), buildTimesKeyboard(state.groupChatId, state));
}

async function cancelWizard(ctx: Context, userId: number, groupChatId: number): Promise<void> {
  clearTimeSlotWizardState(userId);
  await updateMenuMessage(ctx, groupChatId, userId, buildMenuText(groupChatId, userId), buildMenuKeyboard(groupChatId, userId));
}

async function saveAndFinish(ctx: Context, userId: number, state: TimeSlotWizardState): Promise<void> {
  addOrUpdateTimeSlotResponse(state.groupChatId, userId, {
    days: Array.from(state.selectedDays),
    daysAny: state.daysAny,
    times: Array.from(state.selectedTimes),
    timesAny: state.timesAny,
  });
  clearTimeSlotWizardState(userId);
  await updateMenuMessage(
    ctx,
    state.groupChatId,
    userId,
    `Дякуємо, записали! 🙌\n\n${buildMenuText(state.groupChatId, userId)}`,
    buildMenuKeyboard(state.groupChatId, userId),
  );
}

// Called from commands/menu.ts's renderSubmitOutcome right after a genuine new/changed place
// submission — re-renders the SAME tracked menu card (already showing the plain confirmation text)
// into the day-picker screen, rather than sending a separate message. A no-op when the poll is
// disabled for this chat, or when this user already has an answer recorded this week (so
// resubmitting/editing a place never re-triggers it).
export async function maybeOfferTimeSlotPoll(ctx: Context, groupChatId: number, userId: number): Promise<void> {
  if (!isTimeSlotPollEnabled(groupChatId)) return;
  if (getTimeSlotResponse(groupChatId, userId) !== undefined) return;

  startWizard(userId, groupChatId);
  await renderDaysScreen(ctx, userId);
}

export async function handleTimeSlotPollAction(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const query = ctx.callbackQuery;
  const data = query && 'data' in query ? query.data : undefined;

  if (!userId || !data) {
    if (query) await safeAnswerCbQuery(ctx);
    return;
  }

  const groupChatId = getMenuMessage(userId)?.groupChatId;
  if (groupChatId === undefined) {
    await safeAnswerCbQuery(ctx);
    return;
  }

  if (isStaleMenuTap(ctx, userId)) {
    await safeAnswerCbQuery(ctx, STALE_MENU_TAP_MESSAGE, { show_alert: true });
    return;
  }

  await safeAnswerCbQuery(ctx);

  // Re-checked here, not just when the picker was first offered — the tracked card can outlive the
  // user's membership, same reasoning as every other action off this card (handleSubmitAction etc.).
  if (!(await isChatMember(ctx, groupChatId, userId))) {
    await ctx.reply('🔒 Здається, ти вже не в цій групі.');
    return;
  }

  if (await renderGateIfBlocked(ctx, groupChatId, userId)) {
    clearTimeSlotWizardState(userId);
    return;
  }

  const [, action, arg] = data.split(':');

  if (action === 'open') {
    // Reseeds from the persisted response (or fresh/empty if none) rather than resuming any old
    // in-memory wizard state — see storage/timeSlotWizardState.ts's own reasoning.
    startWizard(userId, groupChatId, getTimeSlotResponse(groupChatId, userId));
    await renderDaysScreen(ctx, userId);
    return;
  }

  const state = getTimeSlotWizardState(userId);
  if (!state || state.groupChatId !== groupChatId) return;

  if (action === 'day') {
    const day = Number(arg);
    if (state.selectedDays.has(day)) {
      state.selectedDays.delete(day);
    } else {
      state.selectedDays.add(day);
      state.daysAny = false;
    }
    await renderDaysScreen(ctx, userId);
    return;
  }

  if (action === 'day_any') {
    state.daysAny = !state.daysAny;
    if (state.daysAny) state.selectedDays.clear();
    await renderDaysScreen(ctx, userId);
    return;
  }

  if (action === 'days_done') {
    if (!state.daysAny && state.selectedDays.size === 0) {
      await renderDaysScreen(ctx, userId, '⚠️ Вибери хоча б один день або «Будь-коли».');
      return;
    }

    const schedule = getSchedule(groupChatId);
    if (schedule.timeSlotPollTimes.length === 0) {
      await saveAndFinish(ctx, userId, state);
      return;
    }

    state.step = 'times';
    await renderTimesScreen(ctx, userId);
    return;
  }

  if (action === 'back') {
    await cancelWizard(ctx, userId, groupChatId);
    return;
  }

  if (action === 'time') {
    const schedule = getSchedule(groupChatId);
    const time = schedule.timeSlotPollTimes[Number(arg)];
    if (time === undefined) return;

    if (state.selectedTimes.has(time)) {
      state.selectedTimes.delete(time);
    } else {
      state.selectedTimes.add(time);
      state.timesAny = false;
    }
    await renderTimesScreen(ctx, userId);
    return;
  }

  if (action === 'time_any') {
    state.timesAny = !state.timesAny;
    if (state.timesAny) state.selectedTimes.clear();
    await renderTimesScreen(ctx, userId);
    return;
  }

  if (action === 'save') {
    await saveAndFinish(ctx, userId, state);
    return;
  }

  if (action === 'back_to_days') {
    state.step = 'days';
    await renderDaysScreen(ctx, userId);
    return;
  }
}
