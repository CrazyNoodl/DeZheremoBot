import { escapeHtml, placeLink } from './htmlFormat.js';
import type { HistoricalSubmitter } from './storage/history.js';
import type { Submission } from './storage/store.js';

// Shared by scheduler.ts's own draw branch and admin.ts's "force draw now" action, so a manual
// draw's group announcement stays byte-identical to a scheduled one (see "Admin controls" in
// CLAUDE.md: a manual draw must be indistinguishable from an automatic one).
const WINNER_EMOJI = ['🎉', '🥳', '🏆', '😋', '🙌'] as const;
const NOBODY_SUBMITTED_EMOJI = ['😴', '🦗', '👀', '🤷'] as const;
const ALL_SUBMITTED_EMOJI = ['✅', '🙌', '🎯', '💪'] as const;

export function pickRandomEmoji(pool: readonly string[]): string {
  return pool[Math.floor(Math.random() * pool.length)];
}

export function buildDrawAnnouncement(winner: Submission | undefined): string {
  return winner
    ? `${pickRandomEmoji(WINNER_EMOJI)} ДеЖеремо цього тижня: ${placeLink(winner.place)}!\n` +
      `(дякуємо <b>${escapeHtml(winner.username)}</b> за ідею)`
    : `${pickRandomEmoji(NOBODY_SUBMITTED_EMOJI)} Цього тижня всі мовчали... наступного разу точно хтось запропонує щось смачне!`;
}

// Ukrainian noun agreement for a count of people: 1 → людина, 2-4 → людини, 5+ (and the
// 11-14 exception, which the %10 rule alone would otherwise misclassify as 2-4) → людей.
function peopleWord(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'людей';
  if (mod10 === 1) return 'людина';
  if (mod10 >= 2 && mod10 <= 4) return 'людини';
  return 'людей';
}

function mentionUser(user: HistoricalSubmitter): string {
  return `<a href="tg://user?id=${user.userId}">${escapeHtml(user.username)}</a>`;
}

// Appended to the reminder that lands closest to the deadline (see scheduleService's
// getFinalReminderWeekday) — the one moment in the week where nudging stragglers by name actually
// makes sense, since after this reminder submissions close. nonSubmitters are people the bot has
// seen submit in a past week and can therefore name/tag; unknownCount covers group members it's
// never seen submit anything (Telegram's Bot API has no way to list a chat's full membership), who
// can only be reported as a number.
export function buildFinalReminderExtra(nonSubmitters: HistoricalSubmitter[], unknownCount: number): string {
  if (nonSubmitters.length === 0 && unknownCount === 0) {
    return `${pickRandomEmoji(ALL_SUBMITTED_EMOJI)} Усі вже встигли додати варіант — лишається чекати на розіграш!`;
  }

  if (nonSubmitters.length === 0) {
    return (
      `⏰ Всі, кого я знаю, вже додали варіант — але в групі є ще ${unknownCount} ${peopleWord(unknownCount)}, ` +
      `кого я не бачив 👀 Якщо це ти — тисни кнопку!`
    );
  }

  const mentions = nonSubmitters.map(mentionUser).join(', ');
  const unknownSuffix = unknownCount > 0 ? ` і ще ${unknownCount} ${peopleWord(unknownCount)}, кого я не знаю` : '';
  return `⏰ Ще не встигли: ${mentions}${unknownSuffix}`;
}
