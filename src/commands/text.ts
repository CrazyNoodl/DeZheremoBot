import type { Context } from 'telegraf';
import { escapeHtml, placeLink } from '../htmlFormat.js';
import { clearAwaitingSubmission, getAwaitingChatId } from '../storage/pendingState.js';
import { MAX_PLACE_LENGTH, submitPlace } from '../services/submissionService.js';
import { sendToChat } from '../telegramBroadcast.js';
import { PLACE_LINK_FORMAT_HINT } from './add.js';
import { buildMenuKeyboard, buildMenuText, updateMenuMessage } from './menuMessage.js';
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
  if (chatId === undefined) return;

  const place = text;
  const username = ctx.from?.username ?? ctx.from?.first_name ?? 'Хтось';

  const result = submitPlace(chatId, userId, username, place);

  if (!result.ok) {
    // Invalid input, not a terminal outcome — leave the user "awaiting" so they can just
    // retype without pressing the button again.
    if (result.reason === 'too_long' || result.reason === 'rate_limited' || result.reason === 'invalid_format') {
      const text = result.reason === 'too_long'
        ? `✂️ Ого, це ціла історія! Стисни до ${MAX_PLACE_LENGTH} символів — і все вийде.`
        : result.reason === 'invalid_format'
          ? PLACE_LINK_FORMAT_HINT
          : '⏳ Не поспішай так — ще трохи і зможеш змінити знову.';
      await updateMenuMessage(ctx, chatId, userId, text);
      await ctx.deleteMessage();
      return;
    }

    clearAwaitingSubmission(userId);
    const text =
      result.reason === 'locked'
        ? '🔒 Запізно — заявки на цей тиждень уже закрито. До зустрічі наступного тижня!'
        : result.reason === 'paused'
          ? '⏸ Цього тижня ДеЖеремо на паузі — заявки поки не приймаються. Скоро повернемось!'
          : `Це вже твій поточний варіант — міняти нічого 😉\n\n${buildMenuText(chatId, userId)}`;
    const keyboard = result.reason === 'locked' || result.reason === 'paused' ? undefined : buildMenuKeyboard(chatId, userId);
    await updateMenuMessage(ctx, chatId, userId, text, keyboard);
    await ctx.deleteMessage();
    return;
  }

  clearAwaitingSubmission(userId);

  const previousPlace = result.previousPlace;
  const confirmation = previousPlace !== undefined
    ? `Готово! Змінено на: ${placeLink(place)} (було: ${placeLink(previousPlace)}) 👍`
    : `Готово! Додано: ${placeLink(place)} 🎉`;

  await updateMenuMessage(
    ctx,
    chatId,
    userId,
    `${confirmation}\n\n${buildMenuText(chatId, userId)}`,
    buildMenuKeyboard(chatId, userId),
  );
  await sendToChat(
    ctx.telegram,
    chatId,
    previousPlace !== undefined
      ? `🔄 <b>${escapeHtml(username)}</b> оновлює варіант: ${placeLink(place)}`
      : `🍽 <b>${escapeHtml(username)}</b> пропонує варіант: ${placeLink(place)}`,
    { parse_mode: 'HTML' },
  );
  await ctx.deleteMessage();
}
