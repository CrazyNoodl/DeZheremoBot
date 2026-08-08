import * as Sentry from '@sentry/node';
import { TelegramError, type Telegram } from 'telegraf';
import { listGroupChats, removeGroupChat } from '../storage/groupChats.js';

async function sendAndTrack(
  telegram: Telegram,
  chatId: number,
  text: string,
  extra?: object,
  deleteAfterMs?: number,
): Promise<void> {
  try {
    const message = await telegram.sendMessage(chatId, text, extra);
    if (deleteAfterMs !== undefined) {
      setTimeout(() => {
        telegram.deleteMessage(chatId, message.message_id).catch(() => {});
      }, deleteAfterMs);
    }
  } catch (err) {
    if (err instanceof TelegramError && err.code === 403) {
      removeGroupChat(chatId);
    } else {
      // Not the "bot got kicked" case — a real send failure (network, rate limit, bad request).
      // Nothing else observes this, so at minimum it must be logged rather than silently dropped.
      console.error(`[telegramBroadcast] failed to send message to chat ${chatId}:`, err);
      Sentry.captureException(err);
    }
  }
}

export async function broadcast(
  telegram: Telegram,
  text: string,
  extra?: object,
  deleteAfterMs?: number,
): Promise<void> {
  for (const chatId of listGroupChats()) {
    await sendAndTrack(telegram, chatId, text, extra, deleteAfterMs);
  }
}

export async function sendToChat(
  telegram: Telegram,
  chatId: number,
  text: string,
  extra?: object,
  deleteAfterMs?: number,
): Promise<void> {
  await sendAndTrack(telegram, chatId, text, extra, deleteAfterMs);
}

// A DM to a specific user (e.g. the rating survey) is not a group broadcast: a 403 here means that
// one user blocked the bot in their private chat, not that the bot got kicked from a group, so it
// must not call removeGroupChat(userId) (harmless today only because a user id never collides with
// a registered group chat id — still the wrong storage call to make). Unlike sendAndTrack's group
// path, this logs every failure, 403 included, since a silently-undelivered survey DM would
// otherwise vanish with no trace of who never got asked.
export async function sendDirectMessage(telegram: Telegram, userId: number, text: string, extra?: object): Promise<void> {
  try {
    await telegram.sendMessage(userId, text, extra);
  } catch (err) {
    console.warn(`[telegramBroadcast] failed to DM user ${userId} (blocked the bot?):`, err);
    Sentry.captureException(err);
  }
}
