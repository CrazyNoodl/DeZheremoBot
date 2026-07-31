import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Context } from 'telegraf';

// commands/menuMessage.ts pulls in storage/groupChats.ts (via getGroupChatTitle) and
// storage/groupSchedules.ts (via services/scheduleService.ts's getSchedule), both of which load
// their state from DEZHEREMO_DATA_DIR once at import time — same isolation approach as
// commands/schedule.test.ts. Must be set before any of these modules are first imported, hence the
// dynamic imports below rather than static top-of-file ones.
process.env.DEZHEREMO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dzb-menumessage-'));

const { buildMenuKeyboard, buildMenuText, sendMenuMessage, updateMenuMessage, withGroupLabel } = await import('./menuMessage.js');
const { addGroupChat } = await import('../storage/groupChats.js');
const { setGroupSchedule, DEFAULT_SCHEDULE } = await import('../storage/groupSchedules.js');
const { submitPlace, declinePlace } = await import('../services/submissionService.js');

interface SentMessage {
  text: string;
  extra?: Record<string, unknown>;
}

interface EditCall {
  chatId: number;
  messageId: number;
  text: string;
  extra?: Record<string, unknown>;
}

interface DeleteCall {
  chatId: number;
  messageId: number;
}

function fakeCtx(privateChatId: number | undefined, opts: { editSucceeds?: boolean } = {}) {
  const replies: SentMessage[] = [];
  const sentMessageIds: number[] = [];
  const edits: EditCall[] = [];
  const deletes: DeleteCall[] = [];
  let nextMessageId = 1;
  const ctx = {
    chat: privateChatId !== undefined ? { id: privateChatId } : undefined,
    telegram: {
      editMessageText: async (
        chatId: number,
        messageId: number,
        _inlineMessageId: undefined,
        text: string,
        extra?: Record<string, unknown>,
      ) => {
        edits.push({ chatId, messageId, text, extra });
        if (!opts.editSucceeds) throw new Error('no message tracked to edit in this test');
        return { message_id: messageId };
      },
      deleteMessage: async (chatId: number, messageId: number) => {
        deletes.push({ chatId, messageId });
        return true;
      },
    },
    reply: async (text: string, extra?: Record<string, unknown>) => {
      const message_id = nextMessageId++;
      replies.push({ text, extra });
      sentMessageIds.push(message_id);
      return { message_id };
    },
  };
  return { ctx: ctx as unknown as Context, replies, sentMessageIds, edits, deletes };
}

function buttons(keyboard: ReturnType<typeof buildMenuKeyboard>) {
  return keyboard.reply_markup!.inline_keyboard as Array<Array<{ text: string; callback_data?: string }>>;
}

// --- withGroupLabel ---

test('withGroupLabel prefixes the text with the group title when one is registered', () => {
  const groupChatId = -23001;
  addGroupChat(groupChatId, 'Сніданкова тусовка');

  const result = withGroupLabel(groupChatId, 'Привіт');

  assert.equal(result, '📍 Сніданкова тусовка\n\nПривіт');
});

test('withGroupLabel returns the text unchanged when no title is registered for that chat', () => {
  const groupChatId = -23002; // deliberately never passed to addGroupChat

  const result = withGroupLabel(groupChatId, 'Привіт');

  assert.equal(result, 'Привіт');
});

test('withGroupLabel escapes HTML-special characters in the group title', () => {
  const groupChatId = -23003;
  addGroupChat(groupChatId, 'A & B <group>');

  const result = withGroupLabel(groupChatId, 'text');

  assert.equal(result, '📍 A &amp; B &lt;group&gt;\n\ntext');
});

// --- buildMenuText ---

test('buildMenuText shows the "no submission yet" text with the group\'s actual configured deadline', () => {
  const groupChatId = -23004;
  const userId = 23004;
  setGroupSchedule(groupChatId, { ...DEFAULT_SCHEDULE, deadlineWeekday: 3, lockTime: '19:30' });

  const text = buildMenuText(groupChatId, userId);

  assert.match(text, /поки що порожньо/);
  assert.match(text, /Ср, 19:30/); // Wednesday (index 3), distinct from DEFAULT_SCHEDULE's Пт 18:00
});

test('buildMenuText shows the submitted place (rendered via placeLink) for a user with a real submission', () => {
  const groupChatId = -23005;
  const userId = 23005;
  submitPlace(groupChatId, userId, 'tester', 'https://www.instagram.com/somewhere');

  const text = buildMenuText(groupChatId, userId);

  assert.match(text, /Твій варіант цього тижня/);
  assert.match(text, /somewhere/); // placeLink extracts the Instagram username as the link label
});

test('buildMenuText shows the decline text and omits "Твій варіант" for a user who declined', () => {
  const groupChatId = -23006;
  const userId = 23006;
  declinePlace(groupChatId, userId, 'tester');

  const text = buildMenuText(groupChatId, userId);

  assert.match(text, /не йдеш/);
  assert.doesNotMatch(text, /Твій варіант/);
});

// --- buildMenuKeyboard ---

test('buildMenuKeyboard shows "➕ Додати" for a user with no submission yet', () => {
  const groupChatId = -23007;
  const userId = 23007;

  const rows = buttons(buildMenuKeyboard(groupChatId, userId));

  assert.equal(rows.length, 2);
  assert.equal(rows[0][0].text, '➕ Додати');
  assert.equal(rows[1][0].text, '🙅 Не йду цього тижня');
});

test('buildMenuKeyboard relabels the button to "✏️ Змінити" once a place is submitted', () => {
  const groupChatId = -23008;
  const userId = 23008;
  submitPlace(groupChatId, userId, 'tester', 'https://www.instagram.com/somewhere');

  const rows = buttons(buildMenuKeyboard(groupChatId, userId));

  assert.equal(rows.length, 2);
  assert.equal(rows[0][0].text, '✏️ Змінити');
});

test('buildMenuKeyboard drops the add/change button entirely and relabels the decline button once declined', () => {
  const groupChatId = -23009;
  const userId = 23009;
  declinePlace(groupChatId, userId, 'tester');

  const rows = buttons(buildMenuKeyboard(groupChatId, userId));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].length, 1);
  assert.equal(rows[0][0].text, '↩️ Скасувати «не йду»');
});

// --- sendMenuMessage ---

test('sendMenuMessage posts via ctx.reply with HTML parse_mode and the group-labeled text', async () => {
  const groupChatId = -23010;
  addGroupChat(groupChatId, 'Тестова група');
  const userId = 23010;
  const privateChatId = 23010;
  const { ctx, replies } = fakeCtx(privateChatId);

  await sendMenuMessage(ctx, groupChatId, userId, 'Просто текст');

  assert.equal(replies.length, 1);
  assert.equal(replies[0].extra?.parse_mode, 'HTML');
  assert.match(replies[0].text, /^📍 Тестова група\n\nПросто текст/);
});

test('sendMenuMessage does nothing when ctx.chat is undefined', async () => {
  const groupChatId = -23011;
  const userId = 23011;
  const { ctx, replies } = fakeCtx(undefined);

  await sendMenuMessage(ctx, groupChatId, userId, 'text');

  assert.equal(replies.length, 0);
});

// --- updateMenuMessage ---

test('updateMenuMessage falls through to sendMenuMessage when nothing is tracked for this user yet', async () => {
  const groupChatId = -23012;
  const userId = 23012;
  const { ctx, replies, edits } = fakeCtx(23012);

  await updateMenuMessage(ctx, groupChatId, userId, 'text');

  assert.equal(replies.length, 1);
  assert.equal(edits.length, 0);
});

test('updateMenuMessage edits the previously tracked message in place on a later call for the same user', async () => {
  const groupChatId = -23013;
  const userId = 23013;
  const privateChatId = 23013;
  addGroupChat(groupChatId, 'Друга група');
  const { ctx, replies, sentMessageIds, edits } = fakeCtx(privateChatId, { editSucceeds: true });

  await sendMenuMessage(ctx, groupChatId, userId, 'початковий текст');
  assert.equal(replies.length, 1);

  await updateMenuMessage(ctx, groupChatId, userId, 'оновлений текст');

  assert.equal(edits.length, 1);
  assert.equal(replies.length, 1); // no extra ctx.reply call — the edit succeeded
  assert.equal(edits[0].chatId, privateChatId);
  assert.equal(edits[0].messageId, sentMessageIds[0]);
  assert.equal(edits[0].extra?.parse_mode, 'HTML');
  assert.match(edits[0].text, /^📍 Друга група\n\nоновлений текст/);
});

// --- 48h TTL ---

test('a tracked menu message deletes itself via ctx.telegram.deleteMessage once the 48h TTL fires', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const groupChatId = -23014;
  const userId = 23014;
  const privateChatId = 23014;
  const { ctx, sentMessageIds, deletes } = fakeCtx(privateChatId);

  await sendMenuMessage(ctx, groupChatId, userId, 'text');

  t.mock.timers.tick(48 * 60 * 60 * 1000);
  await Promise.resolve(); // let the timer's async deleteMessage call settle

  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].chatId, privateChatId);
  assert.equal(deletes[0].messageId, sentMessageIds[0]);
});
