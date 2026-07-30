import type { Context } from 'telegraf';
import { clearAwaitingSubmission, getAwaitingChatId } from '../storage/pendingState.js';
import { submitPlace } from '../services/submissionService.js';
import { isChatMember } from './access.js';
import { CANCEL_AWAITING_KEYBOARD } from './add.js';
import { updateMenuMessage } from './menuMessage.js';
import { renderSubmitOutcome } from './menu.js';
import { handleScheduleTextStep } from './schedule.js';

export async function handleTextMessage(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const message = ctx.message;
  if (!userId || !message || !('text' in message)) return;

  const text = message.text.trim();

  if (await handleScheduleTextStep(ctx, userId, text)) {
    await ctx.deleteMessage();
    return;
  }

  const chatId = getAwaitingChatId(userId);
  if (chatId === undefined) {
    // Plain text with no pending prompt has nowhere to go — in a group this is just people
    // chatting and must stay silent, but in a private chat with the bot it used to vanish with
    // zero feedback, which reads as a broken bot rather than "there's nothing for me to do with
    // this." Nudge back to the menu instead of ignoring it.
    if (ctx.chat?.type === 'private') {
      await ctx.reply('🤔 Не розумію звичайний текст. Онови меню командою /start або глянь /help, як усе працює.');
      await ctx.deleteMessage();
    }
    return;
  }

  // The awaiting state can outlive the user's membership (it's set when they opened the prompt,
  // consumed up to an hour later) — re-check here too, not just at showPersonalMenu/
  // handleSubmitAction time, same reasoning as menu.ts's own re-checks: without this, someone who
  // left or was kicked after starting the prompt could still submit into and be announced to a
  // group they're no longer a member of.
  if (!(await isChatMember(ctx, chatId, userId))) {
    clearAwaitingSubmission(userId);
    await updateMenuMessage(ctx, chatId, userId, '🔒 Здається, ти вже не в цій групі.');
    await ctx.deleteMessage();
    return;
  }

  const place = text;
  const username = ctx.from?.username ?? ctx.from?.first_name ?? 'Хтось';

  const result = submitPlace(chatId, userId, username, place);

  // Invalid input (too-long/invalid-format/rate-limited) is not a terminal outcome — leave the
  // user "awaiting" so they can just retype without pressing the button again. Every other
  // outcome (success, or a terminal rejection) resolves the prompt.
  const retryable = !result.ok && (result.reason === 'too_long' || result.reason === 'rate_limited' || result.reason === 'invalid_format');
  if (!retryable) {
    clearAwaitingSubmission(userId);
  }

  await renderSubmitOutcome(ctx, chatId, userId, username, place, result, CANCEL_AWAITING_KEYBOARD);
  await ctx.deleteMessage();
}
