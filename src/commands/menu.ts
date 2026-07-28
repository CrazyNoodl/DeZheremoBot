import type { Context } from 'telegraf';
import { isChatMember } from './access.js';
import { promptForPlace } from './add.js';
import { buildMenuText, sendMenuMessage, SUBMIT_ACTION, updateMenuMessage } from './menuMessage.js';
import { isGroupPaused, isSubmissionLocked } from '../services/submissionService.js';
import { getMenuMessage } from '../storage/menuMessages.js';

export { SUBMIT_ACTION };

const PAUSED_MESSAGE = '⏸ Цикл цього тижня призупинено адміном — заявки тимчасово не приймаються';

// A callback query can go stale (double-tap, a menu card edited/replaced since the tap) between
// the button press and this running — Telegram then rejects answerCbQuery with a 400. This exact
// class of error once took the whole bot down before schedule.ts's callback flow was wrapped the
// same way (see safeAnswerCbQuery there); this is the equivalent guard for the submit button.
async function safeAnswerCbQuery(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();
  } catch {
    // stale callback query — nothing to do
  }
}

export async function showPersonalMenu(ctx: Context, groupChatId: number): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  if (!(await isChatMember(ctx, groupChatId, userId))) {
    await ctx.reply('🔒 Ти не учасник цієї групи.');
    return;
  }

  // Checked ahead of the lock check: pause and lock are independent flags, and a paused group
  // gets its own distinct message rather than the "closed for this week" lock text.
  if (isGroupPaused(groupChatId)) {
    await updateMenuMessage(ctx, groupChatId, userId, PAUSED_MESSAGE);
    return;
  }

  if (isSubmissionLocked(groupChatId)) {
    // Edits/reuses a stale tracked card if one exists, same as every other state change in this
    // private chat, instead of always creating a fresh message.
    await updateMenuMessage(ctx, groupChatId, userId, '🔒 Прийом заявок закритий на цьому тижні');
    return;
  }

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
    await ctx.reply('🔒 Ти більше не учасник цієї групи.');
    return;
  }

  if (isGroupPaused(groupChatId)) {
    await updateMenuMessage(ctx, groupChatId, userId, PAUSED_MESSAGE);
    return;
  }

  if (isSubmissionLocked(groupChatId)) {
    await updateMenuMessage(ctx, groupChatId, userId, '🔒 Прийом заявок закритий на цьому тижні');
    return;
  }

  await promptForPlace(ctx, groupChatId);
}
