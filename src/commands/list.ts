import type { Context } from 'telegraf';
import { getAllSubmissions } from '../services/submissionService.js';
import { isChatMember } from './access.js';
import { withGroupLabel } from './menuMessage.js';

export async function showSubmissionsList(ctx: Context, chatId: number): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId || !(await isChatMember(ctx, chatId, userId))) {
    await ctx.reply('🔒 Ти не учасник цієї групи.');
    return;
  }

  const submissions = getAllSubmissions(chatId);
  const text = submissions.length === 0
    ? 'Ще ніхто нічого не додав 🤷'
    : submissions.map((s) => `• ${s.username}: ${s.place}`).join('\n');

  await ctx.reply(withGroupLabel(chatId, text));
}
