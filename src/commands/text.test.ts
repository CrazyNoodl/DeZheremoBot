import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleTextMessage } from './text.js';
import { getAwaitingChatId, markAwaitingSubmission } from '../storage/pendingState.js';
import { blockUserFromGroup, lockSubmissions, MAX_PLACE_LENGTH, pauseGroup } from '../services/submissionService.js';

function fakeCtx(userId: number, text: string) {
  const replies: string[] = [];
  const deletions: number[] = [];
  const ctx = {
    from: { id: userId, username: 'tester' },
    chat: { id: userId }, // private chat id
    message: { text },
    reply: async (t: string) => {
      replies.push(t);
      return { message_id: 1 };
    },
    deleteMessage: async () => {
      deletions.push(1);
    },
    telegram: {
      sendMessage: async () => ({ message_id: 2 }),
    },
  };
  return { ctx: ctx as unknown as Parameters<typeof handleTextMessage>[0], replies, deletions };
}

test('a too-long place is rejected and keeps the user awaiting so they can retype', async () => {
  const userId = 13001;
  const chatId = -12001;
  markAwaitingSubmission(userId, chatId);
  const { ctx, replies, deletions } = fakeCtx(userId, 'x'.repeat(MAX_PLACE_LENGTH + 1));

  await handleTextMessage(ctx);

  assert.equal(getAwaitingChatId(userId), chatId);
  assert.equal(deletions.length, 1);
  assert.match(replies[0], new RegExp(String(MAX_PLACE_LENGTH)));
});

test('a locked chat rejects the submission and clears the awaiting state', async () => {
  const userId = 13002;
  const chatId = -12002;
  lockSubmissions(chatId);
  markAwaitingSubmission(userId, chatId);
  const { ctx, replies, deletions } = fakeCtx(userId, 'https://www.instagram.com/dezheroma');

  await handleTextMessage(ctx);

  assert.equal(getAwaitingChatId(userId), undefined);
  assert.equal(deletions.length, 1);
  assert.match(replies[0], /Запізно/);
});

test('a paused chat rejects the submission and clears the awaiting state', async () => {
  const userId = 13004;
  const chatId = -12004;
  pauseGroup(chatId);
  markAwaitingSubmission(userId, chatId);
  const { ctx, replies, deletions } = fakeCtx(userId, 'https://www.instagram.com/dezheroma');

  await handleTextMessage(ctx);

  assert.equal(getAwaitingChatId(userId), undefined);
  assert.equal(deletions.length, 1);
  assert.match(replies[0], /на паузі/);
});

test('a blocked user is rejected and the awaiting state is cleared', async () => {
  const userId = 13006;
  const chatId = -12006;
  blockUserFromGroup(chatId, userId, 'tester', 999);
  markAwaitingSubmission(userId, chatId);
  const { ctx, replies, deletions } = fakeCtx(userId, 'https://www.instagram.com/dezheroma');

  await handleTextMessage(ctx);

  assert.equal(getAwaitingChatId(userId), undefined);
  assert.equal(deletions.length, 1);
  assert.match(replies[0], /заблокували/);
});

test('a successful submission clears the awaiting state and confirms', async () => {
  const userId = 13003;
  const chatId = -12003;
  markAwaitingSubmission(userId, chatId);
  const { ctx, replies, deletions } = fakeCtx(userId, 'https://www.instagram.com/dezheroma');

  await handleTextMessage(ctx);

  assert.equal(getAwaitingChatId(userId), undefined);
  assert.equal(deletions.length, 1);
  assert.match(replies[0], /Додано/);
});

test('a non-link place is rejected and keeps the user awaiting so they can retype', async () => {
  const userId = 13005;
  const chatId = -12005;
  markAwaitingSubmission(userId, chatId);
  const { ctx, replies, deletions } = fakeCtx(userId, 'Дежерьома');

  await handleTextMessage(ctx);

  assert.equal(getAwaitingChatId(userId), chatId);
  assert.equal(deletions.length, 1);
  assert.match(replies[0], /посилання/);
});
