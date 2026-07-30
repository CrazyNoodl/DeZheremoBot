import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Telegraf } from 'telegraf';

// scheduler.ts pulls in storage/groupChats.ts and storage/groupSchedules.ts (directly, and via
// telegramBroadcast.ts's own groupChats.ts dependency), both of which load their state from
// DEZHEREMO_DATA_DIR once at import time — same isolation approach as commands/schedule.test.ts.
process.env.DEZHEREMO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dzb-scheduler-'));

const { runSchedulerTick } = await import('./scheduler.js');
const { addGroupChat } = await import('./storage/groupChats.js');
const { setGroupSchedule } = await import('./storage/groupSchedules.js');
const { hasFiredToday } = await import('./storage/firedEvents.js');
const {
  getAllSubmissions,
  isGroupPaused,
  isSubmissionLocked,
  pauseGroup,
  submitPlace,
} = await import('./services/submissionService.js');

function fakeBot(chatMembersCount = 0) {
  const sentMessages: Array<{ chatId: number; text: string }> = [];
  const bot = {
    botInfo: { username: 'TestBot' },
    telegram: {
      sendMessage: async (chatId: number, text: string) => {
        sentMessages.push({ chatId, text });
        return { message_id: 1 };
      },
      deleteMessage: async () => {},
      getChatMembersCount: async () => chatMembersCount,
    },
  };
  return { bot: bot as unknown as Telegraf, sentMessages };
}

// Waits for the fire-and-forget async work runSchedulerTick kicks off (sendReminder/sendToChat
// are not awaited by the tick itself, same as production) to settle before assertions run.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// listGroupChats() accumulates every chat ever added across this whole file's tests (nothing
// removes one), so every tick below also re-evaluates every earlier test's chat against the new
// weekday/time/date — exactly like the real scheduler would for a bot serving many groups at
// once. Filtering sentMessages down to the chat under test (rather than asserting on the array's
// raw length) is what keeps each test's assertions accurate regardless of that accumulation.
function messagesFor(sentMessages: Array<{ chatId: number; text: string }>, chatId: number) {
  return sentMessages.filter((m) => m.chatId === chatId);
}

test('a plain reminder fires once reminderTime has passed and marks it fired for today', async () => {
  const chatId = -24001;
  addGroupChat(chatId, 'Test Group');
  // deadlineWeekday 5 (Fri) is the final-reminder day (distance 0); weekday 2 (Tue) is not, so this
  // exercises the untagged branch of sendReminder.
  setGroupSchedule(chatId, {
    reminderWeekdays: [2, 5],
    reminderTime: '10:00',
    deadlineWeekday: 5,
    lockTime: '18:00',
    drawTime: '18:15',
  });
  const { bot, sentMessages } = fakeBot();

  // time (10:05) is past reminderTime (10:00) — proves the >= comparison catches up a tick that
  // missed the exact scheduled minute, not just an exact match.
  runSchedulerTick(bot, { weekday: 2, time: '10:05', date: '2026-08-04' });
  await flush();

  const mine = messagesFor(sentMessages, chatId);
  assert.equal(mine.length, 1);
  assert.match(mine[0].text, /ДеЖеремо цього тижня/);
  assert.doesNotMatch(mine[0].text, /Ще не встигли|Усі вже встигли|кого я не бачив/);
  assert.equal(hasFiredToday(chatId, 'reminder', '2026-08-04'), true);
});

test('a reminder does not fire twice for the same calendar day', async () => {
  const chatId = -24002;
  addGroupChat(chatId, 'Test Group');
  setGroupSchedule(chatId, {
    reminderWeekdays: [2],
    reminderTime: '10:00',
    deadlineWeekday: 5,
    lockTime: '18:00',
    drawTime: '18:15',
  });
  const { bot, sentMessages } = fakeBot();

  runSchedulerTick(bot, { weekday: 2, time: '10:00', date: '2026-08-11' });
  await flush();
  runSchedulerTick(bot, { weekday: 2, time: '10:01', date: '2026-08-11' });
  await flush();

  assert.equal(messagesFor(sentMessages, chatId).length, 1);
});

test('the reminder closest to the deadline is tagged with the non-submitter extra instead of the plain text', async () => {
  const chatId = -24003;
  addGroupChat(chatId, 'Test Group');
  setGroupSchedule(chatId, {
    reminderWeekdays: [5],
    reminderTime: '10:00',
    deadlineWeekday: 5,
    lockTime: '18:00',
    drawTime: '18:15',
  });
  const { bot, sentMessages } = fakeBot(2); // 2 known members, nobody has ever submitted in this chat

  runSchedulerTick(bot, { weekday: 5, time: '10:00', date: '2026-08-14' });
  await flush();

  const mine = messagesFor(sentMessages, chatId);
  assert.equal(mine.length, 1);
  // No historical submitters (nonSubmitters is empty) but unknownCount > 0 → the count-only branch.
  assert.match(mine[0].text, /кого я не бачив/);
});

test('a reminder only fires for chats whose own schedule actually matches the tick', async () => {
  const matching = -24004;
  const nonMatching = -24005;
  addGroupChat(matching, 'Matches');
  addGroupChat(nonMatching, 'Does not match');
  setGroupSchedule(matching, {
    reminderWeekdays: [1],
    reminderTime: '09:00',
    deadlineWeekday: 5,
    lockTime: '18:00',
    drawTime: '18:15',
  });
  setGroupSchedule(nonMatching, {
    reminderWeekdays: [3],
    reminderTime: '09:00',
    deadlineWeekday: 5,
    lockTime: '18:00',
    drawTime: '18:15',
  });
  const { bot, sentMessages } = fakeBot();

  runSchedulerTick(bot, { weekday: 1, time: '09:00', date: '2026-08-17' });
  await flush();

  assert.equal(messagesFor(sentMessages, matching).length, 1);
  assert.equal(messagesFor(sentMessages, nonMatching).length, 0);
});

test('lockTime passing locks submissions for that chat and marks it fired', () => {
  const chatId = -24006;
  addGroupChat(chatId, 'Test Group');
  // reminderWeekdays: [] — isolates this test to only the lock condition, since this chat's
  // deadlineWeekday/tick weekday would otherwise also satisfy a default reminder schedule.
  setGroupSchedule(chatId, {
    reminderWeekdays: [],
    reminderTime: '10:00',
    deadlineWeekday: 5,
    lockTime: '18:00',
    drawTime: '23:59',
  });
  submitPlace(chatId, 30001, 'tester', 'https://www.instagram.com/somewhere');
  const { bot } = fakeBot();

  assert.equal(isSubmissionLocked(chatId), false);
  runSchedulerTick(bot, { weekday: 5, time: '18:00', date: '2026-08-07' });

  assert.equal(isSubmissionLocked(chatId), true);
  assert.equal(hasFiredToday(chatId, 'lock', '2026-08-07'), true);
});

test('drawTime passing with a submission picks a winner, records history, resets the week, and announces it', async () => {
  const chatId = -24007;
  const userId = 30002;
  addGroupChat(chatId, 'Test Group');
  setGroupSchedule(chatId, {
    reminderWeekdays: [],
    reminderTime: '10:00',
    deadlineWeekday: 5,
    lockTime: '18:00',
    drawTime: '18:15',
  });
  submitPlace(chatId, userId, 'tester', 'https://www.instagram.com/somewhere');
  const { bot, sentMessages } = fakeBot();

  runSchedulerTick(bot, { weekday: 5, time: '18:15', date: '2026-08-21' });
  await flush();

  assert.equal(getAllSubmissions(chatId).length, 0); // resetWeek cleared it
  assert.equal(isSubmissionLocked(chatId), false); // resetWeek unlocked it
  assert.equal(hasFiredToday(chatId, 'draw', '2026-08-21'), true);
  const mine = messagesFor(sentMessages, chatId);
  assert.equal(mine.length, 1);
  assert.match(mine[0].text, /somewhere/);
});

test('drawTime passing with no submissions announces "nobody submitted" instead of a place', async () => {
  const chatId = -24008;
  addGroupChat(chatId, 'Test Group');
  setGroupSchedule(chatId, {
    reminderWeekdays: [],
    reminderTime: '10:00',
    deadlineWeekday: 5,
    lockTime: '18:00',
    drawTime: '18:15',
  });
  const { bot, sentMessages } = fakeBot();

  runSchedulerTick(bot, { weekday: 5, time: '18:15', date: '2026-08-21' });
  await flush();

  const mine = messagesFor(sentMessages, chatId);
  assert.equal(mine.length, 1);
  assert.match(mine[0].text, /мовчали/);
});

test('a draw does not fire twice for the same calendar day', async () => {
  const chatId = -24009;
  const userId = 30003;
  addGroupChat(chatId, 'Test Group');
  setGroupSchedule(chatId, {
    reminderWeekdays: [],
    reminderTime: '10:00',
    deadlineWeekday: 5,
    lockTime: '18:00',
    drawTime: '18:15',
  });
  submitPlace(chatId, userId, 'tester', 'https://www.instagram.com/somewhere');
  const { bot, sentMessages } = fakeBot();

  runSchedulerTick(bot, { weekday: 5, time: '18:15', date: '2026-08-28' });
  await flush();
  runSchedulerTick(bot, { weekday: 5, time: '18:20', date: '2026-08-28' });
  await flush();

  assert.equal(messagesFor(sentMessages, chatId).length, 1);
});

test('a paused chat still marks reminder/lock/draw fired for today but skips the actual side effects', async () => {
  const chatId = -24010;
  const userId = 30004;
  addGroupChat(chatId, 'Test Group');
  setGroupSchedule(chatId, {
    reminderWeekdays: [5],
    reminderTime: '10:00',
    deadlineWeekday: 5,
    lockTime: '18:00',
    drawTime: '18:15',
  });
  submitPlace(chatId, userId, 'tester', 'https://www.instagram.com/somewhere');
  pauseGroup(chatId);
  assert.equal(isGroupPaused(chatId), true);
  const { bot, sentMessages } = fakeBot();

  const date = '2026-09-04';
  runSchedulerTick(bot, { weekday: 5, time: '10:00', date });
  runSchedulerTick(bot, { weekday: 5, time: '18:00', date });
  runSchedulerTick(bot, { weekday: 5, time: '18:15', date });
  await flush();

  assert.equal(hasFiredToday(chatId, 'reminder', date), true);
  assert.equal(hasFiredToday(chatId, 'lock', date), true);
  assert.equal(hasFiredToday(chatId, 'draw', date), true);
  assert.equal(messagesFor(sentMessages, chatId).length, 0); // nothing actually sent
  assert.equal(isSubmissionLocked(chatId), false); // lock was skipped
  assert.equal(getAllSubmissions(chatId).length, 1); // draw/reset was skipped, submission survives
});
