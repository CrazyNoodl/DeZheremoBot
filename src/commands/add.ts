import type { Context } from 'telegraf';
import { markAwaitingSubmission } from '../storage/pendingState.js';
import { updateMenuMessage } from './menuMessage.js';

export async function promptForPlace(ctx: Context, groupChatId: number): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  markAwaitingSubmission(userId, groupChatId);
  await updateMenuMessage(ctx, groupChatId, userId, 'Напиши назву місця, куди підемо їсти 🍽');
}
