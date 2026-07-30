import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Context } from 'telegraf';

// groupChat.ts pulls in storage/groupChats.ts, which loads its state from DEZHEREMO_DATA_DIR once at
// import time — same isolation approach as storage/groupChats.test.ts and commands/schedule.test.ts.
// The dynamic import() below (unlike a static one) runs at this exact point in the file, after the
// env var is set, rather than being hoisted above it.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzb-groupchat-cmd-'));
process.env.DEZHEREMO_DATA_DIR = dataDir;

const { handleMyChatMember, handleNewChatTitle } = await import('./groupChat.js');
const { getGroupChatTitle, listGroupChats } = await import('../storage/groupChats.js');

function myChatMemberCtx(chatId: number, chatType: string, title: string, status: string) {
  return {
    myChatMember: {
      chat: { id: chatId, type: chatType, title },
      new_chat_member: { status },
    },
  } as unknown as Context;
}

function newChatTitleCtx(chatId: number | undefined, newTitle: string | undefined) {
  return {
    chat: chatId === undefined ? undefined : { id: chatId },
    message: newTitle === undefined ? { text: 'just a regular message' } : { new_chat_title: newTitle },
  } as unknown as Context;
}

test('handleMyChatMember: joining a group ("member" status) adds the chat', async () => {
  const ctx = myChatMemberCtx(-22001, 'group', 'Group One', 'member');
  await handleMyChatMember(ctx);
  assert.equal(listGroupChats().includes(-22001), true);
  assert.equal(getGroupChatTitle(-22001), 'Group One');
});

test('handleMyChatMember: joining as "administrator" also adds the chat', async () => {
  const ctx = myChatMemberCtx(-22002, 'group', 'Group Two', 'administrator');
  await handleMyChatMember(ctx);
  assert.equal(listGroupChats().includes(-22002), true);
  assert.equal(getGroupChatTitle(-22002), 'Group Two');
});

test('handleMyChatMember: joining a "supergroup" is also handled', async () => {
  const ctx = myChatMemberCtx(-22003, 'supergroup', 'Super Group', 'member');
  await handleMyChatMember(ctx);
  assert.equal(listGroupChats().includes(-22003), true);
  assert.equal(getGroupChatTitle(-22003), 'Super Group');
});

test('handleMyChatMember: "left" status removes an already-known group', async () => {
  const chatId = -22004;
  await handleMyChatMember(myChatMemberCtx(chatId, 'group', 'Leaving Group', 'member'));
  assert.equal(listGroupChats().includes(chatId), true);

  await handleMyChatMember(myChatMemberCtx(chatId, 'group', 'Leaving Group', 'left'));
  assert.equal(listGroupChats().includes(chatId), false);
});

test('handleMyChatMember: "kicked" status removes an already-known group', async () => {
  const chatId = -22005;
  await handleMyChatMember(myChatMemberCtx(chatId, 'group', 'Kicked Group', 'member'));
  assert.equal(listGroupChats().includes(chatId), true);

  await handleMyChatMember(myChatMemberCtx(chatId, 'group', 'Kicked Group', 'kicked'));
  assert.equal(listGroupChats().includes(chatId), false);
});

test('handleMyChatMember: a "private" chat update is ignored entirely', async () => {
  const chatId = -22006;
  const ctx = myChatMemberCtx(chatId, 'private', 'Some Private Chat', 'member');
  await handleMyChatMember(ctx);
  assert.equal(listGroupChats().includes(chatId), false);
});

test('handleMyChatMember: a "channel" chat update is ignored entirely', async () => {
  const chatId = -22007;
  const ctx = myChatMemberCtx(chatId, 'channel', 'Some Channel', 'member');
  await handleMyChatMember(ctx);
  assert.equal(listGroupChats().includes(chatId), false);
});

test('handleMyChatMember: undefined ctx.myChatMember returns without throwing', async () => {
  const ctx = {} as unknown as Context;
  await assert.doesNotReject(() => handleMyChatMember(ctx));
});

test('handleNewChatTitle: updates the stored title for ctx.chat.id', async () => {
  const chatId = -22008;
  await handleMyChatMember(myChatMemberCtx(chatId, 'group', 'Old Title', 'member'));
  assert.equal(getGroupChatTitle(chatId), 'Old Title');

  await handleNewChatTitle(newChatTitleCtx(chatId, 'New Title'));
  assert.equal(getGroupChatTitle(chatId), 'New Title');
});

test('handleNewChatTitle: can add a title for a chat never previously known', async () => {
  const chatId = -22009;
  assert.equal(listGroupChats().includes(chatId), false);

  await handleNewChatTitle(newChatTitleCtx(chatId, 'Brand New Group'));
  assert.equal(listGroupChats().includes(chatId), true);
  assert.equal(getGroupChatTitle(chatId), 'Brand New Group');
});

test('handleNewChatTitle: a plain text message (no new_chat_title) is ignored', async () => {
  const chatId = -22010;
  await handleNewChatTitle(newChatTitleCtx(chatId, undefined));
  assert.equal(listGroupChats().includes(chatId), false);
});

test('handleNewChatTitle: undefined ctx.message returns without throwing', async () => {
  const ctx = { chat: { id: -22011 }, message: undefined } as unknown as Context;
  await assert.doesNotReject(() => handleNewChatTitle(ctx));
  assert.equal(listGroupChats().includes(-22011), false);
});

test('handleNewChatTitle: undefined ctx.chat returns without throwing', async () => {
  const ctx = { chat: undefined, message: { new_chat_title: 'Should Not Apply' } } as unknown as Context;
  await assert.doesNotReject(() => handleNewChatTitle(ctx));
});
