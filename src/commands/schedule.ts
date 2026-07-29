import { Markup, type Context } from 'telegraf';
import { getKyivNow } from '../kyivTime.js';
import { sendTaggedReminder } from '../scheduler.js';
import {
  getSchedule,
  isValidTime,
  resetSchedule,
  updateDeadlineSchedule,
  updateReminderSchedule,
  type GroupScheduleConfig,
  type UpdateResult,
} from '../services/scheduleService.js';
import { markFired } from '../storage/firedEvents.js';
import {
  clearScheduleEditState,
  getScheduleEditState,
  setScheduleEditState,
  type ScheduleEditState,
} from '../storage/scheduleEditState.js';
import { handleAdminEntryCommand, isGroupAdmin, showGatedMenu } from './access.js';
import { createPanel, safeAnswerCbQuery } from './panel.js';

// Same 48h reasoning as MENU_MESSAGE_TTL_MS in menuMessage.ts: past this, Telegram refuses to edit the message.
const SCHEDULE_PANEL_TTL_MS = 48 * 60 * 60 * 1000;

const panel = createPanel(SCHEDULE_PANEL_TTL_MS, 'schedule');

const WEEKDAY_LABELS = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const CANCEL_KEYBOARD = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Скасувати', 'sched:back')]]);

// commands/text.ts checks handleScheduleTextStep before the submit-flow's own awaiting state, so a
// wizard left mid-step (user never reaches a final step or presses "⬅️ Скасувати") would otherwise
// sit here forever and silently swallow every later text message from that user — e.g. them trying
// to submit a place — as if it were an invalid schedule-time reply. TTL bounds that window.
const SCHEDULE_EDIT_TTL_MS = 10 * 60 * 1000;

function setScheduleEditStateWithTTL(userId: number, state: ScheduleEditState): void {
  setScheduleEditState(userId, state);
  setTimeout(() => {
    if (getScheduleEditState(userId) === state) clearScheduleEditState(userId);
  }, SCHEDULE_EDIT_TTL_MS);
}

function formatWeekdays(weekdays: number[]): string {
  return WEEK_ORDER.filter((day) => weekdays.includes(day))
    .map((day) => WEEKDAY_LABELS[day])
    .join(', ');
}

function buildSummaryText(config: GroupScheduleConfig): string {
  return (
    `⚙️ Розклад цієї групи\n\n` +
    `📅 Нагадування: ${formatWeekdays(config.reminderWeekdays)} о ${config.reminderTime}\n` +
    `🔒 Дедлайн (${WEEKDAY_LABELS[config.deadlineWeekday]}): закриття заявок ${config.lockTime}, жеребкування ${config.drawTime}`
  );
}

function buildSummaryKeyboard(chatId: number) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Дні та час нагадувань', `sched:edit_reminder:${chatId}`)],
    [Markup.button.callback('✏️ День та час дедлайну', `sched:edit_deadline:${chatId}`)],
    [Markup.button.callback('🔔 Надіслати нагадування зараз', `sched:remind:${chatId}`)],
    [Markup.button.callback('↩️ Скинути на дефолт', `sched:reset:${chatId}`)],
  ]);
}

function buildWeekdayToggleKeyboard(selected: Set<number>) {
  const buttons = WEEK_ORDER.map((day) =>
    Markup.button.callback(`${selected.has(day) ? '✅' : '◻️'} ${WEEKDAY_LABELS[day]}`, `sched:day:${day}`),
  );
  return Markup.inlineKeyboard([
    buttons.slice(0, 4),
    buttons.slice(4),
    [Markup.button.callback('✅ Готово', 'sched:days_done')],
    [Markup.button.callback('⬅️ Назад', 'sched:back')],
  ]);
}

function buildWeekdaySingleSelectKeyboard() {
  const buttons = WEEK_ORDER.map((day) => Markup.button.callback(WEEKDAY_LABELS[day], `sched:day:${day}`));
  return Markup.inlineKeyboard([buttons.slice(0, 4), buttons.slice(4), [Markup.button.callback('⬅️ Назад', 'sched:back')]]);
}

async function renderSummary(ctx: Context, userId: number, chatId: number): Promise<void> {
  clearScheduleEditState(userId);
  await panel.update(ctx, userId, buildSummaryText(getSchedule(chatId)), buildSummaryKeyboard(chatId));
}

async function renderWeekdayToggleScreen(ctx: Context, userId: number, selected: Set<number>): Promise<void> {
  await panel.update(ctx, userId, 'Обери дні нагадувань:', buildWeekdayToggleKeyboard(selected));
}

async function renderDeadlineWeekdayScreen(ctx: Context, userId: number): Promise<void> {
  await panel.update(ctx, userId, 'Обери день дедлайну (закриття заявок + жеребкування):', buildWeekdaySingleSelectKeyboard());
}

export async function showScheduleMenu(ctx: Context, chatId: number): Promise<void> {
  await showGatedMenu(
    ctx,
    chatId,
    {
      checkFailed: '⚠️ Не вдалося перевірити права доступу для цієї групи.',
      notAdmin: '🔒 Лише адміни групи можуть змінювати розклад.',
    },
    renderSummary,
  );
}

export async function handleScheduleCommand(ctx: Context): Promise<void> {
  await handleAdminEntryCommand(
    ctx,
    'sched',
    {
      notPrivate: '⚙️ Розклад можна змінити лише у приватному чаті з ботом — напиши мені /schedule тут.',
      noAdminGroups: '🔒 Ти не адміністратор жодної групи, де я є.',
      pickGroup: 'Обери групу, розклад якої хочеш змінити:',
    },
    showScheduleMenu,
  );
}

export async function handleScheduleAction(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const query = ctx.callbackQuery;
  const data = query && 'data' in query ? query.data : undefined;

  if (!userId || !data) {
    if (query) await safeAnswerCbQuery(ctx);
    return;
  }

  const [, action, arg] = data.split(':');

  // Every action here targets a group either directly (select/edit_reminder/edit_deadline/reset,
  // via the chatId embedded in callback_data) or through the wizard state it's continuing
  // (day/days_done/back, via the tracked edit state's chatId) — re-verify admin status on all of
  // them, not just `select`. Admin status can change any time after the summary panel was sent
  // (Telegram never expires old inline buttons, so a stale "✏️ Дні та час нагадувань"/"↩️ Скинути
  // на дефолт" button stays pressable indefinitely) or mid-wizard, and without this, someone
  // demoted after opening /schedule could still rewrite that group's schedule.
  const targetChatId =
    action === 'select' || action === 'edit_reminder' || action === 'edit_deadline' || action === 'reset' || action === 'remind'
      ? Number(arg)
      : action === 'day' || action === 'days_done' || action === 'back'
        ? getScheduleEditState(userId)?.chatId
        : undefined;

  if (targetChatId !== undefined) {
    const admin = await isGroupAdmin(ctx, targetChatId, userId).catch(() => false);
    if (!admin) {
      clearScheduleEditState(userId);
      await safeAnswerCbQuery(ctx, '🔒 Лише адміни групи можуть змінювати розклад.', { show_alert: true });
      return;
    }
  }

  if (action === 'days_done') {
    const state = getScheduleEditState(userId);
    if (state?.flow === 'reminder' && state.step === 'weekdays' && state.selected.size === 0) {
      await safeAnswerCbQuery(ctx, 'Вибери хоча б один день', { show_alert: true });
      return;
    }
  }

  await safeAnswerCbQuery(ctx);

  if (action === 'select') {
    const chatId = Number(arg);
    const message = query && 'message' in query ? query.message : undefined;
    if (message) panel.track(ctx, userId, message.chat.id, message.message_id);
    await renderSummary(ctx, userId, chatId);
    return;
  }

  if (action === 'edit_reminder') {
    const chatId = Number(arg);
    const selected = new Set(getSchedule(chatId).reminderWeekdays);
    setScheduleEditStateWithTTL(userId, { flow: 'reminder', step: 'weekdays', chatId, selected });
    await renderWeekdayToggleScreen(ctx, userId, selected);
    return;
  }

  if (action === 'edit_deadline') {
    const chatId = Number(arg);
    setScheduleEditStateWithTTL(userId, { flow: 'deadline', step: 'weekday', chatId });
    await renderDeadlineWeekdayScreen(ctx, userId);
    return;
  }

  if (action === 'reset') {
    const chatId = Number(arg);
    resetSchedule(chatId);
    await renderSummary(ctx, userId, chatId);
    return;
  }

  if (action === 'remind') {
    const chatId = Number(arg);
    // Marks today's reminder as already fired so the scheduler's own tick doesn't send a second,
    // duplicate reminder later the same day if this group's scheduled reminder time hasn't passed
    // yet — same reasoning as admin.ts's "force draw now" marking 'draw' fired.
    markFired(chatId, 'reminder', getKyivNow().date);
    await sendTaggedReminder(ctx.telegram, ctx.botInfo.username, chatId);
    await renderSummary(ctx, userId, chatId);
    return;
  }

  if (action === 'back') {
    const state = getScheduleEditState(userId);
    if (state) await renderSummary(ctx, userId, state.chatId);
    return;
  }

  if (action === 'day') {
    const day = Number(arg);
    const state = getScheduleEditState(userId);
    if (!state) return;

    if (state.flow === 'reminder' && state.step === 'weekdays') {
      if (state.selected.has(day)) {
        state.selected.delete(day);
      } else {
        state.selected.add(day);
      }
      await renderWeekdayToggleScreen(ctx, userId, state.selected);
      return;
    }

    if (state.flow === 'deadline' && state.step === 'weekday') {
      setScheduleEditStateWithTTL(userId, { flow: 'deadline', step: 'lockTime', chatId: state.chatId, weekday: day });
      await panel.update(
        ctx,
        userId,
        'Введи час закриття прийому заявок (lock) у форматі ГГ:ХХ, напр. 18:00',
        CANCEL_KEYBOARD,
      );
      return;
    }
    return;
  }

  if (action === 'days_done') {
    const state = getScheduleEditState(userId);
    if (!state || state.flow !== 'reminder' || state.step !== 'weekdays') return;

    const weekdays = Array.from(state.selected);
    setScheduleEditStateWithTTL(userId, { flow: 'reminder', step: 'time', chatId: state.chatId, weekdays });
    await panel.update(ctx, userId, 'Введи час нагадувань у форматі ГГ:ХХ, напр. 10:00', CANCEL_KEYBOARD);
    return;
  }
}

function reportTimeResult(
  ctx: Context,
  userId: number,
  chatId: number,
  result: UpdateResult,
  reprompt: string,
): Promise<void> {
  if (!result.ok) {
    const error =
      result.reason === 'draw_before_lock'
        ? '⚠️ Час жеребкування має бути пізніше за lock. Спробуй ще раз.'
        : result.reason === 'reminder_after_lock'
          ? '⚠️ Нагадування випадає в день дедлайну після закриття заявок (lock) — постав раніше.'
          : '⚠️ Невірний формат. Введи час у форматі ГГ:ХХ.';
    return panel.update(ctx, userId, `${error}\n\n${reprompt}`, CANCEL_KEYBOARD);
  }

  return renderSummary(ctx, userId, chatId);
}

export async function handleScheduleTextStep(ctx: Context, userId: number, text: string): Promise<boolean> {
  const state = getScheduleEditState(userId);
  if (!state) return false;

  // Same re-verification as handleScheduleAction's targetChatId check — this text reply can land
  // minutes after the button press that started this step, and admin status can change in between.
  const admin = await isGroupAdmin(ctx, state.chatId, userId).catch(() => false);
  if (!admin) {
    clearScheduleEditState(userId);
    await ctx.reply('🔒 Ти більше не адмін цієї групи — зміну розкладу скасовано.');
    return true;
  }

  if (state.flow === 'reminder' && state.step === 'time') {
    const result = updateReminderSchedule(state.chatId, state.weekdays, text);
    await reportTimeResult(ctx, userId, state.chatId, result, 'Введи час нагадувань у форматі ГГ:ХХ, напр. 10:00');
    return true;
  }

  if (state.flow === 'deadline' && state.step === 'lockTime') {
    if (!isValidTime(text)) {
      await panel.update(
        ctx,
        userId,
        '⚠️ Невірний формат. Введи час закриття заявок у форматі ГГ:ХХ, напр. 18:00',
        CANCEL_KEYBOARD,
      );
      return true;
    }

    setScheduleEditStateWithTTL(userId, { flow: 'deadline', step: 'drawTime', chatId: state.chatId, weekday: state.weekday, lockTime: text });
    await panel.update(ctx, userId, 'Введи час жеребкування (draw) у форматі ГГ:ХХ, напр. 18:15', CANCEL_KEYBOARD);
    return true;
  }

  if (state.flow === 'deadline' && state.step === 'drawTime') {
    const result = updateDeadlineSchedule(state.chatId, state.weekday, state.lockTime, text);
    await reportTimeResult(ctx, userId, state.chatId, result, 'Введи час жеребкування (draw) у форматі ГГ:ХХ, напр. 18:15');
    return true;
  }

  return false;
}
