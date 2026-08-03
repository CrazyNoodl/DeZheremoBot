import * as Sentry from '@sentry/node';
import { Markup, type Context } from 'telegraf';
import { addOrUpdateRating, markAsAbsent } from '../storage/placeRatings.js';
import { safeAnswerCbQuery } from './panel.js';

export const RATE_ACTION_PREFIX = 'rate:';

// Distinct from any of "1".."5" so handleRateAction can tell "didn't attend" apart from a star
// count without a separate callback_data prefix.
const ABSENT_VALUE = 'absent';

// Plain numbers, not '⭐'.repeat(n): Telegram truncates a long button label to "⭐...⭐", so 4/5
// stars rendered as unreadable ellipsized buttons instead of a visible count.
export function buildRatingKeyboard(drawId: number) {
  return Markup.inlineKeyboard([
    [1, 2, 3, 4, 5].map((n) => Markup.button.callback(String(n), `rate:${drawId}:${n}`)),
    [Markup.button.callback('🙅 Мене не було', `rate:${drawId}:${ABSENT_VALUE}`)],
  ]);
}

// Colon-delimited callback_data (like sched:/admin:), not menu.ts's bare-action/tracked-state
// convention: this needs drawId embedded, and there's no per-user tracked card to recover it from.
// No membership/staleness re-check is needed either — this is always a 1:1 private chat with the
// tapping user, so there's no cross-user surface, and a second tap just upserts a new value.
export async function handleRateAction(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const query = ctx.callbackQuery;
  const data = query && 'data' in query ? query.data : undefined;
  const message = query && 'message' in query ? query.message : undefined;

  if (!userId || !data || !message) {
    if (query) await safeAnswerCbQuery(ctx);
    return;
  }

  const [, drawIdStr, valueStr] = data.split(':');
  const drawId = Number(drawIdStr);

  let confirmationText: string;
  // Someone who submitted a place can still end up not going (plans fall through last-minute) —
  // asking them to rate a visit that never happened for them doesn't make sense, so this records a
  // distinct "didn't attend" answer instead of forcing a 1-5 pick.
  if (valueStr === ABSENT_VALUE) {
    markAsAbsent(drawId, userId);
    confirmationText = 'Дякуємо, врахували — тебе не було 🙅';
  } else {
    const stars = Number(valueStr);
    addOrUpdateRating(drawId, userId, stars);
    // A short reaction to the score itself, not just an acknowledgement that it was recorded — the
    // tail varies by tier, but "Дякуємо, оцінка: N⭐" stays fixed so this message is still
    // recognizable as the same confirmation every time.
    const reaction =
      stars === 5
        ? 'раді, що зайшло на славу! 🤩'
        : stars === 4
          ? 'непогано вийшло! 😋'
          : stars === 3
            ? 'бувало й краще 🙂'
            : 'врахуємо на майбутнє 😬';
    confirmationText = `Дякуємо, оцінка: ${stars}⭐ — ${reaction}`;
  }

  await safeAnswerCbQuery(ctx, 'Дякуємо за відповідь!');

  try {
    await ctx.telegram.editMessageText(message.chat.id, message.message_id, undefined, confirmationText, Markup.inlineKeyboard([]));
  } catch (err) {
    console.warn(`[rating] failed to edit rating message for user ${userId}:`, err);
    Sentry.captureException(err);
  }
}
