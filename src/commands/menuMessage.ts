import { Markup, type Context } from 'telegraf';
import { escapeHtml, placeLink } from '../htmlFormat.js';
import { getUserSubmission } from '../services/submissionService.js';
import { getGroupChatTitle } from '../storage/groupChats.js';
import { clearMenuMessage, getMenuMessage, setMenuMessage } from '../storage/menuMessages.js';

export const SUBMIT_ACTION = 'submit';

// Telegram bots can't edit messages older than this — once a menu message ages
// out of that window, delete it instead of leaving a dead card in the chat.
const MENU_MESSAGE_TTL_MS = 48 * 60 * 60 * 1000;

// Prefixes every card/prompt with the group name, since one user can be in several groups
// running this bot and the private chat only ever shows one shared card at a time.
export function withGroupLabel(groupChatId: number, text: string): string {
  const title = getGroupChatTitle(groupChatId);
  return title ? `📍 ${escapeHtml(title)}\n\n${text}` : text;
}

export function buildMenuText(groupChatId: number, userId: number): string {
  const submission = getUserSubmission(groupChatId, userId);
  return submission
    ? `📍 Твій варіант цього тижня: ${placeLink(submission.place)}\n\nХочеш змінити — тисни кнопку нижче 👇`
    : '🤔 Ще нема варіанту на цей тиждень? Додай посилання на заклад — тисни кнопку нижче 👇';
}

export function buildMenuKeyboard(groupChatId: number, userId: number) {
  const submission = getUserSubmission(groupChatId, userId);
  return Markup.inlineKeyboard([
    [Markup.button.callback(submission ? '✏️ Змінити' : '➕ Додати', SUBMIT_ACTION)],
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

  const sent = await ctx.reply(withGroupLabel(groupChatId, text), { parse_mode: 'HTML', ...keyboard });
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
        ...keyboard,
      });
      setMenuMessage(userId, ref.chatId, ref.messageId, groupChatId); // this card now represents groupChatId's cycle
      return;
    } catch (err) {
      // too old to edit (past Telegram's window) or deleted — fall through to a fresh message.
      // Logged at warn rather than error: expected to happen occasionally, but a spike would
      // otherwise be invisible.
      console.warn(`[menuMessage] edit failed for user ${userId}, sending a fresh message instead:`, err);
    }
  }

  await sendMenuMessage(ctx, groupChatId, userId, text, keyboard);
}
