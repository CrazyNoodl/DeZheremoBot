import type { Context } from 'telegraf';
import { addGroupChat, removeGroupChat } from '../storage/groupChats.js';

export async function handleMyChatMember(ctx: Context): Promise<void> {
  const update = ctx.myChatMember;
  if (!update) return;
  if (update.chat.type !== 'group' && update.chat.type !== 'supergroup') return;

  const status = update.new_chat_member.status;
  if (status === 'left' || status === 'kicked') {
    removeGroupChat(update.chat.id);
  } else {
    addGroupChat(update.chat.id, update.chat.title);
  }
}

// Title was otherwise only ever captured once (on join, or backfilled by /start in the group) and
// never refreshed, so a renamed group kept showing its old "📍 <title>" label forever.
export async function handleNewChatTitle(ctx: Context): Promise<void> {
  const message = ctx.message;
  const chatId = ctx.chat?.id;
  if (!message || !chatId || !('new_chat_title' in message)) return;

  addGroupChat(chatId, message.new_chat_title);
}
