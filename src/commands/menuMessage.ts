import * as Sentry from '@sentry/node';
import { Markup, TelegramError, type Context } from 'telegraf';
import { pickRandom } from '../messaging/announcements.js';
import { escapeHtml, placeLink } from '../utils/htmlFormat.js';
import { getSchedule } from '../services/scheduleService.js';
import { getUserSubmission } from '../services/submissionService.js';
import { getGroupChatTitle } from '../storage/groupChats.js';
import { clearMenuMessage, getMenuMessage, setMenuMessage } from '../storage/menuMessages.js';

export const SUBMIT_ACTION = 'submit';
export const DECLINE_ACTION = 'decline';

// Same weekday labeling as schedule.ts's/help.ts's own copies — duplicated rather than shared, since
// it's one short const array and this file has no other reason to depend on either of theirs.
const WEEKDAY_LABELS = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

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

export function buildMenuText(groupChatId: number, userId: number): string {
  const submission = getUserSubmission(groupChatId, userId);
  const deadlineLine = `<i>⏰ Дедлайн: ${deadlineLabel(groupChatId)}</i>\n\n`;
  if (submission?.status === 'declined') {
    return `${deadlineLine}🙅 Ок, зрозуміли — цього тижня тебе не буде.\n\nПлани зміняться — тисни кнопку нижче 👇`;
  }
  return submission
    ? `${deadlineLine}📍 Твій вибір цього тижня: ${placeLink(submission.place)}\n\n${pickRandom(HAS_SUBMISSION_MENU_POOL)}`
    : `${deadlineLine}🍽 ${pickRandom(EMPTY_MENU_POOL)}`;
}

export function buildMenuKeyboard(groupChatId: number, userId: number) {
  const submission = getUserSubmission(groupChatId, userId);
  const declined = submission?.status === 'declined';
  // While declined, "➕ Додати" would be a second button leading to the exact same "send me a
  // link" prompt as cancelling the decline (see handleDeclineAction) — so it's dropped here rather
  // than shown redundantly alongside it.
  return Markup.inlineKeyboard([
    ...(declined ? [] : [[Markup.button.callback(submission?.status === 'submitted' ? '✏️ Змінити' : '➕ Додати', SUBMIT_ACTION)]]),
    [Markup.button.callback(declined ? '↩️ Скасувати «не йду»' : '🙅 Не йду цього тижня', DECLINE_ACTION)],
  ]);
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
