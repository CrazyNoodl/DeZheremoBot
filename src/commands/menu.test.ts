import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  handleDeclineAction,
  handleGroupDeclineAction,
  handleResubmitDeclinedAction,
  handleSubmitAction,
  showPersonalMenu,
} from './menu.js';
import {
  blockUserFromGroup,
  declinePlace,
  getAllSubmissions,
  lockSubmissions,
  pauseGroup,
  submitPlace,
} from '../services/submissionService.js';
import { getAwaitingChatId } from '../storage/pendingState.js';
import { setMenuMessage } from '../storage/menuMessages.js';

// Mirrors menu.ts's own DECLINE_RETRACTION_POOL — the wording is randomized, so tests assert that
// the retraction reads as *some* member of the pool rather than one fixed phrase.
function isDeclineRetractionAnnouncement(text: string): boolean {
  return /цього тижня не йде \(варіант знято: /.test(text) || /цього тижня пропускає — і забирає варіант: /.test(text);
}

function fakeGroupCtx(status: string, chatId: number, userId: number) {
  const sentMessages: Array<{ chatId: number; text: string }> = [];
  const alerts: Array<{ text?: string; show_alert?: boolean }> = [];
  const ctx = {
    from: { id: userId },
    chat: { id: chatId }, // the group itself — a group callback query already carries this
    telegram: {
      getChatMember: async () => {
        if (status === 'throw') throw new Error('boom');
        return { status };
      },
      sendMessage: async (chatId: number, text: string) => {
        sentMessages.push({ chatId, text });
        return { message_id: 1 };
      },
    },
    answerCbQuery: async (text?: string, extra?: { show_alert?: boolean }) => {
      alerts.push({ text, show_alert: extra?.show_alert });
    },
  };
  return { ctx: ctx as unknown as Parameters<typeof handleGroupDeclineAction>[0], sentMessages, alerts };
}

function fakeCtx(
  status: string,
  userId: number,
  opts: { answerCbQueryThrows?: boolean; callbackData?: string; tappedMessageId?: number } = {},
) {
  const replies: string[] = [];
  const sentMessages: Array<{ chatId: number; text: string }> = [];
  const alerts: Array<{ text?: string; show_alert?: boolean }> = [];
  const ctx = {
    from: { id: userId },
    chat: { id: userId }, // private chat id, distinct per test via userId
    // real callback presses always carry data + the tapped message; tappedMessageId is only set
    // for tests exercising the stale-menu-tap guard (isStaleMenuTap in menu.ts).
    callbackQuery: {
      data: opts.callbackData ?? 'submit',
      ...(opts.tappedMessageId !== undefined ? { message: { message_id: opts.tappedMessageId } } : {}),
    },
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
    answerCbQuery: async (text?: string, extra?: { show_alert?: boolean }) => {
      alerts.push({ text, show_alert: extra?.show_alert });
      if (opts.answerCbQueryThrows) throw new Error('400: query is too old and response timeout expired');
    },
  };
  return { ctx: ctx as unknown as Parameters<typeof showPersonalMenu>[0], replies, sentMessages, alerts };
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
  assert.equal(replies.some((r) => /тебе не буде/.test(r)), true);
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
  assert.ok(isDeclineRetractionAnnouncement(sentMessages[0].text));
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

test('handleGroupDeclineAction refuses a user who is no longer a member, via an alert toast', async () => {
  const groupChatId = -10014;
  const userId = 11014;
  const { ctx, alerts } = fakeGroupCtx('left', groupChatId, userId);

  await handleGroupDeclineAction(ctx);

  assert.equal(getAllSubmissions(groupChatId).length, 0);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].show_alert, true);
  assert.match(alerts[0].text ?? '', /не в цій групі/);
});

test('handleGroupDeclineAction refuses a blocked user, via an alert toast', async () => {
  const groupChatId = -10015;
  const userId = 11015;
  blockUserFromGroup(groupChatId, userId, 'tester', 999);
  const { ctx, alerts } = fakeGroupCtx('member', groupChatId, userId);

  await handleGroupDeclineAction(ctx);

  assert.equal(getAllSubmissions(groupChatId).length, 0);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].show_alert, true);
  assert.match(alerts[0].text ?? '', /заблокували/);
});

test('handleGroupDeclineAction refuses to record a decline for a paused group, via an alert toast', async () => {
  const groupChatId = -10016;
  const userId = 11016;
  pauseGroup(groupChatId);
  const { ctx, alerts } = fakeGroupCtx('member', groupChatId, userId);

  await handleGroupDeclineAction(ctx);

  assert.equal(getAllSubmissions(groupChatId).length, 0);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].show_alert, true);
  assert.match(alerts[0].text ?? '', /паузі/);
});

test('handleGroupDeclineAction refuses to record a decline once submissions are locked, via an alert toast', async () => {
  const groupChatId = -10017;
  const userId = 11017;
  lockSubmissions(groupChatId);
  const { ctx, alerts } = fakeGroupCtx('member', groupChatId, userId);

  await handleGroupDeclineAction(ctx);

  assert.equal(getAllSubmissions(groupChatId).length, 0);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].show_alert, true);
  assert.match(alerts[0].text ?? '', /закрито/);
});

test('handleGroupDeclineAction records a decline silently when nothing was submitted before', async () => {
  const groupChatId = -10018;
  const userId = 11018;
  const { ctx, sentMessages, alerts } = fakeGroupCtx('member', groupChatId, userId);

  await handleGroupDeclineAction(ctx);

  assert.equal(getAllSubmissions(groupChatId)[0]?.status, 'declined');
  assert.equal(sentMessages.length, 0); // nothing to retract, so the group hears nothing
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].show_alert, undefined); // a plain confirmation toast, not an alert
  assert.match(alerts[0].text ?? '', /Записано/);
});

test('handleGroupDeclineAction announces to the group when it retracts an already-submitted place', async () => {
  const groupChatId = -10019;
  const userId = 11019;
  submitPlace(groupChatId, userId, 'tester', 'https://www.instagram.com/somewhere');
  const { ctx, sentMessages } = fakeGroupCtx('member', groupChatId, userId);

  await handleGroupDeclineAction(ctx);

  assert.equal(getAllSubmissions(groupChatId)[0]?.status, 'declined');
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].chatId, groupChatId);
  assert.ok(isDeclineRetractionAnnouncement(sentMessages[0].text));
  assert.match(sentMessages[0].text, /somewhere/);
});

test('handleDeclineAction cancelling a decline offers exactly the place it retracted as a quick-pick', async () => {
  const userId = 11021;
  const groupChatId = -10021;
  submitPlace(groupChatId, userId, 'tester', 'https://www.instagram.com/somewhere');
  setMenuMessage(userId, 999, 64, groupChatId);

  const first = fakeCtx('member', userId);
  await handleDeclineAction(first.ctx);
  assert.equal(getAllSubmissions(groupChatId)[0]?.status, 'declined');

  const second = fakeCtx('member', userId);
  await handleDeclineAction(second.ctx);

  assert.equal(getAllSubmissions(groupChatId).length, 0); // decline cancelled, nothing recorded yet
  assert.equal(getAwaitingChatId(userId), undefined); // did NOT go into the free-text prompt
  assert.equal(second.replies.some((r) => /Плани зміняться/.test(r)), true);
});

test('handleDeclineAction cancelling a decline with nothing retracted falls back to the free-text prompt', async () => {
  const userId = 11026;
  const groupChatId = -10026;
  setMenuMessage(userId, 999, 65, groupChatId);

  const first = fakeCtx('member', userId);
  await handleDeclineAction(first.ctx); // first-ever response this week is a decline, nothing to remember

  const second = fakeCtx('member', userId);
  await handleDeclineAction(second.ctx);

  assert.equal(getAwaitingChatId(userId), groupChatId);
  assert.equal(second.replies.some((r) => /Куди хочеться/.test(r)), true);
});

test('handleResubmitDeclinedAction resubmits the retracted place and announces it to the group', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });

  const userId = 11022;
  const groupChatId = -10022;
  submitPlace(groupChatId, userId, 'tester', 'https://www.instagram.com/somewhere');
  setMenuMessage(userId, 999, 66, groupChatId);
  t.mock.timers.tick(10_001); // past the resubmit cooldown, otherwise this looks rate_limited

  await handleDeclineAction(fakeCtx('member', userId).ctx); // remembers the place, then...
  const { ctx, sentMessages } = fakeCtx('member', userId);
  await handleResubmitDeclinedAction(ctx); // ...offers it straight back

  assert.equal(getAllSubmissions(groupChatId)[0]?.place, 'https://www.instagram.com/somewhere');
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].chatId, groupChatId);
  assert.match(sentMessages[0].text, /somewhere/);
});

test('handleResubmitDeclinedAction refuses a user who is no longer a member, without resubmitting', async () => {
  const userId = 11023;
  const groupChatId = -10023;
  setMenuMessage(userId, 999, 67, groupChatId);

  const { ctx, sentMessages } = fakeCtx('left', userId);
  await handleResubmitDeclinedAction(ctx);

  assert.equal(sentMessages.length, 0);
  assert.equal(getAllSubmissions(groupChatId).length, 0);
});

test('handleResubmitDeclinedAction refuses a blocked user, without resubmitting', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });

  const userId = 11025;
  const groupChatId = -10025;
  submitPlace(groupChatId, userId, 'tester', 'https://www.instagram.com/somewhere');
  setMenuMessage(userId, 999, 68, groupChatId);
  t.mock.timers.tick(10_001);
  await handleDeclineAction(fakeCtx('member', userId).ctx);
  blockUserFromGroup(groupChatId, userId, 'tester', 999);

  const { ctx, sentMessages } = fakeCtx('member', userId);
  await handleResubmitDeclinedAction(ctx);

  assert.equal(sentMessages.length, 0);
  assert.equal(getAllSubmissions(groupChatId).length, 0);
});

test('handleResubmitDeclinedAction falls back to the free-text prompt when nothing is remembered', async () => {
  const userId = 11024;
  const groupChatId = -10024;
  setMenuMessage(userId, 999, 69, groupChatId); // never declined anything — nothing remembered

  const { ctx, replies } = fakeCtx('member', userId);
  await handleResubmitDeclinedAction(ctx);

  assert.equal(getAwaitingChatId(userId), groupChatId);
  assert.equal(replies.some((r) => /Куди хочеться/.test(r)), true);
});

test('handleGroupDeclineAction is idempotent — a second tap after already declining does not cancel it', async () => {
  const groupChatId = -10020;
  const userId = 11020;

  const first = fakeGroupCtx('member', groupChatId, userId);
  await handleGroupDeclineAction(first.ctx);
  assert.equal(getAllSubmissions(groupChatId)[0]?.status, 'declined');

  const second = fakeGroupCtx('member', groupChatId, userId);
  await handleGroupDeclineAction(second.ctx);

  // Unlike the personal menu's handleDeclineAction, a second tap here must NOT toggle the decline
  // back off — Telegram renders one shared keyboard for every viewer, so this button can't relabel
  // itself per-user the way the private menu's can.
  assert.equal(getAllSubmissions(groupChatId).length, 1);
  assert.equal(getAllSubmissions(groupChatId)[0]?.status, 'declined');
  assert.equal(second.sentMessages.length, 0);
  assert.equal(second.alerts.length, 1);
  assert.equal(second.alerts[0].show_alert, undefined);
  assert.match(second.alerts[0].text ?? '', /вже позначив/);
});

test('handleDeclineAction shows a staleness toast and leaves the submission untouched when the tapped card is not the currently tracked one', async () => {
  const userId = 11027;
  const groupChatId = -10027;
  submitPlace(groupChatId, userId, 'tester', 'https://www.instagram.com/somewhere');
  setMenuMessage(userId, 999, 70, groupChatId); // the real, current card is message 70

  const { ctx, alerts } = fakeCtx('member', userId, { tappedMessageId: 71 }); // a different, stale card
  await handleDeclineAction(ctx);

  assert.equal(alerts.some((a) => a.show_alert && /застаріла/.test(a.text ?? '')), true);
  assert.equal(getAllSubmissions(groupChatId)[0]?.status, 'submitted'); // NOT silently declined
});

test('handleDeclineAction proceeds normally when the tapped card matches the currently tracked one', async () => {
  const userId = 11028;
  const groupChatId = -10028;
  setMenuMessage(userId, 999, 72, groupChatId);

  const { ctx, alerts } = fakeCtx('member', userId, { tappedMessageId: 72 });
  await handleDeclineAction(ctx);

  assert.equal(alerts.some((a) => /застаріла/.test(a.text ?? '')), false);
  assert.equal(getAllSubmissions(groupChatId)[0]?.status, 'declined');
});

test('handleSubmitAction shows a staleness toast and does not start the prompt when the tapped card is stale', async () => {
  const userId = 11029;
  const groupChatId = -10029;
  setMenuMessage(userId, 999, 73, groupChatId);

  const { ctx, alerts, replies } = fakeCtx('member', userId, { tappedMessageId: 74 });
  await handleSubmitAction(ctx);

  assert.equal(alerts.some((a) => a.show_alert && /застаріла/.test(a.text ?? '')), true);
  assert.equal(getAwaitingChatId(userId), undefined);
  assert.equal(replies.length, 0);
});

test('handleResubmitDeclinedAction shows a staleness toast and does not resubmit when the tapped card is stale', async () => {
  const userId = 11030;
  const groupChatId = -10030;
  submitPlace(groupChatId, userId, 'tester', 'https://www.instagram.com/somewhere');
  declinePlace(groupChatId, userId, 'tester'); // remembers the place directly, bypassing the UI
  setMenuMessage(userId, 999, 75, groupChatId); // the real, current card is message 75

  const { ctx, alerts, sentMessages } = fakeCtx('member', userId, { tappedMessageId: 76 }); // a different, stale card
  await handleResubmitDeclinedAction(ctx);

  assert.equal(alerts.some((a) => a.show_alert && /застаріла/.test(a.text ?? '')), true);
  assert.equal(sentMessages.length, 0);
});

test('handleResubmitDeclinedAction resubmits normally when the tapped card matches the currently tracked one', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });

  const userId = 11031;
  const groupChatId = -10031;
  submitPlace(groupChatId, userId, 'tester', 'https://www.instagram.com/somewhere');
  declinePlace(groupChatId, userId, 'tester');
  setMenuMessage(userId, 999, 77, groupChatId);
  t.mock.timers.tick(10_001); // past the resubmit cooldown, otherwise this looks rate_limited

  const { ctx, alerts, sentMessages } = fakeCtx('member', userId, { tappedMessageId: 77 });
  await handleResubmitDeclinedAction(ctx);

  assert.equal(alerts.some((a) => /застаріла/.test(a.text ?? '')), false);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /somewhere/);
});
