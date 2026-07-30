import type { Context } from 'telegraf';
import { escapeHtml, placeLink } from '../htmlFormat.js';
import { isChatMember } from './access.js';
import { promptForPlace } from './add.js';
import { DECLINE_GROUP_ACTION } from './keyboard.js';
import { buildMenuKeyboard, buildMenuText, DECLINE_ACTION, sendMenuMessage, SUBMIT_ACTION, updateMenuMessage } from './menuMessage.js';
import { safeAnswerCbQuery } from './panel.js';
import {
  declinePlace,
  getUserSubmission,
  isGroupPaused,
  isSubmissionLocked,
  isUserBlocked,
} from '../services/submissionService.js';
import { getMenuMessage } from '../storage/menuMessages.js';
import { sendToChat } from '../telegramBroadcast.js';

export { SUBMIT_ACTION, DECLINE_ACTION, DECLINE_GROUP_ACTION };

// Exported so text.ts's rejection replies for the same two states reuse these literals instead of
// retyping them — one string each, so wording can't drift between "opening the menu while
// blocked/paused" and "typing a place while blocked/paused".
export const PAUSED_MESSAGE = '⏸ Цього тижня ДеЖеремо на паузі — заявки поки не приймаються. Скоро повернемось!';
export const BLOCKED_MESSAGE = '🚫 Тебе заблокували в цій групі — додавати заявки більше не можна.';
const LOCKED_MESSAGE = '🔒 Заявки на цей тиждень уже закрито';

const STALE_MENU_TAP_MESSAGE = '🔄 Ця картка вже застаріла — онови меню командою /start, там уже інший стан.';

// Telegram never expires old inline buttons — if the tapped message isn't the one this user's
// card is currently tracked as (storage/menuMessages.ts), something already updated the *real*
// tracked card since this one was rendered (a later action edited it in place, or it aged past
// the 48h edit window and a fresh message replaced it). Acting on a stale card's button would
// apply whatever it implies (e.g. "Скасувати «не йду»") against the *current* actual state
// instead of the state the user is looking at — e.g. tapping a stale cancel-decline button while
// you've since resubmitted a place would silently decline you again instead of doing nothing.
function isStaleMenuTap(ctx: Context, userId: number): boolean {
  const query = ctx.callbackQuery;
  const tappedMessageId = query && 'message' in query ? query.message?.message_id : undefined;
  const trackedMessageId = getMenuMessage(userId)?.messageId;
  return tappedMessageId !== undefined && trackedMessageId !== undefined && tappedMessageId !== trackedMessageId;
}

// Shared by showPersonalMenu and handleSubmitAction, which both need the exact same
// blocked → paused → locked precedence and messages before doing anything group-cycle-specific.
// Renders the relevant notice and returns true if one of these gates applies, so the caller just
// has to `return` when this returns true and fall through to its own logic otherwise.
async function renderGateIfBlocked(ctx: Context, groupChatId: number, userId: number): Promise<boolean> {
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

export async function showPersonalMenu(ctx: Context, groupChatId: number): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  if (!(await isChatMember(ctx, groupChatId, userId))) {
    await ctx.reply('🔒 Здається, ти не в цій групі.');
    return;
  }

  if (await renderGateIfBlocked(ctx, groupChatId, userId)) return;

  await sendMenuMessage(ctx, groupChatId, userId, buildMenuText(groupChatId, userId));
}

export async function handleSubmitAction(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const groupChatId = userId !== undefined ? getMenuMessage(userId)?.groupChatId : undefined;
  if (!userId || groupChatId === undefined) {
    if (ctx.callbackQuery) await safeAnswerCbQuery(ctx);
    return;
  }

  if (isStaleMenuTap(ctx, userId)) {
    await safeAnswerCbQuery(ctx, STALE_MENU_TAP_MESSAGE, { show_alert: true });
    return;
  }

  await safeAnswerCbQuery(ctx);

  // Re-checked here, not just at showPersonalMenu time — the tracked menu card can outlive the
  // user's membership if they left the group after opening it (same reasoning as schedule.ts's
  // double admin-check).
  if (!(await isChatMember(ctx, groupChatId, userId))) {
    await ctx.reply('🔒 Здається, ти вже не в цій групі.');
    return;
  }

  if (await renderGateIfBlocked(ctx, groupChatId, userId)) return;

  await promptForPlace(ctx, groupChatId);
}

// Toggles "не йду цього тижня" from the personal menu's second button.
export async function handleDeclineAction(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const groupChatId = userId !== undefined ? getMenuMessage(userId)?.groupChatId : undefined;
  if (!userId || groupChatId === undefined) {
    if (ctx.callbackQuery) await safeAnswerCbQuery(ctx);
    return;
  }

  if (isStaleMenuTap(ctx, userId)) {
    await safeAnswerCbQuery(ctx, STALE_MENU_TAP_MESSAGE, { show_alert: true });
    return;
  }

  await safeAnswerCbQuery(ctx);

  if (!(await isChatMember(ctx, groupChatId, userId))) {
    await ctx.reply('🔒 Здається, ти вже не в цій групі.');
    return;
  }

  if (await renderGateIfBlocked(ctx, groupChatId, userId)) return;

  const username = ctx.from?.username ?? ctx.from?.first_name ?? 'Хтось';
  const result = declinePlace(groupChatId, userId, username);

  if (result.ok && !result.declined) {
    // Cancelling "не йду" means the user is coming after all and has no place submitted either
    // (declining always drops any previous place) — go straight into the same "send me a link"
    // prompt as SUBMIT_ACTION rather than back to an idle menu, since a place is exactly what's
    // missing now. The eventual submitPlace() call announces it to the group as a normal, fresh
    // submission — no separate announcement needed for the cancel itself.
    await promptForPlace(ctx, groupChatId);
    return;
  }

  if (result.ok && result.previousPlace !== undefined) {
    // Declining overwrote a place the group already saw announced — tell the group it's been
    // retracted. A decline with nothing to retract (result.previousPlace undefined) stays silent:
    // the group was never told about this user in the first place, so there's nothing to correct.
    await sendToChat(
      ctx.telegram,
      groupChatId,
      `🙅 <b>${escapeHtml(username)}</b> цього тижня не йде (варіант знято: ${placeLink(result.previousPlace)})`,
      { parse_mode: 'HTML' },
    );
  }

  await updateMenuMessage(ctx, groupChatId, userId, buildMenuText(groupChatId, userId), buildMenuKeyboard(groupChatId, userId));
}

// Unlike handleDeclineAction above, this is deliberately one-way ("record не йду"), not a toggle —
// fired straight from the group's own reminder/menu message rather than the private-chat personal
// menu, so no deep link is needed (a callback query fired from a group message already carries
// that group as ctx.chat). A shared group button can't change its own label per viewer the way
// the private menu's can (Telegram renders one keyboard for everyone who sees the message), so a
// second tap here must not silently cancel an already-recorded decline with no visible sign it
// just happened — it stays a no-op confirmation instead. Reversing a decline still works, just not
// through this button: submitting a real place (via "➕ Додати" in the private chat) already
// overwrites a decline automatically, same as it always has. All feedback (idempotent confirm,
// success, or blocked/paused/locked) goes out as a private answerCbQuery toast, since this shared
// message can't be edited into a per-user confirmation card either.
export async function handleGroupDeclineAction(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (!chatId || !userId) return;

  if (!(await isChatMember(ctx, chatId, userId))) {
    await safeAnswerCbQuery(ctx, '🔒 Здається, ти вже не в цій групі.', { show_alert: true });
    return;
  }

  if (isUserBlocked(chatId, userId)) {
    await safeAnswerCbQuery(ctx, BLOCKED_MESSAGE, { show_alert: true });
    return;
  }

  if (isGroupPaused(chatId)) {
    await safeAnswerCbQuery(ctx, PAUSED_MESSAGE, { show_alert: true });
    return;
  }

  if (isSubmissionLocked(chatId)) {
    await safeAnswerCbQuery(ctx, LOCKED_MESSAGE, { show_alert: true });
    return;
  }

  if (getUserSubmission(chatId, userId)?.status === 'declined') {
    await safeAnswerCbQuery(ctx, '🙅 Ти вже позначив(-ла), що не йдеш цього тижня.');
    return;
  }

  const username = ctx.from?.username ?? ctx.from?.first_name ?? 'Хтось';
  const result = declinePlace(chatId, userId, username);

  if (!result.ok) {
    // Rare race — state changed between the checks above and this call. Same messages as above.
    const message =
      result.reason === 'blocked' ? BLOCKED_MESSAGE : result.reason === 'paused' ? PAUSED_MESSAGE : LOCKED_MESSAGE;
    await safeAnswerCbQuery(ctx, message, { show_alert: true });
    return;
  }

  if (result.previousPlace !== undefined) {
    await sendToChat(
      ctx.telegram,
      chatId,
      `🙅 <b>${escapeHtml(username)}</b> цього тижня не йде (варіант знято: ${placeLink(result.previousPlace)})`,
      { parse_mode: 'HTML' },
    );
  }

  await safeAnswerCbQuery(ctx, '🙅 Записано: не йдеш цього тижня.');
}
