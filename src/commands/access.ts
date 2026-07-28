import type { Context } from 'telegraf';
import { listGroupChats } from '../storage/groupChats.js';

export async function isChatMember(ctx: Context, chatId: number, userId: number): Promise<boolean> {
  try {
    const member = await ctx.telegram.getChatMember(chatId, userId);
    return member.status !== 'left' && member.status !== 'kicked';
  } catch {
    return false;
  }
}

export async function isGroupAdmin(ctx: Context, chatId: number, userId: number): Promise<boolean> {
  const member = await ctx.telegram.getChatMember(chatId, userId);
  return member.status === 'creator' || member.status === 'administrator';
}

// Shared by /schedule and /admin: both have no chat-id context of their own (typed directly in a
// private chat), so both need to scan every known group to find which ones this user administers.
// A lookup failure for any one chat (bot no longer a member, API hiccup) is treated as "not admin
// there" rather than aborting the whole scan.
export async function findAdminGroupChats(ctx: Context, userId: number): Promise<number[]> {
  const adminChatIds: number[] = [];
  for (const chatId of listGroupChats()) {
    try {
      if (await isGroupAdmin(ctx, chatId, userId)) adminChatIds.push(chatId);
    } catch {
      // bot lost access to this chat, or the lookup failed — treat as "not admin there"
    }
  }
  return adminChatIds;
}
