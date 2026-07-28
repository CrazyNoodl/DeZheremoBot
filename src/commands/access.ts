import type { Context } from 'telegraf';

export async function isChatMember(ctx: Context, chatId: number, userId: number): Promise<boolean> {
  try {
    const member = await ctx.telegram.getChatMember(chatId, userId);
    return member.status !== 'left' && member.status !== 'kicked';
  } catch {
    return false;
  }
}
