import type { Context } from 'telegraf';
import { escapeHtml, placeLink } from '../htmlFormat.js';
import { clearAwaitingSubmission, getAwaitingChatId } from '../storage/pendingState.js';
import { MAX_PLACE_LENGTH, submitPlace } from '../services/submissionService.js';
import { sendToChat } from '../telegramBroadcast.js';
import { isChatMember } from './access.js';
import { CANCEL_AWAITING_KEYBOARD, PLACE_LINK_FORMAT_HINT } from './add.js';
import { buildMenuKeyboard, buildMenuText, updateMenuMessage } from './menuMessage.js';
import { BLOCKED_MESSAGE, PAUSED_MESSAGE } from './menu.js';
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

  if (!result.ok) {
    // Invalid input, not a terminal outcome — leave the user "awaiting" so they can just
    // retype without pressing the button again.
    if (result.reason === 'too_long' || result.reason === 'rate_limited' || result.reason === 'invalid_format') {
      const text = result.reason === 'too_long'
        ? `✂️ Ого, це ціла історія! Стисни до ${MAX_PLACE_LENGTH} символів — і все вийде.`
        : result.reason === 'invalid_format'
          ? PLACE_LINK_FORMAT_HINT
          : '⏳ Не поспішай так — ще трохи і зможеш змінити знову.';
      await updateMenuMessage(ctx, chatId, userId, text, CANCEL_AWAITING_KEYBOARD);
      await ctx.deleteMessage();
      return;
    }

    clearAwaitingSubmission(userId);
    const text =
      result.reason === 'locked'
        ? '🔒 Запізно — заявки на цей тиждень уже закрито. До зустрічі наступного тижня!'
        : result.reason === 'paused'
          ? PAUSED_MESSAGE
          : result.reason === 'blocked'
            ? BLOCKED_MESSAGE
            : `Це вже твій поточний варіант — міняти нічого 😉\n\n${buildMenuText(chatId, userId)}`;
    const keyboard =
      result.reason === 'locked' || result.reason === 'paused' || result.reason === 'blocked'
        ? undefined
        : buildMenuKeyboard(chatId, userId);
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
