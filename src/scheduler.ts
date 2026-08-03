import cron from 'node-cron';
import * as Sentry from '@sentry/node';
import type { Telegraf, Telegram } from 'telegraf';
import { buildDrawAnnouncement, buildFinalReminderExtra, pickRandom, pickRandomEmoji } from './announcements.js';
import { buildGroupMenu } from './commands/keyboard.js';
import { buildRatingKeyboard } from './commands/rating.js';
import { placeLink } from './htmlFormat.js';
import { getKyivNow } from './kyivTime.js';
import { getRatingSurveyContext, isRatingSurveyEnabled } from './services/ratingService.js';
import { getNonSubmittersInfo } from './services/reminderService.js';
import { getFinalReminderWeekday, getFirstReminderWeekday } from './services/scheduleService.js';
import {
  isGroupPaused,
  isRepeatWinner,
  lockSubmissions,
  pickWeeklyWinner,
  recordDraw,
  resetWeek,
} from './services/submissionService.js';
import { hasFiredToday, markFired } from './storage/firedEvents.js';
import { listGroupChats } from './storage/groupChats.js';
import { getGroupSchedule, type GroupScheduleConfig } from './storage/groupSchedules.js';
import { sendDirectMessage, sendToChat } from './telegramBroadcast.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// In-memory, real wall-clock (not the simulated/tested `now` runSchedulerTick takes for Kyiv
// weekday/time) — the /admin diagnostics screen uses this to tell "the per-minute tick is still
// firing" from "it's stuck," which only needs to survive within one running process, the same
// cheap-to-lose reasoning as pendingState.ts/menuMessages.ts.
let lastTickAt: number | null = null;

export function getLastTickAt(): number | null {
  return lastTickAt;
}

// Rotated so the same weekly message doesn't read as identically robotic every time.
const REMINDER_EMOJI = ['🍽', '🍕', '🥗', '🍜'] as const;

// "Хто ще не встиг" (who hasn't managed yet) reads oddly as the very first nudge of the week, since
// it implies the deadline is close — only the non-first reminders (including the tagged final one)
// use that phrasing. buildReminderBaseText is shared by sendTaggedReminder and sendReminder's own
// non-final branch so the two never drift into wording a first/non-first reminder differently.
// Each is a small pool (mirroring REMINDER_EMOJI) so the phrasing itself varies week to week, not
// just the emoji in front of it.
const FIRST_REMINDER_POOL = [
  'ДеЖеремо цього тижня! Обирай заклад — тисни кнопку 👇',
  'Новий тиждень — новий заклад! Тисни кнопку і пропонуй 👇',
  'Час обирати, де їмо цього тижня — тисни кнопку 👇',
] as const;
const FINAL_REMINDER_POOL = [
  'ДеЖеремо цього тижня! Хто ще не встиг — тисни кнопку 👇',
  'Наближається дедлайн — хто ще не встиг, тисни кнопку 👇',
  'Останній шанс запропонувати заклад цього тижня — тисни кнопку 👇',
] as const;

function buildReminderBaseText(isFirst: boolean): string {
  const phrase = pickRandom(isFirst ? FIRST_REMINDER_POOL : FINAL_REMINDER_POOL);
  return `${pickRandomEmoji(REMINDER_EMOJI)} ${phrase}`;
}

// getChatMembersCount can fail (rate limit, transient network) — falling back to "no unknown
// members" degrades to just tagging the people we do know about instead of losing the whole
// reminder, which matters more than an accurate unknown-count on an off day.
async function fetchTotalMembers(telegram: Telegram, chatId: number): Promise<number | undefined> {
  try {
    return await telegram.getChatMembersCount(chatId);
  } catch (err) {
    console.error(`[scheduler] failed to fetch member count for chat ${chatId}:`, err);
    Sentry.captureException(err);
    return undefined;
  }
}

// Sends the reminder with the non-submitter tag-list appended. Shared by the scheduler's own
// automatic reminder (on whichever day getFinalReminderWeekday picks) and commands/schedule.ts's
// "force reminder now" button — so an admin manually nudging stragglers gets the exact same
// tagged message a scheduled final reminder would have sent.
export async function sendTaggedReminder(telegram: Telegram, botUsername: string, chatId: number): Promise<void> {
  const baseText = buildReminderBaseText(false);
  const keyboard = buildGroupMenu(botUsername, chatId);

  const totalMembers = await fetchTotalMembers(telegram, chatId);
  // Passing 0 when the fetch failed still yields unknownCount 0 (the formula floors at 0), so
  // nonSubmitters tagging degrades gracefully without a separate fallback branch.
  const { nonSubmitters, unknownCount } = getNonSubmittersInfo(chatId, totalMembers ?? 0);

  const text = `${baseText}\n\n${buildFinalReminderExtra(nonSubmitters, unknownCount)}`;
  await sendToChat(telegram, chatId, text, { ...keyboard, parse_mode: 'HTML' }, DAY_MS);
}

// The reminder closest to the deadline gets the non-submitter tag-list appended — see
// scheduleService's getFinalReminderWeekday for how "closest" is chosen when no reminder falls on
// the deadline day itself.
async function sendReminder(bot: Telegraf, chatId: number, schedule: GroupScheduleConfig, weekday: number): Promise<void> {
  if (weekday !== getFinalReminderWeekday(schedule)) {
    const isFirst = schedule.reminderWeekdays.length > 1 && weekday === getFirstReminderWeekday(schedule);
    const baseText = buildReminderBaseText(isFirst);
    await sendToChat(bot.telegram, chatId, baseText, buildGroupMenu(bot.botInfo!.username, chatId), DAY_MS);
    return;
  }

  await sendTaggedReminder(bot.telegram, bot.botInfo!.username, chatId);
}

// Fires on its own configured weekday/time, after that week's live submissions table has already
// been cleared by resetWeek — reads the durable draw record instead, via getRatingSurveyContext
// (which also excludes anyone blocked since submitting — see services/ratingService.ts). Only
// status==='submitted' users ever land in submissions_history (recordDraw filters decliners out
// before persisting), so this already asks exactly the "who submitted, not who declined" roster.
// Exported so commands/admin.ts's manual "send rating survey now" button can call the exact same
// code path — with an optional target-user filter, since forcing it for just one person shouldn't
// also re-notify everyone else who already submitted that week (see "Post-draw rating survey").
export async function sendRatingSurvey(telegram: Telegram, chatId: number, onlyUserIds?: number[]): Promise<void> {
  const context = getRatingSurveyContext(chatId);
  if (!context) return; // no draw yet, or nobody submitted that week

  const text = `Як тобі ${placeLink(context.winnerPlace)}? Постав оцінку від 1 до 5 ⭐`;
  const keyboard = buildRatingKeyboard(context.drawId);

  const targets = onlyUserIds ? context.recipients.filter((s) => onlyUserIds.includes(s.userId)) : context.recipients;
  for (const submitter of targets) {
    await sendDirectMessage(telegram, submitter.userId, text, { ...keyboard, parse_mode: 'HTML' });
  }
}

// The per-minute tick's actual logic, factored out so it can be called directly with a controlled
// `now` in tests instead of only ever firing from a real node-cron schedule against the real
// system clock — mirrors why getKyivNow() itself was pulled out of this file (see kyivTime.ts).
export function runSchedulerTick(bot: Telegraf, now: { weekday: number; time: string; date: string }): void {
  lastTickAt = Date.now();
  const { weekday, time, date } = now;

  for (const chatId of listGroupChats()) {
    const schedule = getGroupSchedule(chatId);
    const paused = isGroupPaused(chatId);

    // >= + hasFiredToday instead of === : an exact-minute match means a stalled event loop or a
    // process that was down at that exact minute skips the action forever that day. Comparing
    // "has the scheduled time passed today, and haven't we already done this" catches up on the
    // next tick instead, while fired_events (persisted, survives restarts) stops it from ever
    // firing twice for the same calendar day.
    //
    // A paused chat still calls markFired below when its condition is met — only the actual
    // action (send/lock/draw) is skipped. Marking it fired anyway means a chat paused and
    // resumed on the same calendar day never fires that day's action retroactively on resume:
    // without this, resuming after a scheduled time already passed while paused would look
    // identical to "the process was down at that exact minute" and trigger the same catch-up
    // this comparison exists for, which is the wrong outcome for a deliberate pause. The
    // tradeoff this accepts: a chat paused across its scheduled day skips that occurrence for
    // good, not just until resumed — see "Pausing a group" for why that's the intended behavior.
    if (
      schedule.reminderWeekdays.includes(weekday) &&
      time >= schedule.reminderTime &&
      !hasFiredToday(chatId, 'reminder', date)
    ) {
      markFired(chatId, 'reminder', date);
      if (!paused) sendReminder(bot, chatId, schedule, weekday);
    }

    if (weekday === schedule.deadlineWeekday && time >= schedule.lockTime && !hasFiredToday(chatId, 'lock', date)) {
      markFired(chatId, 'lock', date);
      if (!paused) lockSubmissions(chatId);
    }

    if (weekday === schedule.deadlineWeekday && time >= schedule.drawTime && !hasFiredToday(chatId, 'draw', date)) {
      markFired(chatId, 'draw', date);
      if (!paused) {
        const winner = pickWeeklyWinner(chatId);
        // Computed before recordDraw persists this draw — afterward getLatestDraw would return the
        // draw just recorded instead of the previous week's, always reporting a "repeat".
        const isRepeat = isRepeatWinner(chatId, winner);
        recordDraw(chatId, winner);
        // resetWeek runs synchronously, right after recordDraw and before the network call below —
        // not chained off sendToChat's promise. Gating the reset on the send meant a crash during
        // that network round-trip left the chat stuck locked (with fired_events already marking
        // 'draw' done for today) until the following week's draw. Unlocking is local, durable state;
        // the announcement is best-effort UI feedback and can safely fail independently.
        resetWeek(chatId);
        sendToChat(bot.telegram, chatId, buildDrawAnnouncement(winner, isRepeat), { parse_mode: 'HTML' });
      }
    }

    if (
      isRatingSurveyEnabled(chatId) &&
      weekday === schedule.ratingSurveyWeekday &&
      time >= schedule.ratingSurveyTime &&
      !hasFiredToday(chatId, 'ratingSurvey', date)
    ) {
      markFired(chatId, 'ratingSurvey', date);
      if (!paused) sendRatingSurvey(bot.telegram, chatId);
    }
  }
}

export function startScheduler(bot: Telegraf): void {
  cron.schedule('* * * * *', () => runSchedulerTick(bot, getKyivNow()));
}
