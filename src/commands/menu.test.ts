import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleSubmitAction, showPersonalMenu } from './menu.js';
import { pauseGroup } from '../services/submissionService.js';
import { setMenuMessage } from '../storage/menuMessages.js';

function fakeCtx(status: string, userId: number, opts: { answerCbQueryThrows?: boolean } = {}) {
  const replies: string[] = [];
  const ctx = {
    from: { id: userId },
    chat: { id: userId }, // private chat id, distinct per test via userId
    callbackQuery: { data: 'submit' }, // real callback presses always have this set
    telegram: {
      getChatMember: async () => {
        if (status === 'throw') throw new Error('boom');
        return { status };
      },
      editMessageText: async () => {
        throw new Error('no message tracked to edit in this test');
      },
    },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: 42 };
    },
    answerCbQuery: async () => {
      if (opts.answerCbQueryThrows) throw new Error('400: query is too old and response timeout expired');
    },
  };
  return { ctx: ctx as unknown as Parameters<typeof showPersonalMenu>[0], replies };
}

test('showPersonalMenu refuses a non-member', async () => {
  const { ctx, replies } = fakeCtx('left', 11001);

  await showPersonalMenu(ctx, -10001);

  assert.equal(replies.length, 1);
  assert.match(replies[0], /не учасник/);
});

test('showPersonalMenu shows the menu to an actual member', async () => {
  const { ctx, replies } = fakeCtx('member', 11002);

  await showPersonalMenu(ctx, -10002);

  assert.equal(replies.length, 1);
  assert.doesNotMatch(replies[0], /не учасник/);
});

test('handleSubmitAction refuses a user who left the group since opening the menu', async () => {
  const userId = 11003;
  setMenuMessage(userId, 999, 55, -10003);
  const { ctx, replies } = fakeCtx('kicked', userId);

  await handleSubmitAction(ctx);

  assert.equal(replies.length, 1);
  assert.match(replies[0], /не учасник/);
});

test('handleSubmitAction lets a current member proceed past the membership gate', async () => {
  const userId = 11004;
  setMenuMessage(userId, 999, 56, -10004);
  const { ctx, replies } = fakeCtx('administrator', userId);

  await handleSubmitAction(ctx);

  assert.equal(replies.some((r) => /не учасник/.test(r)), false);
});

test('showPersonalMenu shows a distinct message for a paused group instead of the personal menu', async () => {
  const groupChatId = -10006;
  pauseGroup(groupChatId);
  const { ctx, replies } = fakeCtx('member', 11006);

  await showPersonalMenu(ctx, groupChatId);

  assert.equal(replies.length, 1);
  assert.match(replies[0], /призупинено/);
});

test('handleSubmitAction refuses to prompt for a place in a paused group', async () => {
  const userId = 11007;
  const groupChatId = -10007;
  pauseGroup(groupChatId);
  setMenuMessage(userId, 999, 58, groupChatId);
  const { ctx, replies } = fakeCtx('member', userId);

  await handleSubmitAction(ctx);

  assert.equal(replies.length, 1);
  assert.match(replies[0], /призупинено/);
});

test('handleSubmitAction still prompts for a place when answerCbQuery rejects (stale/double-tapped callback query)', async () => {
  const userId = 11005;
  setMenuMessage(userId, 999, 57, -10005);
  const { ctx, replies } = fakeCtx('member', userId, { answerCbQueryThrows: true });

  await handleSubmitAction(ctx);

  assert.equal(replies.some((r) => /Напиши назву місця/.test(r)), true);
});
