import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleDeclineAction, handleSubmitAction, showPersonalMenu } from './menu.js';
import { blockUserFromGroup, getAllSubmissions, pauseGroup, submitPlace } from '../services/submissionService.js';
import { getAwaitingChatId } from '../storage/pendingState.js';
import { setMenuMessage } from '../storage/menuMessages.js';

function fakeCtx(status: string, userId: number, opts: { answerCbQueryThrows?: boolean } = {}) {
  const replies: string[] = [];
  const sentMessages: Array<{ chatId: number; text: string }> = [];
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
      sendMessage: async (chatId: number, text: string) => {
        sentMessages.push({ chatId, text });
        return { message_id: 1 };
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
  return { ctx: ctx as unknown as Parameters<typeof showPersonalMenu>[0], replies, sentMessages };
}

test('showPersonalMenu refuses a non-member', async () => {
  const { ctx, replies } = fakeCtx('left', 11001);

  await showPersonalMenu(ctx, -10001);

  assert.equal(replies.length, 1);
  assert.match(replies[0], /не в цій групі/);
});

test('showPersonalMenu shows the menu to an actual member', async () => {
  const { ctx, replies } = fakeCtx('member', 11002);

  await showPersonalMenu(ctx, -10002);

  assert.equal(replies.length, 1);
  assert.doesNotMatch(replies[0], /не в цій групі/);
});

test('handleSubmitAction refuses a user who left the group since opening the menu', async () => {
  const userId = 11003;
  setMenuMessage(userId, 999, 55, -10003);
  const { ctx, replies } = fakeCtx('kicked', userId);

  await handleSubmitAction(ctx);

  assert.equal(replies.length, 1);
  assert.match(replies[0], /не в цій групі/);
});

test('handleSubmitAction lets a current member proceed past the membership gate', async () => {
  const userId = 11004;
  setMenuMessage(userId, 999, 56, -10004);
  const { ctx, replies } = fakeCtx('administrator', userId);

  await handleSubmitAction(ctx);

  assert.equal(replies.some((r) => /не в цій групі/.test(r)), false);
});

test('showPersonalMenu shows a distinct message for a paused group instead of the personal menu', async () => {
  const groupChatId = -10006;
  pauseGroup(groupChatId);
  const { ctx, replies } = fakeCtx('member', 11006);

  await showPersonalMenu(ctx, groupChatId);

  assert.equal(replies.length, 1);
  assert.match(replies[0], /на паузі/);
});

test('handleSubmitAction refuses to prompt for a place in a paused group', async () => {
  const userId = 11007;
  const groupChatId = -10007;
  pauseGroup(groupChatId);
  setMenuMessage(userId, 999, 58, groupChatId);
  const { ctx, replies } = fakeCtx('member', userId);

  await handleSubmitAction(ctx);

  assert.equal(replies.length, 1);
  assert.match(replies[0], /на паузі/);
});

test('showPersonalMenu shows a distinct message for a blocked user instead of the personal menu', async () => {
  const groupChatId = -10008;
  const userId = 11008;
  blockUserFromGroup(groupChatId, userId, 'tester', 999);
  const { ctx, replies } = fakeCtx('member', userId);

  await showPersonalMenu(ctx, groupChatId);

  assert.equal(replies.length, 1);
  assert.match(replies[0], /заблокували/);
});

test('handleSubmitAction refuses to prompt for a place for a blocked user', async () => {
  const groupChatId = -10009;
  const userId = 11009;
  blockUserFromGroup(groupChatId, userId, 'tester', 999);
  setMenuMessage(userId, 999, 59, groupChatId);
  const { ctx, replies } = fakeCtx('member', userId);

  await handleSubmitAction(ctx);

  assert.equal(replies.length, 1);
  assert.match(replies[0], /заблокували/);
});

test('handleSubmitAction still prompts for a place when answerCbQuery rejects (stale/double-tapped callback query)', async () => {
  const userId = 11005;
  setMenuMessage(userId, 999, 57, -10005);
  const { ctx, replies } = fakeCtx('member', userId, { answerCbQueryThrows: true });

  await handleSubmitAction(ctx);

  assert.equal(replies.some((r) => /Надішли посилання на заклад/.test(r)), true);
});

test('handleDeclineAction records a decline and shows it on the menu card, silently (nothing was submitted before)', async () => {
  const userId = 11010;
  const groupChatId = -10010;
  setMenuMessage(userId, 999, 60, groupChatId);
  const { ctx, replies, sentMessages } = fakeCtx('member', userId);

  await handleDeclineAction(ctx);

  assert.equal(getAllSubmissions(groupChatId)[0]?.status, 'declined');
  assert.equal(replies.some((r) => /не йдеш/.test(r)), true);
  assert.equal(sentMessages.length, 0); // nothing to retract, so the group hears nothing
});

test('handleDeclineAction announces to the group when it retracts an already-submitted place', async () => {
  const userId = 11013;
  const groupChatId = -10013;
  submitPlace(groupChatId, userId, 'tester', 'https://www.instagram.com/somewhere');
  setMenuMessage(userId, 999, 63, groupChatId);
  const { ctx, sentMessages } = fakeCtx('member', userId);

  await handleDeclineAction(ctx);

  assert.equal(getAllSubmissions(groupChatId)[0]?.status, 'declined');
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].chatId, groupChatId);
  assert.match(sentMessages[0].text, /не йде/);
  assert.match(sentMessages[0].text, /somewhere/);
});

test('handleDeclineAction a second time cancels the decline and prompts for a place instead (no group announcement)', async () => {
  const userId = 11011;
  const groupChatId = -10011;
  setMenuMessage(userId, 999, 61, groupChatId);

  const first = fakeCtx('member', userId);
  await handleDeclineAction(first.ctx);
  assert.equal(getAllSubmissions(groupChatId)[0]?.status, 'declined');
  assert.equal(first.sentMessages.length, 0);

  const second = fakeCtx('member', userId);
  await handleDeclineAction(second.ctx);
  assert.equal(getAllSubmissions(groupChatId).length, 0);
  assert.equal(second.sentMessages.length, 0);
  assert.equal(getAwaitingChatId(userId), groupChatId); // went straight into the "add a place" prompt
  assert.equal(second.replies.some((r) => /Куди хочеться/.test(r)), true);
});

test('handleDeclineAction refuses to record a decline for a blocked user', async () => {
  const userId = 11012;
  const groupChatId = -10012;
  blockUserFromGroup(groupChatId, userId, 'tester', 999);
  setMenuMessage(userId, 999, 62, groupChatId);
  const { ctx, replies } = fakeCtx('member', userId);

  await handleDeclineAction(ctx);

  assert.equal(getAllSubmissions(groupChatId).length, 0);
  assert.match(replies[0], /заблокували/);
});
