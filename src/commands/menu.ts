import type { Context } from 'telegraf';
import { escapeHtml, placeLink } from '../htmlFormat.js';
import { isChatMember } from './access.js';
import { promptForPlace } from './add.js';
import { buildMenuKeyboard, buildMenuText, DECLINE_ACTION, sendMenuMessage, SUBMIT_ACTION, updateMenuMessage } from './menuMessage.js';
import { safeAnswerCbQuery } from './panel.js';
import { declinePlace, isGroupPaused, isSubmissionLocked, isUserBlocked } from '../services/submissionService.js';
import { getMenuMessage } from '../storage/menuMessages.js';
import { sendToChat } from '../telegramBroadcast.js';

export { SUBMIT_ACTION, DECLINE_ACTION };

// Exported so text.ts's rejection replies for the same two states reuse these literals instead of
// retyping them — one string each, so wording can't drift between "opening the menu while
// blocked/paused" and "typing a place while blocked/paused".
export const PAUSED_MESSAGE = '⏸ Цього тижня ДеЖеремо на паузі — заявки поки не приймаються. Скоро повернемось!';
export const BLOCKED_MESSAGE = '🚫 Тебе заблокували в цій групі — додавати заявки більше не можна.';
const LOCKED_MESSAGE = '🔒 Заявки на цей тиждень уже закрито';

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
  if (ctx.callbackQuery) {
    await safeAnswerCbQuery(ctx);
  }

  const userId = ctx.from?.id;
  const groupChatId = userId !== undefined ? getMenuMessage(userId)?.groupChatId : undefined;
  if (!userId || groupChatId === undefined) return;

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
  if (ctx.callbackQuery) {
    await safeAnswerCbQuery(ctx);
  }

  const userId = ctx.from?.id;
  const groupChatId = userId !== undefined ? getMenuMessage(userId)?.groupChatId : undefined;
  if (!userId || groupChatId === undefined) return;

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
