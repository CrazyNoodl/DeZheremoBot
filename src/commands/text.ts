import type { Context } from 'telegraf';
import { clearAwaitingSubmission, getAwaitingChatId } from '../storage/pendingState.js';
import { MAX_PLACE_LENGTH, submitPlace } from '../services/submissionService.js';
import { sendToChat } from '../telegramBroadcast.js';
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
    if (result.reason === 'too_long' || result.reason === 'rate_limited') {
      const text = result.reason === 'too_long'
        ? `⚠️ Задовга назва (максимум ${MAX_PLACE_LENGTH} символів) — спробуй коротше.`
        : '⏳ Зачекай трохи перед наступною зміною.';
      await updateMenuMessage(ctx, chatId, userId, text);
      await ctx.deleteMessage();
      return;
    }

    clearAwaitingSubmission(userId);
    const text =
      result.reason === 'locked'
        ? '🔒 Запізно — прийом заявок на цьому тижні вже закритий.'
        : result.reason === 'paused'
          ? '⏸ Цикл цього тижня призупинено адміном — заявки тимчасово не приймаються.'
          : `Це вже твій поточний варіант — нічого не змінилось 🤷\n\n${buildMenuText(chatId, userId)}`;
    const keyboard = result.reason === 'locked' || result.reason === 'paused' ? undefined : buildMenuKeyboard(chatId, userId);
    await updateMenuMessage(ctx, chatId, userId, text, keyboard);
    await ctx.deleteMessage();
    return;
  }

  clearAwaitingSubmission(userId);

  const previousPlace = result.previousPlace;
  const confirmation = previousPlace !== undefined
    ? `Замінено: ${previousPlace} → ${place} ✅`
    : `Додано: ${place} ✅`;

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
      ? `🍽 ${username} змінює варіант: ${previousPlace} → ${place}`
      : `🍽 ${username} пропонує: ${place}`,
  );
  await ctx.deleteMessage();
}
