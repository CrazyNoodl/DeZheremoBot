import { Markup, TelegramError, type Context } from 'telegraf';
import { createPanelMessageStore, type PanelMessageRef } from '../storage/panelMessages.js';

// Shared edit-in-place tracked-message logic for /schedule's and /admin's panels — including the
// Map<userId, ref> storage behind it: /admin.ts and schedule.ts each implemented the exact same
// track/send/update behavior, backed by their own near-identical storage module, independently
// before this existed. menuMessage.ts's personal-menu card is close but genuinely different (HTML
// formatting + a group-label text prefix + an extra tracked field it re-sets after every edit), so
// it keeps its own copy of both the storage and the send/update logic rather than being forced
// through this one.
export function createPanel(ttlMs: number, logLabel: string) {
  const store = createPanelMessageStore<PanelMessageRef>();

  function track(ctx: Context, userId: number, chatId: number, messageId: number): void {
    store.set(userId, { chatId, messageId });
    setTimeout(() => {
      const ref = store.get(userId);
      if (ref?.messageId !== messageId) return; // superseded by a newer panel message already
      store.clear(userId);
      ctx.telegram.deleteMessage(chatId, messageId).catch(() => {});
    }, ttlMs);
  }

  async function send(
    ctx: Context,
    userId: number,
    text: string,
    keyboard: ReturnType<typeof Markup.inlineKeyboard>,
  ): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const sent = await ctx.reply(text, keyboard);
    track(ctx, userId, chatId, sent.message_id);
  }

  async function update(
    ctx: Context,
    userId: number,
    text: string,
    keyboard: ReturnType<typeof Markup.inlineKeyboard> = Markup.inlineKeyboard([]),
  ): Promise<void> {
    const ref = store.get(userId);

    if (ref) {
      try {
        await ctx.telegram.editMessageText(ref.chatId, ref.messageId, undefined, text, keyboard);
        return;
      } catch (err) {
        // Telegram rejects an edit whose text+keyboard exactly match the current message —
        // that's a no-op, not a failure, so don't fall through to sending a duplicate.
        if (err instanceof TelegramError && err.description?.includes('message is not modified')) {
          return;
        }
        console.warn(`[${logLabel}] panel edit failed for user ${userId}, sending a fresh message instead:`, err);
      }
    }

    await send(ctx, userId, text, keyboard);
  }

  return { track, send, update };
}

// A callback query can go stale (old message, or already answered) between the button being
// pressed and this running — Telegram then rejects answerCbQuery with a 400, which must not be
// allowed to crash the whole bot process. Shared by every callback-driven panel (personal menu,
// /schedule, /admin).
export async function safeAnswerCbQuery(
  ctx: Context,
  text?: string,
  extra?: { show_alert?: boolean },
): Promise<void> {
  try {
    await ctx.answerCbQuery(text, extra);
  } catch {
    // stale callback query — nothing to do
  }
}
