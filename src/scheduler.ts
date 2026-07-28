import cron from 'node-cron';
import type { Telegraf } from 'telegraf';
import { buildDrawAnnouncement, pickRandomEmoji } from './announcements.js';
import { buildGroupMenu } from './commands/keyboard.js';
import { getKyivNow } from './kyivTime.js';
import {
  isGroupPaused,
  lockSubmissions,
  pickWeeklyWinner,
  recordDraw,
  resetWeek,
} from './services/submissionService.js';
import { hasFiredToday, markFired } from './storage/firedEvents.js';
import { listGroupChats } from './storage/groupChats.js';
import { getGroupSchedule } from './storage/groupSchedules.js';
import { sendToChat } from './telegramBroadcast.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Rotated so the same weekly message doesn't read as identically robotic every time.
const REMINDER_EMOJI = ['🍽', '🍕', '🥗', '🍜'] as const;

export function startScheduler(bot: Telegraf): void {
  cron.schedule('* * * * *', () => {
    const { weekday, time, date } = getKyivNow();

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
        if (!paused) {
          sendToChat(
            bot.telegram,
            chatId,
            `${pickRandomEmoji(REMINDER_EMOJI)} ДеЖеремо цього тижня! Хто ще не встиг — тисни кнопку 👇`,
            buildGroupMenu(bot.botInfo!.username, chatId),
            DAY_MS,
          );
        }
      }

      if (weekday === schedule.deadlineWeekday && time >= schedule.lockTime && !hasFiredToday(chatId, 'lock', date)) {
        markFired(chatId, 'lock', date);
        if (!paused) lockSubmissions(chatId);
      }

      if (weekday === schedule.deadlineWeekday && time >= schedule.drawTime && !hasFiredToday(chatId, 'draw', date)) {
        markFired(chatId, 'draw', date);
        if (!paused) {
          const winner = pickWeeklyWinner(chatId);
          recordDraw(chatId, winner);
          // resetWeek runs synchronously, right after recordDraw and before the network call below —
          // not chained off sendToChat's promise. Gating the reset on the send meant a crash during
          // that network round-trip left the chat stuck locked (with fired_events already marking
          // 'draw' done for today) until the following week's draw. Unlocking is local, durable state;
          // the announcement is best-effort UI feedback and can safely fail independently.
          resetWeek(chatId);
          sendToChat(bot.telegram, chatId, buildDrawAnnouncement(winner), { parse_mode: 'HTML' });
        }
      }
    }
  });
}
