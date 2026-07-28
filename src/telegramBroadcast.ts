import { TelegramError, type Telegram } from 'telegraf';
import { listGroupChats, removeGroupChat } from './storage/groupChats.js';

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
