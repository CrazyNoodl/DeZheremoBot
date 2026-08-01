import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TelegramError, type Telegram } from 'telegraf';

// groupChats.ts (imported transitively by telegramBroadcast.ts) loads its state once at import
// time from a hardcoded-by-default path, so DEZHEREMO_DATA_DIR must be set before that first
// import — a dynamic import() (unlike a static one) runs at this exact point in the file.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzb-broadcast-'));
process.env.DEZHEREMO_DATA_DIR = dataDir;

const { broadcast, sendDirectMessage, sendToChat } = await import('./telegramBroadcast.js');
const { addGroupChat, listGroupChats } = await import('./storage/groupChats.js');

function fakeTelegram(sendMessage: Telegram['sendMessage']): { telegram: Telegram; deletes: Array<{ chatId: number; messageId: number }> } {
  const deletes: Array<{ chatId: number; messageId: number }> = [];
  const telegram = {
    sendMessage,
    deleteMessage: async (chatId: number, messageId: number) => {
      deletes.push({ chatId, messageId });
      return true;
    },
  } as unknown as Telegram;
  return { telegram, deletes };
}

test('sendToChat sends the message with the given text and extra', async () => {
  const calls: Array<{ chatId: number; text: string; extra?: object }> = [];
  const { telegram } = fakeTelegram(async (chatId: number, text: string, extra?: object) => {
    calls.push({ chatId, text, extra });
    return { message_id: 1 } as any;
  });

  await sendToChat(telegram, -40001, 'hello', { parse_mode: 'HTML' });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { chatId: -40001, text: 'hello', extra: { parse_mode: 'HTML' } });
});

test('sendToChat schedules a deleteMessage after deleteAfterMs and not before', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { telegram, deletes } = fakeTelegram(async () => ({ message_id: 777 }) as any);

  await sendToChat(telegram, -40002, 'temp', undefined, 1000);
  assert.equal(deletes.length, 0);

  t.mock.timers.tick(999);
  await Promise.resolve();
  assert.equal(deletes.length, 0);

  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(deletes.length, 1);
  assert.deepEqual(deletes[0], { chatId: -40002, messageId: 777 });
});

test('sendToChat with no deleteAfterMs never schedules a delete', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { telegram, deletes } = fakeTelegram(async () => ({ message_id: 1 }) as any);

  await sendToChat(telegram, -40003, 'permanent');

  t.mock.timers.tick(365 * 24 * 60 * 60 * 1000);
  await Promise.resolve();
  assert.equal(deletes.length, 0);
});

test('a failed scheduled delete is swallowed rather than rejecting or throwing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const telegram = {
    sendMessage: async () => ({ message_id: 1 }) as any,
    deleteMessage: async () => {
      throw new Error('message to delete not found');
    },
  } as unknown as Telegram;

  await sendToChat(telegram, -40004, 'temp', undefined, 100);
  t.mock.timers.tick(100);
  await Promise.resolve();
  await Promise.resolve(); // let the rejected deleteMessage promise's .catch(() => {}) settle
  // No assertion needed beyond "this didn't throw" — an unswallowed rejection would fail the test run.
});

test('a 403 (bot kicked) removes the chat from the group chats registry', async () => {
  addGroupChat(-40005, 'Kicked From Here');
  assert.equal(listGroupChats().includes(-40005), true);

  const { telegram } = fakeTelegram(async () => {
    throw new TelegramError({ error_code: 403, description: 'Forbidden: bot was kicked from the group chat' });
  });

  await sendToChat(telegram, -40005, 'hello');

  assert.equal(listGroupChats().includes(-40005), false);
});

test('a non-403 TelegramError is logged but does not remove the chat from the registry', async (t) => {
  const errorSpy = t.mock.method(console, 'error');
  addGroupChat(-40006, 'Still Here');

  const { telegram } = fakeTelegram(async () => {
    throw new TelegramError({ error_code: 400, description: 'Bad Request: chat not found' });
  });

  await sendToChat(telegram, -40006, 'hello');

  assert.equal(listGroupChats().includes(-40006), true);
  assert.equal(errorSpy.mock.callCount(), 1);
});

test('a generic (non-TelegramError) send failure is logged but does not remove the chat or throw', async (t) => {
  const errorSpy = t.mock.method(console, 'error');
  addGroupChat(-40007, 'Still Here Too');

  const { telegram } = fakeTelegram(async () => {
    throw new Error('network hiccup');
  });

  await sendToChat(telegram, -40007, 'hello');

  assert.equal(listGroupChats().includes(-40007), true);
  assert.equal(errorSpy.mock.callCount(), 1);
});

test('sendToChat never rejects even when the send itself fails', async () => {
  const { telegram } = fakeTelegram(async () => {
    throw new Error('boom');
  });

  await assert.doesNotReject(sendToChat(telegram, -40008, 'hello'));
});

test('broadcast sends to every registered group chat', async () => {
  addGroupChat(-40009, 'Group A');
  addGroupChat(-40010, 'Group B');
  const calls: number[] = [];
  const { telegram } = fakeTelegram(async (chatId: number) => {
    calls.push(chatId);
    return { message_id: 1 } as any;
  });

  await broadcast(telegram, 'hello everyone');

  assert.equal(calls.includes(-40009), true);
  assert.equal(calls.includes(-40010), true);
});

test('broadcast continues to the next chat after one chat fails to send', async () => {
  addGroupChat(-40011, 'Failing Group');
  addGroupChat(-40012, 'Healthy Group');
  const calls: number[] = [];
  const { telegram } = fakeTelegram(async (chatId: number) => {
    calls.push(chatId);
    if (chatId === -40011) throw new Error('this one fails');
    return { message_id: 1 } as any;
  });

  await broadcast(telegram, 'hello everyone');

  assert.equal(calls.includes(-40011), true);
  assert.equal(calls.includes(-40012), true);
});

test('sendDirectMessage sends the message with the given text and extra', async () => {
  const calls: Array<{ chatId: number; text: string; extra?: object }> = [];
  const { telegram } = fakeTelegram(async (chatId: number, text: string, extra?: object) => {
    calls.push({ chatId, text, extra });
    return { message_id: 1 } as any;
  });

  await sendDirectMessage(telegram, 555, 'rate this place', { parse_mode: 'HTML' });

  assert.deepEqual(calls, [{ chatId: 555, text: 'rate this place', extra: { parse_mode: 'HTML' } }]);
});

// A user id blocking the bot in DM has nothing to do with a group's own registry — unlike
// sendToChat's group-broadcast path, a 403 here must never call removeGroupChat, since a user id
// could otherwise (in theory) collide with a registered group chat id and wrongly deregister it.
test('sendDirectMessage on a 403 does not touch the group chats registry', async () => {
  addGroupChat(-40015, 'Untouched Group');
  const { telegram } = fakeTelegram(async () => {
    throw new TelegramError({ error_code: 403, description: 'Forbidden: bot was blocked by the user' });
  });

  await sendDirectMessage(telegram, 556, 'rate this place');

  assert.equal(listGroupChats().includes(-40015), true);
});

test('sendDirectMessage logs a 403 instead of swallowing it silently', async (t) => {
  const warnSpy = t.mock.method(console, 'warn');
  const { telegram } = fakeTelegram(async () => {
    throw new TelegramError({ error_code: 403, description: 'Forbidden: bot was blocked by the user' });
  });

  await sendDirectMessage(telegram, 557, 'rate this place');

  assert.equal(warnSpy.mock.callCount(), 1);
});

test('sendDirectMessage never rejects even when the send itself fails', async () => {
  const { telegram } = fakeTelegram(async () => {
    throw new Error('boom');
  });

  await assert.doesNotReject(sendDirectMessage(telegram, 558, 'rate this place'));
});

test('broadcast self-heals a 403 mid-loop without aborting the remaining chats', async () => {
  addGroupChat(-40013, 'Kicked Mid-Loop');
  addGroupChat(-40014, 'Still A Member');
  const calls: number[] = [];
  const { telegram } = fakeTelegram(async (chatId: number) => {
    calls.push(chatId);
    if (chatId === -40013) {
      throw new TelegramError({ error_code: 403, description: 'Forbidden: bot was kicked from the group chat' });
    }
    return { message_id: 1 } as any;
  });

  await broadcast(telegram, 'hello everyone');

  assert.equal(calls.includes(-40014), true);
  assert.equal(listGroupChats().includes(-40013), false);
  assert.equal(listGroupChats().includes(-40014), true);
});
