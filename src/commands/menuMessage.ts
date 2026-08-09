import * as Sentry from '@sentry/node';
import { Markup, TelegramError, type Context } from 'telegraf';
import { pickRandom } from '../messaging/announcements.js';
import { escapeHtml, placeLink } from '../utils/htmlFormat.js';
import { getSchedule } from '../services/scheduleService.js';
import { isTimeSlotPollEnabled } from '../services/timeSlotPollService.js';
import { getUserSubmission, isGroupPaused, isSubmissionLocked, isUserBlocked } from '../services/submissionService.js';
import { getGroupChatTitle } from '../storage/groupChats.js';
import { clearMenuMessage, getMenuMessage, setMenuMessage } from '../storage/menuMessages.js';
import { getTimeSlotResponse, type TimeSlotResponse } from '../storage/timeSlotResponses.js';

export const SUBMIT_ACTION = 'submit';
export const DECLINE_ACTION = 'decline';
// Bare action (no group/place embedded in callback_data) — same reasoning as SUBMIT_ACTION/
// DECLINE_ACTION: this button lives on the same tracked private-chat menu card, so its handler
// (commands/timeSlotPoll.ts) recovers the group from getMenuMessage the same way handleSubmitAction
// does.
export const TIME_SLOT_POLL_ACTION = 'tsp:open';

// Exported so text.ts's rejection replies for the same two states can reuse these literals instead
// of retyping them — one string each, so wording can't drift between "opening the menu while
// blocked/paused" and "typing a place while blocked/paused". Originally lived in commands/menu.ts;
// moved here (alongside isStaleMenuTap/renderGateIfBlocked below) so commands/timeSlotPoll.ts can
// reuse them too without menu.ts and timeSlotPoll.ts importing from each other.
export const PAUSED_MESSAGE = '⏸ Цього тижня ДеЖеремо на паузі — заявки поки не приймаються. Скоро повернемось!';
export const BLOCKED_MESSAGE = '🚫 Тебе заблокували в цій групі — додавати заявки більше не можна.';
const LOCKED_MESSAGE = '🔒 Заявки на цей тиждень уже закрито';

// Single source of truth for this three-way message, so handleGroupDeclineAction's upfront gate
// and its post-declinePlace race-condition fallback (commands/menu.ts) can't drift apart from each
// other.
export function gateMessageFor(reason: 'blocked' | 'paused' | 'locked'): string {
  if (reason === 'blocked') return BLOCKED_MESSAGE;
  if (reason === 'paused') return PAUSED_MESSAGE;
  return LOCKED_MESSAGE;
}

export const STALE_MENU_TAP_MESSAGE = '🔄 Ця картка вже застаріла — онови меню командою /start, там уже інший стан.';

// Telegram never expires old inline buttons — if the tapped message isn't the one this user's
// card is currently tracked as (storage/menuMessages.ts), something already updated the *real*
// tracked card since this one was rendered (a later action edited it in place, or it aged past
// the 48h edit window and a fresh message replaced it). Acting on a stale card's button would
// apply whatever it implies against the *current* actual state instead of the state the user is
// looking at.
export function isStaleMenuTap(ctx: Context, userId: number): boolean {
  const query = ctx.callbackQuery;
  const tappedMessageId = query && 'message' in query ? query.message?.message_id : undefined;
  const trackedMessageId = getMenuMessage(userId)?.messageId;
  return tappedMessageId !== undefined && trackedMessageId !== undefined && tappedMessageId !== trackedMessageId;
}

// Same weekday labeling as schedule.ts's/help.ts's own copies — duplicated rather than shared, since
// it's one short const array and this file has no other reason to depend on either of theirs.
const WEEKDAY_LABELS = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
// Same Mon..Sun display ordering as timeSlotPoll.ts's own copy, duplicated for the same reason.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

// Telegram bots can't edit messages older than this — once a menu message ages
// out of that window, delete it instead of leaving a dead card in the chat.
const MENU_MESSAGE_TTL_MS = 48 * 60 * 60 * 1000;

// Prefixes every card/prompt with the group name, since one user can be in several groups
// running this bot and the private chat only ever shows one shared card at a time.
export function withGroupLabel(groupChatId: number, text: string): string {
  const title = getGroupChatTitle(groupChatId);
  return title ? `📍 ${escapeHtml(title)}\n\n${text}` : text;
}

// e.g. "Пт, 18:00" — shown at the top of the menu card so a member can see when submissions
// close without having to separately open /help.
function deadlineLabel(groupChatId: number): string {
  const schedule = getSchedule(groupChatId);
  return `${WEEKDAY_LABELS[schedule.deadlineWeekday]}, ${schedule.lockTime}`;
}

// Small pools (same idea as announcements.ts's phrase pools) so the two states a member sees most
// often — nothing submitted yet, or a submission already on file — don't read identically every
// single time the menu card renders.
const EMPTY_MENU_POOL = [
  'Цього тижня ще порожньо — станеш першим? Тисни кнопку нижче 👇',
  'Поки що жодного варіанту — може, твій стане вибором тижня? Тисни кнопку нижче 👇',
  'Тиша... Запропонуй заклад першим — тисни кнопку нижче 👇',
] as const;
const HAS_SUBMISSION_MENU_POOL = [
  'Хочеш змінити — тисни кнопку нижче 👇',
  'Щось краще на думці? Тисни кнопку нижче 👇',
  'Можеш змінити будь-коли — тисни кнопку нижче 👇',
] as const;

// Renders the experimental time-slot poll's saved answer (see CLAUDE.md's "Time-slot availability
// poll (experimental)") back onto the same menu card that shows the submitted place, so a member
// can see what they answered without reopening "🗓 Моя доступність" to check.
function formatTimeSlotChoice(response: TimeSlotResponse): string {
  const daysLabel = response.daysAny
    ? 'будь-коли'
    : WEEK_ORDER.filter((day) => response.days.includes(day))
        .map((day) => WEEKDAY_LABELS[day])
        .join(', ');
  const timesLabel = response.timesAny
    ? ', будь-яка година'
    : response.times.length > 0
      ? `, ${[...response.times].sort().join(', ')}`
      : '';
  return `🗓 Твоя доступність: ${daysLabel}${timesLabel}`;
}

export function buildMenuText(groupChatId: number, userId: number): string {
  const submission = getUserSubmission(groupChatId, userId);
  const deadlineLine = `<i>⏰ Дедлайн: ${deadlineLabel(groupChatId)}</i>\n\n`;
  if (submission?.status === 'declined') {
    return `${deadlineLine}🙅 Ок, зрозуміли — цього тижня тебе не буде.\n\nПлани зміняться — тисни кнопку нижче 👇`;
  }
  if (!submission) {
    return `${deadlineLine}🍽 ${pickRandom(EMPTY_MENU_POOL)}`;
  }
  // Gated on isTimeSlotPollEnabled the same way buildMenuKeyboard's edit button is — otherwise an
  // admin disabling the poll after a member already answered would leave this line showing a
  // now-stale answer with no button left to edit or clear it.
  const availability = isTimeSlotPollEnabled(groupChatId) ? getTimeSlotResponse(groupChatId, userId) : undefined;
  const availabilityLine = availability ? `\n${formatTimeSlotChoice(availability)}` : '';
  return `${deadlineLine}📍 Твій вибір цього тижня: ${placeLink(submission.place)}${availabilityLine}\n\n${pickRandom(HAS_SUBMISSION_MENU_POOL)}`;
}

export function buildMenuKeyboard(groupChatId: number, userId: number) {
  const submission = getUserSubmission(groupChatId, userId);
  const declined = submission?.status === 'declined';
  const rows = [];
  // While declined, "➕ Додати" would be a second button leading to the exact same "send me a
  // link" prompt as cancelling the decline (see handleDeclineAction) — so it's dropped here rather
  // than shown redundantly alongside it.
  if (!declined) {
    rows.push([Markup.button.callback(submission?.status === 'submitted' ? '✏️ Змінити' : '➕ Додати', SUBMIT_ACTION)]);
  }
  // Only offered once there's an actual place submitted this week — a decliner has nothing to be
  // asked "when are you free" about, and the experimental poll itself might be off for this group.
  if (isTimeSlotPollEnabled(groupChatId) && submission?.status === 'submitted') {
    rows.push([Markup.button.callback('🗓 Моя доступність', TIME_SLOT_POLL_ACTION)]);
  }
  // "🙅 Не йду" always comes last — it's the least-common action on this card, and shouldn't sit
  // above buttons for the far more frequent "add/change place"/"set availability" actions.
  rows.push([Markup.button.callback(declined ? '↩️ Скасувати «не йду»' : '🙅 Не йду цього тижня', DECLINE_ACTION)]);
  return Markup.inlineKeyboard(rows);
}

function trackMenuMessage(
  ctx: Context,
  groupChatId: number,
  userId: number,
  privateChatId: number,
  messageId: number,
): void {
  setMenuMessage(userId, privateChatId, messageId, groupChatId);
  setTimeout(() => {
    const ref = getMenuMessage(userId);
    if (ref?.messageId !== messageId) return; // superseded by a newer menu message already
    clearMenuMessage(userId);
    ctx.telegram.deleteMessage(privateChatId, messageId).catch(() => {});
  }, MENU_MESSAGE_TTL_MS);
}

export async function sendMenuMessage(
  ctx: Context,
  groupChatId: number,
  userId: number,
  text: string,
  keyboard: ReturnType<typeof Markup.inlineKeyboard> = buildMenuKeyboard(groupChatId, userId),
): Promise<void> {
  const privateChatId = ctx.chat?.id;
  if (!privateChatId) return;

  const sent = await ctx.reply(withGroupLabel(groupChatId, text), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...keyboard,
  });
  trackMenuMessage(ctx, groupChatId, userId, privateChatId, sent.message_id);
}

export async function updateMenuMessage(
  ctx: Context,
  groupChatId: number,
  userId: number,
  text: string,
  keyboard: ReturnType<typeof Markup.inlineKeyboard> = Markup.inlineKeyboard([]),
): Promise<void> {
  const ref = getMenuMessage(userId);

  if (ref) {
    try {
      await ctx.telegram.editMessageText(ref.chatId, ref.messageId, undefined, withGroupLabel(groupChatId, text), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...keyboard,
      });
      setMenuMessage(userId, ref.chatId, ref.messageId, groupChatId); // this card now represents groupChatId's cycle
      return;
    } catch (err) {
      // Telegram rejects an edit whose text+keyboard exactly match the current message (e.g. a
      // rapid double-tap of the same button) — that's a no-op, not a failure, so don't fall
      // through to sending a duplicate. Same fix as commands/panel.ts's shared `update`.
      if (err instanceof TelegramError && err.description?.includes('message is not modified')) {
        return;
      }
      // too old to edit (past Telegram's window) or deleted — fall through to a fresh message.
      // Logged at warn rather than error: expected to happen occasionally, but a spike would
      // otherwise be invisible.
      console.warn(`[menuMessage] edit failed for user ${userId}, sending a fresh message instead:`, err);
      Sentry.captureException(err);
    }
  }

  await sendMenuMessage(ctx, groupChatId, userId, text, keyboard);
}

// Shared by commands/menu.ts's showPersonalMenu/handleSubmitAction/handleDeclineAction/
// handleResubmitDeclinedAction and commands/timeSlotPoll.ts's wizard actions, which all need the
// exact same blocked → paused → locked precedence and messages before doing anything group-cycle-
// specific. Renders the relevant notice and returns true if one of these gates applies, so the
// caller just has to `return` when this returns true and fall through to its own logic otherwise.
export async function renderGateIfBlocked(ctx: Context, groupChatId: number, userId: number): Promise<boolean> {
  // Checked first: a blocked user gets a distinct, permanent-sounding message rather than one
  // implying they could submit again once the week reopens or resumes.
  if (isUserBlocked(groupChatId, userId)) {
    await updateMenuMessage(ctx, groupChatId, userId, BLOCKED_MESSAGE);
    return true;
  }

  // Checked ahead of the lock check: pause and lock are independent flags, and a paused group
  // gets its own distinct message rather than the "closed for this week" lock text.
  if (isGroupPaused(groupChatId)) {
    await updateMenuMessage(ctx, groupChatId, userId, PAUSED_MESSAGE);
    return true;
  }

  if (isSubmissionLocked(groupChatId)) {
    // Edits/reuses a stale tracked card if one exists, same as every other state change in this
    // private chat, instead of always creating a fresh message.
    await updateMenuMessage(ctx, groupChatId, userId, LOCKED_MESSAGE);
    return true;
  }

  return false;
}
