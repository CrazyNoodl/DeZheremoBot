import * as Sentry from '@sentry/node';
import { Markup, type Context } from 'telegraf';
import { clearAwaitingSubmission, getAwaitingChatId, isCurrentAwaitingToken, markAwaitingSubmission } from '../storage/pendingState.js';
import { buildMenuKeyboard, buildMenuText, updateMenuMessage } from './menuMessage.js';
import { safeAnswerCbQuery } from './panel.js';

// Shown both when prompting for a place and when a submitted one fails format validation
// (services/submissionService.ts's isValidPlaceLink) — keeps the accepted formats worded
// identically in both places.
export const PLACE_LINK_FORMAT_HINT =
  '🔗 Поки що приймаються тільки посилання на заклад:\n' +
  '• expz.menu — напр. https://expz.menu/d0838ea9-b9ae-44dd-b99d-993f0a0206fd\n' +
  '• Google Maps — напр. https://maps.app.goo.gl/uKwFMyv1DMrUtZua8\n' +
  '• Instagram — напр. https://www.instagram.com/milkbarkyiv\n\n' +
  'Спробуй ще раз 👇';

// Shown alongside the prompt (and every retry of it — too-long/invalid-format/rate-limited replies
// in commands/text.ts reuse this exact keyboard) so someone who tapped "✏️ Змінити"/"➕ Додати" but
// changed their mind isn't stuck either typing a link or waiting out the 1h TTL.
export const CANCEL_AWAITING_ACTION = 'cancel_awaiting';
export const CANCEL_AWAITING_KEYBOARD = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Скасувати', CANCEL_AWAITING_ACTION)]]);

// commands/text.ts checks getAwaitingChatId before treating a message as a submission, so a prompt
// left unanswered (user abandons it, or gets here via handleDeclineAction's cancel and never
// actually types a place) would otherwise silently swallow every later text message from that user
// as an attempted place submission, forever — same reasoning as schedule.ts's SCHEDULE_EDIT_TTL_MS.
const AWAITING_SUBMISSION_TTL_MS = 60 * 60 * 1000;

export async function promptForPlace(ctx: Context, groupChatId: number): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const token = markAwaitingSubmission(userId, groupChatId);
  setTimeout(() => {
    // Not the current prompt anymore — either already resolved (submitted/rejected) or superseded
    // by a newer promptForPlace call for this user, whose own timer owns the cleanup instead.
    if (!isCurrentAwaitingToken(userId, token)) return;
    clearAwaitingSubmission(userId);
    // Runs on a bare setTimeout, outside any Telegraf handler — unlike every other
    // updateMenuMessage call in this codebase, a throw here has no bot.catch(...) safety net to
    // land in, so it must be logged here directly rather than silently swallowed.
    updateMenuMessage(ctx, groupChatId, userId, buildMenuText(groupChatId, userId), buildMenuKeyboard(groupChatId, userId)).catch(
      (err) => {
        console.error(`[add] TTL revert failed for user ${userId}:`, err);
        Sentry.captureException(err);
      },
    );
  }, AWAITING_SUBMISSION_TTL_MS);

  await updateMenuMessage(
    ctx,
    groupChatId,
    userId,
    '🍽 Куди хочеться цього разу? Надішли посилання на заклад — з expz.menu, Google Maps ' +
      '(maps.app.goo.gl) або Instagram.\n\n' +
      'Наприклад: https://expz.menu/d0838ea9-b9ae-44dd-b99d-993f0a0206fd, ' +
      'https://maps.app.goo.gl/uKwFMyv1DMrUtZua8 або https://www.instagram.com/milkbarkyiv',
    CANCEL_AWAITING_KEYBOARD,
  );
}

// Backs out of the "awaiting a place" prompt without submitting anything — the counterpart to
// promptForPlace, reachable from its "⬅️ Скасувати" button (and from the same button shown again
// on a too-long/invalid-format/rate-limited retry in commands/text.ts). A no-op if the prompt was
// already resolved or had already expired by the time this tap lands (getAwaitingChatId undefined).
export async function handleCancelAwaitingAction(ctx: Context): Promise<void> {
  if (ctx.callbackQuery) {
    await safeAnswerCbQuery(ctx);
  }

  const userId = ctx.from?.id;
  if (!userId) return;

  const groupChatId = getAwaitingChatId(userId);
  if (groupChatId === undefined) return;

  clearAwaitingSubmission(userId);
  await updateMenuMessage(ctx, groupChatId, userId, buildMenuText(groupChatId, userId), buildMenuKeyboard(groupChatId, userId));
}
