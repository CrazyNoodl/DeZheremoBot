import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from 'telegraf';
import { db, recordDraw } from '../storage/history.js';
import { handleRateAction } from './rating.js';

function drawIdFor(chatId: number): number {
  recordDraw({
    chatId,
    drawnAt: 1_700_000_000_000,
    winner: { userId: 1, username: 'artem', place: 'Дежерьома' },
    submissions: [{ userId: 1, username: 'artem', place: 'Дежерьома' }],
  });
  return db.prepare('SELECT id FROM weekly_draws WHERE chat_id = ? ORDER BY id DESC LIMIT 1').get(chatId)!.id as number;
}

function fakeCtx(userId: number, data: string) {
  const edits: { chatId: number; messageId: number; text: string; extra?: object }[] = [];
  const toasts: (string | undefined)[] = [];
  const ctx = {
    from: { id: userId },
    callbackQuery: { data, message: { chat: { id: userId }, message_id: 555 } },
    telegram: {
      editMessageText: async (chatId: number, messageId: number, _inlineMessageId: undefined, text: string, extra?: object) => {
        edits.push({ chatId, messageId, text, extra });
      },
    },
    answerCbQuery: async (text?: string) => {
      toasts.push(text);
    },
  };
  return { ctx: ctx as unknown as Context, edits, toasts };
}

test('handleRateAction stores the rating under the tapping user', () => {
  const drawId = drawIdFor(-9001);
  const { ctx } = fakeCtx(111, `rate:${drawId}:4`);

  return handleRateAction(ctx).then(() => {
    const row = db.prepare('SELECT stars FROM place_ratings WHERE draw_id = ? AND user_id = ?').get(drawId, 111);
    assert.equal(row?.stars, 4);
  });
});

test('handleRateAction upserts when the same user taps a different star', async () => {
  const drawId = drawIdFor(-9002);
  await handleRateAction(fakeCtx(222, `rate:${drawId}:2`).ctx);
  await handleRateAction(fakeCtx(222, `rate:${drawId}:5`).ctx);

  const rows = db.prepare('SELECT stars FROM place_ratings WHERE draw_id = ? AND user_id = ?').all(drawId, 222);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stars, 5);
});

test('handleRateAction edits the tapped message into a thank-you with no buttons', async () => {
  const drawId = drawIdFor(-9003);
  const { ctx, edits } = fakeCtx(333, `rate:${drawId}:3`);

  await handleRateAction(ctx);

  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /Дякуємо/);
  assert.match(edits[0].text, /3⭐/);
  assert.deepEqual((edits[0].extra as { reply_markup?: { inline_keyboard: unknown[] } })?.reply_markup?.inline_keyboard, []);
});

test('handleRateAction answers the callback query as a plain toast, not an alert', async () => {
  const drawId = drawIdFor(-9004);
  const { ctx, toasts } = fakeCtx(444, `rate:${drawId}:1`);

  await handleRateAction(ctx);

  assert.equal(toasts.length, 1);
  assert.match(toasts[0]!, /Дякуємо/);
});

test('handleRateAction records "absent" as a NULL-stars row instead of a star count', async () => {
  const drawId = drawIdFor(-9005);
  const { ctx } = fakeCtx(555, `rate:${drawId}:absent`);

  await handleRateAction(ctx);

  const row = db.prepare('SELECT stars FROM place_ratings WHERE draw_id = ? AND user_id = ?').get(drawId, 555);
  assert.equal(row?.stars, null);
});

test('handleRateAction edits the message with an absence-specific thank-you, not a star count', async () => {
  const drawId = drawIdFor(-9006);
  const { ctx, edits } = fakeCtx(666, `rate:${drawId}:absent`);

  await handleRateAction(ctx);

  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /не було/);
  assert.doesNotMatch(edits[0].text, /⭐/);
});

test('handleRateAction lets a later star tap overwrite an earlier "absent" mark', async () => {
  const drawId = drawIdFor(-9007);
  await handleRateAction(fakeCtx(777, `rate:${drawId}:absent`).ctx);
  await handleRateAction(fakeCtx(777, `rate:${drawId}:4`).ctx);

  const row = db.prepare('SELECT stars FROM place_ratings WHERE draw_id = ? AND user_id = ?').get(drawId, 777);
  assert.equal(row?.stars, 4);
});
