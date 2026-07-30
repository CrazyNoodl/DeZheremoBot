import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from 'telegraf';
import { handleCancelAwaitingAction, promptForPlace } from './add.js';
import { clearAwaitingSubmission, getAwaitingChatId } from '../storage/pendingState.js';

function fakeCtx(userId: number) {
  const replies: string[] = [];
  const answers: string[] = [];
  const ctx = {
    from: { id: userId },
    chat: { id: userId },
    callbackQuery: undefined as { data: string } | undefined,
    telegram: {
      editMessageText: async () => {
        throw new Error('no message tracked to edit in this test');
      },
    },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: 1 };
    },
    answerCbQuery: async (text?: string) => {
      if (text) answers.push(text);
    },
  };
  return { ctx: ctx as unknown as Context, rawCtx: ctx, replies, answers };
}

test('promptForPlace marks the user awaiting a submission for that group', async () => {
  const userId = 14001;
  const groupChatId = -13001;

  await promptForPlace(fakeCtx(userId).ctx, groupChatId);

  assert.equal(getAwaitingChatId(userId), groupChatId);
});

test('promptForPlace auto-clears the awaiting state and reverts the menu card if nothing arrives within the TTL', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const userId = 14002;
  const groupChatId = -13002;
  const { ctx, replies } = fakeCtx(userId);

  await promptForPlace(ctx, groupChatId);
  assert.equal(getAwaitingChatId(userId), groupChatId);

  t.mock.timers.tick(60 * 60 * 1000);
  await Promise.resolve(); // let the timer's async updateMenuMessage settle

  assert.equal(getAwaitingChatId(userId), undefined);
  // the initial prompt + the reverted card = 2 replies (editMessageText always throws here)
  assert.equal(replies.length, 2);
  assert.doesNotMatch(replies[1], /Куди хочеться/);
});

test('promptForPlace does not revert the card again if the awaiting state already resolved before the TTL fires', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const userId = 14003;
  const groupChatId = -13003;
  const { ctx, replies } = fakeCtx(userId);

  await promptForPlace(ctx, groupChatId);
  clearAwaitingSubmission(userId); // simulates text.ts resolving it (submitted or a terminal rejection)

  t.mock.timers.tick(60 * 60 * 1000);
  await Promise.resolve();

  assert.equal(replies.length, 1); // only the original prompt, no extra revert message
});

test('handleCancelAwaitingAction clears the awaiting state and reverts the card back to the menu', async () => {
  const userId = 14005;
  const groupChatId = -13005;
  const { ctx, rawCtx, replies } = fakeCtx(userId);
  await promptForPlace(ctx, groupChatId);
  assert.equal(getAwaitingChatId(userId), groupChatId);

  rawCtx.callbackQuery = { data: 'cancel_awaiting' };
  await assert.doesNotReject(handleCancelAwaitingAction(ctx)); // answerCbQuery(ctx) with no text must not throw

  assert.equal(getAwaitingChatId(userId), undefined);
  assert.equal(replies.length, 2); // the prompt + the reverted card (editMessageText always throws here)
  assert.doesNotMatch(replies[1], /Куди хочеться/);
});

test('handleCancelAwaitingAction is a no-op when there is no active prompt to cancel', async () => {
  const userId = 14006;
  const { ctx, rawCtx, replies } = fakeCtx(userId);
  rawCtx.callbackQuery = { data: 'cancel_awaiting' };

  await handleCancelAwaitingAction(ctx);

  assert.equal(replies.length, 0);
});

test('promptForPlace called twice for the same user only reverts once, from the newer call', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const userId = 14004;
  const groupChatId = -13004;
  const { ctx, replies } = fakeCtx(userId);

  await promptForPlace(ctx, groupChatId); // superseded before its own TTL fires
  await promptForPlace(ctx, groupChatId); // this one's timer should be the one that actually reverts

  t.mock.timers.tick(60 * 60 * 1000);
  await Promise.resolve();

  assert.equal(getAwaitingChatId(userId), undefined);
  assert.equal(replies.length, 3); // 2 prompts + exactly 1 revert (not 2)
});
