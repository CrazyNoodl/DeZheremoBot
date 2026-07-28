import assert from 'node:assert/strict';
import { test } from 'node:test';
import { showSubmissionsList } from './list.js';

function fakeCtx(status: string, userId: number) {
  const replies: string[] = [];
  const ctx = {
    from: { id: userId },
    telegram: {
      getChatMember: async () => {
        if (status === 'throw') throw new Error('boom');
        return { status };
      },
    },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: 1 };
    },
  };
  return { ctx: ctx as unknown as Parameters<typeof showSubmissionsList>[0], replies };
}

test('showSubmissionsList refuses a non-member', async () => {
  const { ctx, replies } = fakeCtx('left', 12001);

  await showSubmissionsList(ctx, -11001);

  assert.equal(replies.length, 1);
  assert.match(replies[0], /не учасник/);
});

test('showSubmissionsList refuses when the membership lookup fails', async () => {
  const { ctx, replies } = fakeCtx('throw', 12002);

  await showSubmissionsList(ctx, -11002);

  assert.equal(replies.length, 1);
  assert.match(replies[0], /не учасник/);
});

test('showSubmissionsList replies with the list for an actual member', async () => {
  const { ctx, replies } = fakeCtx('member', 12003);

  await showSubmissionsList(ctx, -11003);

  assert.equal(replies.length, 1);
  assert.doesNotMatch(replies[0], /не учасник/);
});
