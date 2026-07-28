import type { Context } from 'telegraf';
import { markAwaitingSubmission } from '../storage/pendingState.js';
import { updateMenuMessage } from './menuMessage.js';

// Shown both when prompting for a place and when a submitted one fails format validation
// (services/submissionService.ts's isValidPlaceLink) — keeps the accepted formats worded
// identically in both places.
export const PLACE_LINK_FORMAT_HINT =
  '🔗 Поки що приймаються тільки посилання на заклад:\n' +
  '• expz.menu — напр. https://expz.menu/d0838ea9-b9ae-44dd-b99d-993f0a0206fd\n' +
  '• Google Maps — напр. https://maps.app.goo.gl/uKwFMyv1DMrUtZua8\n' +
  '• Instagram — напр. https://www.instagram.com/milkbarkyiv\n\n' +
  'Спробуй ще раз 👇';

export async function promptForPlace(ctx: Context, groupChatId: number): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  markAwaitingSubmission(userId, groupChatId);
  await updateMenuMessage(
    ctx,
    groupChatId,
    userId,
    '🍽 Куди хочеться цього разу? Надішли посилання на заклад — з expz.menu, Google Maps ' +
      '(maps.app.goo.gl) або Instagram.\n\n' +
      'Наприклад: https://expz.menu/d0838ea9-b9ae-44dd-b99d-993f0a0206fd, ' +
      'https://maps.app.goo.gl/uKwFMyv1DMrUtZua8 або https://www.instagram.com/milkbarkyiv',
  );
}
