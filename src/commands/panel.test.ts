import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Markup, TelegramError, type Context } from 'telegraf';
import { createPanel, safeAnswerCbQuery } from './panel.js';

const keyboard = Markup.inlineKeyboard([]);

function fakeCtx(chatId: number | undefined) {
  const replies: string[] = [];
  const replyExtras: unknown[] = [];
  const edits: { chatId: number; messageId: number; text: string }[] = [];
  const editExtras: unknown[] = [];
  const deletes: { chatId: number; messageId: number }[] = [];
  let editImpl: () => Promise<unknown> = async () => ({});

  const ctx = {
    chat: chatId === undefined ? undefined : { id: chatId },
    reply: async (text: string, extra?: unknown) => {
      replies.push(text);
      replyExtras.push(extra);
      return { message_id: replies.length };
    },
    telegram: {
      editMessageText: async (
        editChatId: number,
        messageId: number,
        _inlineMessageId: undefined,
        text: string,
        extra?: unknown,
      ) => {
        edits.push({ chatId: editChatId, messageId, text });
        editExtras.push(extra);
        return editImpl();
      },
      deleteMessage: async (deleteChatId: number, messageId: number) => {
        deletes.push({ chatId: deleteChatId, messageId });
      },
    },
  };

  return {
    ctx: ctx as unknown as Context,
    replies,
    replyExtras,
    edits,
    editExtras,
    deletes,
    setEditImpl: (fn: () => Promise<unknown>) => {
      editImpl = fn;
    },
  };
}

test('send posts a fresh message via ctx.reply and tracks it so a later update edits it in place', async () => {
  const panel = createPanel(1000, 'test');
  const userId = 30001;
  const { ctx, replies, edits } = fakeCtx(-30001);

  await panel.send(ctx, userId, 'hello', keyboard);
  assert.deepEqual(replies, ['hello']);

  await panel.update(ctx, userId, 'updated', keyboard);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].chatId, -30001);
  assert.equal(edits[0].messageId, 1);
  assert.equal(edits[0].text, 'updated');
  // no second reply — the update was a genuine in-place edit, not a fallback send
  assert.deepEqual(replies, ['hello']);
});

test('send does nothing when ctx.chat is undefined', async () => {
  const panel = createPanel(1000, 'test');
  const userId = 30002;
  const { ctx, replies } = fakeCtx(undefined);

  await panel.send(ctx, userId, 'hello', keyboard);

  assert.deepEqual(replies, []);
});

test('update with no tracked message for that user falls through directly to send', async () => {
  const panel = createPanel(1000, 'test');
  const userId = 30003;
  const { ctx, replies, edits } = fakeCtx(-30003);

  await panel.update(ctx, userId, 'first time', keyboard);

  assert.deepEqual(replies, ['first time']);
  assert.equal(edits.length, 0);
});

test('update with a tracked message edits it and does not call ctx.reply', async () => {
  const panel = createPanel(1000, 'test');
  const userId = 30004;
  const { ctx, replies, edits } = fakeCtx(-30004);

  await panel.send(ctx, userId, 'initial', keyboard);
  await panel.update(ctx, userId, 'edited', keyboard);

  assert.equal(edits.length, 1);
  assert.equal(edits[0].chatId, -30004);
  assert.equal(edits[0].messageId, 1);
  assert.deepEqual(replies, ['initial']); // still just the one send, no fallback reply
});

test('update falls back to send when editMessageText throws a generic error', async () => {
  const panel = createPanel(1000, 'test');
  const userId = 30005;
  const { ctx, replies, setEditImpl } = fakeCtx(-30005);

  await panel.send(ctx, userId, 'initial', keyboard);
  setEditImpl(async () => {
    throw new Error('boom');
  });

  await panel.update(ctx, userId, 'edited', keyboard);

  assert.deepEqual(replies, ['initial', 'edited']); // fallback fresh message sent
});

test('update is a silent no-op when editMessageText throws a real "message is not modified" TelegramError', async () => {
  const panel = createPanel(1000, 'test');
  const userId = 30006;
  const { ctx, replies, setEditImpl } = fakeCtx(-30006);

  await panel.send(ctx, userId, 'initial', keyboard);
  setEditImpl(async () => {
    throw new TelegramError({ error_code: 400, description: 'Bad Request: message is not modified' });
  });

  await panel.update(ctx, userId, 'initial', keyboard);

  // no fallback send happened — still just the one original reply
  assert.deepEqual(replies, ['initial']);
});

test('track schedules deletion of the tracked message once ttlMs elapses, and a later update falls through to send again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const panel = createPanel(60_000, 'test');
  const userId = 30007;
  const { ctx, replies, deletes } = fakeCtx(-30007);

  await panel.send(ctx, userId, 'initial', keyboard);

  t.mock.timers.tick(60_000);
  await Promise.resolve();

  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].chatId, -30007);
  assert.equal(deletes[0].messageId, 1);

  // store was cleared by the TTL, so update() has nothing tracked and falls through to send()
  await panel.update(ctx, userId, 'after ttl', keyboard);
  assert.deepEqual(replies, ['initial', 'after ttl']);
});

test('track TTL is a no-op if superseded by a newer panel message for the same user', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const panel = createPanel(60_000, 'test');
  const userId = 30008;
  const { ctx, deletes } = fakeCtx(-30008);

  await panel.send(ctx, userId, 'first', keyboard); // superseded before its own TTL fires
  await panel.send(ctx, userId, 'second', keyboard); // this is the one actually tracked

  t.mock.timers.tick(60_000);
  await Promise.resolve();

  // both TTLs fire at the same tick, but only the second (still-tracked) message gets deleted
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].messageId, 2);
});

test('send forwards an optional extra (e.g. parse_mode) alongside the keyboard to ctx.reply', async () => {
  const panel = createPanel(1000, 'test');
  const userId = 30009;
  const { ctx, replyExtras } = fakeCtx(-30009);

  await panel.send(ctx, userId, 'hello', keyboard, { parse_mode: 'HTML' });

  assert.deepEqual(replyExtras[0], { ...keyboard, parse_mode: 'HTML' });
});

test('update forwards an optional extra to editMessageText on the in-place edit path', async () => {
  const panel = createPanel(1000, 'test');
  const userId = 30010;
  const { ctx, editExtras } = fakeCtx(-30010);

  await panel.send(ctx, userId, 'initial', keyboard);
  await panel.update(ctx, userId, 'edited', keyboard, { parse_mode: 'HTML' });

  assert.deepEqual(editExtras[0], { ...keyboard, parse_mode: 'HTML' });
});

test('update forwards an optional extra through to the fallback send when there is nothing tracked yet', async () => {
  const panel = createPanel(1000, 'test');
  const userId = 30011;
  const { ctx, replyExtras } = fakeCtx(-30011);

  await panel.update(ctx, userId, 'first time', keyboard, { parse_mode: 'HTML' });

  assert.deepEqual(replyExtras[0], { ...keyboard, parse_mode: 'HTML' });
});

test('safeAnswerCbQuery calls through to ctx.answerCbQuery with the given text/extra', async () => {
  const calls: { text?: string; extra?: { show_alert?: boolean } }[] = [];
  const ctx = {
    answerCbQuery: async (text?: string, extra?: { show_alert?: boolean }) => {
      calls.push({ text, extra });
    },
  } as unknown as Context;

  await safeAnswerCbQuery(ctx, 'hi', { show_alert: true });

  assert.deepEqual(calls, [{ text: 'hi', extra: { show_alert: true } }]);
});

test('safeAnswerCbQuery swallows a rejection from a stale callback query instead of throwing', async () => {
  const ctx = {
    answerCbQuery: async () => {
      throw new Error('query is too old and response timeout expired or query id is invalid');
    },
  } as unknown as Context;

  await assert.doesNotReject(safeAnswerCbQuery(ctx, 'hi'));
});
