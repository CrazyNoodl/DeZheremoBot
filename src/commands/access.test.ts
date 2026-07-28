import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isChatMember } from './access.js';

function fakeCtx(getChatMember: (chatId: number, userId: number) => Promise<{ status: string }>) {
  return { telegram: { getChatMember } } as unknown as Parameters<typeof isChatMember>[0];
}

test('isChatMember is true for member/administrator/creator', async () => {
  for (const status of ['member', 'administrator', 'creator']) {
    const ctx = fakeCtx(async () => ({ status }));
    assert.equal(await isChatMember(ctx, -1, 1), true, `expected true for status "${status}"`);
  }
});

test('isChatMember is false for left/kicked', async () => {
  for (const status of ['left', 'kicked']) {
    const ctx = fakeCtx(async () => ({ status }));
    assert.equal(await isChatMember(ctx, -1, 1), false, `expected false for status "${status}"`);
  }
});

test('isChatMember is false when the lookup throws (bot lost access, API hiccup)', async () => {
  const ctx = fakeCtx(async () => {
    throw new Error('boom');
  });

  assert.equal(await isChatMember(ctx, -1, 1), false);
});
