import type { Context } from 'telegraf';
import { escapeHtml, placeLink } from '../htmlFormat.js';
import { getAllSubmissions } from '../services/submissionService.js';
import { isChatMember } from './access.js';
import { withGroupLabel } from './menuMessage.js';

export async function showSubmissionsList(ctx: Context, chatId: number): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId || !(await isChatMember(ctx, chatId, userId))) {
    await ctx.reply('🔒 Здається, ти не в цій групі.');
    return;
  }

  const submissions = getAllSubmissions(chatId);
  const text = submissions.length === 0
    ? 'Поки що тиша... Хтось же має запропонувати перше місце! 🤷'
    : submissions
        .map((s) => `• <b>${escapeHtml(s.username)}</b>: ${s.status === 'declined' ? '🙅 не йде цього тижня' : placeLink(s.place)}`)
        .join('\n');

  await ctx.reply(withGroupLabel(chatId, text), { parse_mode: 'HTML' });
}
