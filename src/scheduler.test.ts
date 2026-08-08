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

const { checkStuckTick, getLastTickAt, runSchedulerTick, runTickSafely, SCHEDULER_STUCK_THRESHOLD_MS } =
  await import('./scheduler.js');
const { addGroupChat } = await import('./storage/groupChats.js');
const { setGroupSchedule } = await import('./storage/groupSchedules.js');
const { hasFiredToday } = await import('./storage/firedEvents.js');
const {
  blockUserFromGroup,
  getAllSubmissions,
  isGroupPaused,
  isSubmissionLocked,
  pauseGroup,
  submitPlace,
} = await import('./services/submissionService.js');
const { setRatingSurveyEnabled } = await import('./services/ratingService.js');

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

// Placed before any other test in this file: runSchedulerTick is called by every test below, and
// lastTickAt is a module-level var shared across the whole file, so "null before any tick" only
// holds if this runs first.
test('getLastTickAt is null before the first tick, then reflects real wall-clock time after one', () => {
  assert.equal(getLastTickAt(), null);

  const before = Date.now();
  const { bot } = fakeBot();
  runSchedulerTick(bot, { weekday: 1, time: '00:00', date: '2024-01-01' });
  const after = Date.now();

  const tickAt = getLastTickAt();
  assert.notEqual(tickAt, null);
  assert.equal(tickAt! >= before && tickAt! <= after, true);
});

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
    ratingSurveyWeekday: 0,
    ratingSurveyTime: '15:00',
  });
  const { bot, sentMessages } = fakeBot();

  // time (10:05) is past reminderTime (10:00) — proves the >= comparison catches up a tick that
  // missed the exact scheduled minute, not just an exact match.
  runSchedulerTick(bot, { weekday: 2, time: '10:05', date: '2026-08-04' });
  await flush();

  const mine = messagesFor(sentMessages, chatId);
  assert.equal(mine.length, 1);
  assert.ok([...FIRST_REMINDER_TEXTS, ...FINAL_REMINDER_TEXTS].some((t) => mine[0].text.includes(t)));
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
    ratingSurveyWeekday: 0,
    ratingSurveyTime: '15:00',
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
    ratingSurveyWeekday: 0,
    ratingSurveyTime: '15:00',
  });
  const { bot, sentMessages } = fakeBot(2); // 2 known members, nobody has ever submitted in this chat

  runSchedulerTick(bot, { weekday: 5, time: '10:00', date: '2026-08-14' });
  await flush();

  const mine = messagesFor(sentMessages, chatId);
  assert.equal(mine.length, 1);
  // No historical submitters (nonSubmitters is empty) but unknownCount > 0 → the count-only branch.
  assert.match(mine[0].text, /кого я не бачив/);
});

// Mirrors scheduler.ts's own FIRST_REMINDER_POOL/FINAL_REMINDER_POOL — the wording is now randomized
// per pool, so these tests assert pool membership rather than a single fixed phrase.
const FIRST_REMINDER_TEXTS = [
  'ДеЖеремо цього тижня! Обирай заклад — тисни кнопку 👇',
  'Новий тиждень — новий заклад! Тисни кнопку і пропонуй 👇',
  'Час обирати, де їмо цього тижня — тисни кнопку 👇',
];
const FINAL_REMINDER_TEXTS = [
  'ДеЖеремо цього тижня! Хто ще не встиг — тисни кнопку 👇',
  'Наближається дедлайн — хто ще не встиг, тисни кнопку 👇',
  'Останній шанс запропонувати заклад цього тижня — тисни кнопку 👇',
];

test('the first reminder of the week gets the opening text instead of "Хто ще не встиг"', async () => {
  const chatId = -24020;
  addGroupChat(chatId, 'Test Group');
  // Mon(1) is farthest from the Fri(5) deadline, so it's the first reminder; Wed(3) is neither
  // first nor final and keeps the old wording (see the next test).
  setGroupSchedule(chatId, {
    reminderWeekdays: [1, 3, 5],
    reminderTime: '10:00',
    deadlineWeekday: 5,
    lockTime: '18:00',
    drawTime: '18:15',
    ratingSurveyWeekday: 0,
    ratingSurveyTime: '15:00',
  });
  const { bot, sentMessages } = fakeBot();

  runSchedulerTick(bot, { weekday: 1, time: '10:00', date: '2026-08-03' });
  await flush();

  const mine = messagesFor(sentMessages, chatId);
  assert.equal(mine.length, 1);
  assert.ok(FIRST_REMINDER_TEXTS.some((t) => mine[0].text.includes(t)));
  assert.ok(FINAL_REMINDER_TEXTS.every((t) => !mine[0].text.includes(t)));
});

test('a middle reminder (neither first nor final) keeps the "Хто ще не встиг" text', async () => {
  const chatId = -24021;
  addGroupChat(chatId, 'Test Group');
  setGroupSchedule(chatId, {
    reminderWeekdays: [1, 3, 5],
    reminderTime: '10:00',
    deadlineWeekday: 5,
    lockTime: '18:00',
    drawTime: '18:15',
    ratingSurveyWeekday: 0,
    ratingSurveyTime: '15:00',
  });
  const { bot, sentMessages } = fakeBot();

  runSchedulerTick(bot, { weekday: 3, time: '10:00', date: '2026-08-05' });
  await flush();

  const mine = messagesFor(sentMessages, chatId);
  assert.equal(mine.length, 1);
  assert.ok(FINAL_REMINDER_TEXTS.some((t) => mine[0].text.includes(t)));
});

test('with only one reminder configured it keeps the "Хто ще не встиг" text, not the opening one', async () => {
  const chatId = -24022;
  addGroupChat(chatId, 'Test Group');
  // A single reminder is simultaneously "first" and "final" — the final/tagged branch always wins,
  // so it must not pick up the first-reminder wording just because reminderWeekdays.length === 1.
  setGroupSchedule(chatId, {
    reminderWeekdays: [5],
    reminderTime: '10:00',
    deadlineWeekday: 5,
    lockTime: '18:00',
    drawTime: '18:15',
    ratingSurveyWeekday: 0,
    ratingSurveyTime: '15:00',
  });
  const { bot, sentMessages } = fakeBot(1);

  runSchedulerTick(bot, { weekday: 5, time: '10:00', date: '2026-08-07' });
  await flush();

  const mine = messagesFor(sentMessages, chatId);
  assert.equal(mine.length, 1);
  assert.ok(FINAL_REMINDER_TEXTS.some((t) => mine[0].text.includes(t)));
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
    ratingSurveyWeekday: 0,
    ratingSurveyTime: '15:00',
  });
  setGroupSchedule(nonMatching, {
    reminderWeekdays: [3],
    reminderTime: '09:00',
    deadlineWeekday: 5,
    lockTime: '18:00',
    drawTime: '18:15',
    ratingSurveyWeekday: 0,
    ratingSurveyTime: '15:00',
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
    ratingSurveyWeekday: 0,
    ratingSurveyTime: '15:00',
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
    ratingSurveyWeekday: 0,
    ratingSurveyTime: '15:00',
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
    ratingSurveyWeekday: 0,
    ratingSurveyTime: '15:00',
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
    ratingSurveyWeekday: 0,
    ratingSurveyTime: '15:00',
  });
  submitPlace(chatId, userId, 'tester', 'https://www.instagram.com/somewhere');
  const { bot, sentMessages } = fakeBot();

  runSchedulerTick(bot, { weekday: 5, time: '18:15', date: '2026-08-28' });
  await flush();
  runSchedulerTick(bot, { weekday: 5, time: '18:20', date: '2026-08-28' });
  await flush();

  assert.equal(messagesFor(sentMessages, chatId).length, 1);
});

test('the rating survey fires on its own configured day/time and DMs each submitter privately', async () => {
  const chatId = -24011;
  const userId = 30005;
  addGroupChat(chatId, 'Test Group');
  setGroupSchedule(chatId, {
    reminderWeekdays: [],
    reminderTime: '10:00',
    deadlineWeekday: 5,
    lockTime: '18:00',
    drawTime: '18:15',
    ratingSurveyWeekday: 0,
    ratingSurveyTime: '15:00',
  });
  submitPlace(chatId, userId, 'tester', 'https://www.instagram.com/somewhere');
  const { bot, sentMessages } = fakeBot();

  runSchedulerTick(bot, { weekday: 5, time: '18:15', date: '2026-08-21' }); // draw happens first
  await flush();
  runSchedulerTick(bot, { weekday: 0, time: '15:00', date: '2026-08-23' }); // survey follows, own day/time
  await flush();

  const dm = messagesFor(sentMessages, userId); // sent to the submitter's private chat, not the group
  assert.equal(dm.length, 1);
  assert.match(dm[0].text, /somewhere/);
  assert.equal(hasFiredToday(chatId, 'ratingSurvey', '2026-08-23'), true);
});

test('the rating survey does not fire when disabled', async () => {
  const chatId = -24012;
  const userId = 30006;
  addGroupChat(chatId, 'Test Group');
  setGroupSchedule(chatId, {
    reminderWeekdays: [],
    reminderTime: '10:00',
    deadlineWeekday: 5,
    lockTime: '18:00',
    drawTime: '18:15',
    ratingSurveyWeekday: 0,
    ratingSurveyTime: '15:00',
  });
  setRatingSurveyEnabled(chatId, false); // now a separate live-cycle flag, not part of GroupScheduleConfig
  submitPlace(chatId, userId, 'tester', 'https://www.instagram.com/somewhere');
  const { bot, sentMessages } = fakeBot();

  runSchedulerTick(bot, { weekday: 5, time: '18:15', date: '2026-08-21' });
  await flush();
  runSchedulerTick(bot, { weekday: 0, time: '15:00', date: '2026-08-23' });
  await flush();

  assert.equal(messagesFor(sentMessages, userId).length, 0);
  assert.equal(hasFiredToday(chatId, 'ratingSurvey', '2026-08-23'), false);
});

test('the rating survey marks fired but sends nothing when the latest draw had no winner', async () => {
  const chatId = -24013;
  addGroupChat(chatId, 'Test Group');
  setGroupSchedule(chatId, {
    reminderWeekdays: [],
    reminderTime: '10:00',
    deadlineWeekday: 5,
    lockTime: '18:00',
    drawTime: '18:15',
    ratingSurveyWeekday: 0,
    ratingSurveyTime: '15:00',
  });
  const { bot, sentMessages } = fakeBot();

  runSchedulerTick(bot, { weekday: 5, time: '18:15', date: '2026-08-21' }); // nobody submitted
  await flush();
  runSchedulerTick(bot, { weekday: 0, time: '15:00', date: '2026-08-23' });
  await flush();

  assert.equal(hasFiredToday(chatId, 'ratingSurvey', '2026-08-23'), true);
  assert.equal(sentMessages.length, 1); // only the group's own "nobody submitted" announcement
});

test('a paused chat still marks the rating survey fired but skips sending it', async () => {
  const chatId = -24014;
  const userId = 30007;
  addGroupChat(chatId, 'Test Group');
  setGroupSchedule(chatId, {
    reminderWeekdays: [],
    reminderTime: '10:00',
    deadlineWeekday: 5,
    lockTime: '18:00',
    drawTime: '18:15',
    ratingSurveyWeekday: 0,
    ratingSurveyTime: '15:00',
  });
  submitPlace(chatId, userId, 'tester', 'https://www.instagram.com/somewhere');
  const { bot, sentMessages } = fakeBot();

  runSchedulerTick(bot, { weekday: 5, time: '18:15', date: '2026-08-21' });
  await flush();

  pauseGroup(chatId);
  runSchedulerTick(bot, { weekday: 0, time: '15:00', date: '2026-08-23' });
  await flush();

  assert.equal(hasFiredToday(chatId, 'ratingSurvey', '2026-08-23'), true);
  assert.equal(messagesFor(sentMessages, userId).length, 0);
});

test('the rating survey does not fire twice for the same calendar day', async () => {
  const chatId = -24015;
  const userId = 30008;
  addGroupChat(chatId, 'Test Group');
  setGroupSchedule(chatId, {
    reminderWeekdays: [],
    reminderTime: '10:00',
    deadlineWeekday: 5,
    lockTime: '18:00',
    drawTime: '18:15',
    ratingSurveyWeekday: 0,
    ratingSurveyTime: '15:00',
  });
  submitPlace(chatId, userId, 'tester', 'https://www.instagram.com/somewhere');
  const { bot, sentMessages } = fakeBot();

  runSchedulerTick(bot, { weekday: 5, time: '18:15', date: '2026-08-21' });
  await flush();
  runSchedulerTick(bot, { weekday: 0, time: '15:00', date: '2026-08-23' });
  await flush();
  runSchedulerTick(bot, { weekday: 0, time: '15:05', date: '2026-08-23' });
  await flush();

  assert.equal(messagesFor(sentMessages, userId).length, 1);
});

test('the rating survey does not DM a submitter who was blocked after that week\'s draw', async () => {
  const chatId = -24016;
  const submitterUserId = 30009;
  const blockedUserId = 30010;
  addGroupChat(chatId, 'Test Group');
  setGroupSchedule(chatId, {
    reminderWeekdays: [],
    reminderTime: '10:00',
    deadlineWeekday: 5,
    lockTime: '18:00',
    drawTime: '18:15',
    ratingSurveyWeekday: 0,
    ratingSurveyTime: '15:00',
  });
  submitPlace(chatId, submitterUserId, 'tester', 'https://www.instagram.com/somewhere');
  submitPlace(chatId, blockedUserId, 'tester2', 'https://www.instagram.com/elsewhere');
  const { bot, sentMessages } = fakeBot();

  runSchedulerTick(bot, { weekday: 5, time: '18:15', date: '2026-08-21' }); // both submitted to this draw
  await flush();

  blockUserFromGroup(chatId, blockedUserId, 'tester2', 999); // blocked only after the draw

  runSchedulerTick(bot, { weekday: 0, time: '15:00', date: '2026-08-23' });
  await flush();

  assert.equal(messagesFor(sentMessages, submitterUserId).length, 1);
  assert.equal(messagesFor(sentMessages, blockedUserId).length, 0);
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
    ratingSurveyWeekday: 0,
    ratingSurveyTime: '15:00',
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

test('runTickSafely runs a normal tick without throwing (Sentry.withMonitor no-ops with no DSN configured)', () => {
  const { bot } = fakeBot();
  const before = getLastTickAt();

  runTickSafely(bot);

  assert.notEqual(getLastTickAt(), before); // proves the real tick underneath still ran
});

// checkStuckTick is on its own independent timer from the per-minute cron tick specifically so it
// can flag a stall even if the tick's own callback is what's hung — see scheduler.ts. Its opt-in
// gate (DEZHEREMO_ALERT_CHAT_ID) mirrors SENTRY_DSN's optional pattern, so these tests set/clear
// the env var themselves rather than relying on it being globally configured for the test run.
test('checkStuckTick does nothing when DEZHEREMO_ALERT_CHAT_ID is unset, even long past the stuck threshold', () => {
  delete process.env.DEZHEREMO_ALERT_CHAT_ID;
  const { bot } = fakeBot();
  runSchedulerTick(bot, { weekday: 1, time: '00:00', date: '2024-01-01' }); // pins lastTickAt to "now"

  let called = false;
  const telegram = {
    sendMessage: async () => {
      called = true;
      return { message_id: 1 };
    },
  };

  checkStuckTick(telegram as unknown as Parameters<typeof checkStuckTick>[0], getLastTickAt()! + SCHEDULER_STUCK_THRESHOLD_MS + 60_000);

  assert.equal(called, false);
});

test('checkStuckTick alerts once per stall and re-arms after the tick recovers', () => {
  process.env.DEZHEREMO_ALERT_CHAT_ID = '424242';
  try {
    const { bot } = fakeBot();
    runSchedulerTick(bot, { weekday: 1, time: '00:00', date: '2024-01-01' }); // pins lastTickAt to "now"
    const pinnedAt = getLastTickAt()!;

    const sent: Array<{ chatId: number; text: string }> = [];
    const telegram = {
      sendMessage: async (chatId: number, text: string) => {
        sent.push({ chatId, text });
        return { message_id: 1 };
      },
    } as unknown as Parameters<typeof checkStuckTick>[0];

    const staleNow = pinnedAt + SCHEDULER_STUCK_THRESHOLD_MS + 60_000;
    checkStuckTick(telegram, staleNow);
    checkStuckTick(telegram, staleNow + 1000); // still stale — must not alert a second time

    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, 424242);
    assert.match(sent[0].text, /Планувальник/);

    // A fresh tick moves lastTickAt forward — "now" reads as fresh again, and the latch re-arms.
    runSchedulerTick(bot, { weekday: 1, time: '00:01', date: '2024-01-01' });
    checkStuckTick(telegram, getLastTickAt()!);
    assert.equal(sent.length, 1); // recovering itself sends nothing

    // Stalling again after a recovery must alert again, not stay silenced by the earlier latch.
    checkStuckTick(telegram, getLastTickAt()! + SCHEDULER_STUCK_THRESHOLD_MS + 60_000);
    assert.equal(sent.length, 2);
  } finally {
    delete process.env.DEZHEREMO_ALERT_CHAT_ID;
  }
});
