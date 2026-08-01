import { escapeHtml, placeLink } from './htmlFormat.js';
import { getKyivNow } from './kyivTime.js';
import type { HistoricalSubmitter } from './storage/history.js';
import type { Submission } from './storage/store.js';

// Shared by scheduler.ts's own draw branch and admin.ts's "force draw now" action, so a manual
// draw's group announcement stays byte-identical to a scheduled one (see "Admin controls" in
// CLAUDE.md: a manual draw must be indistinguishable from an automatic one).
const WINNER_EMOJI = ['🎉', '🥳', '🏆', '😋', '🙌'] as const;
// Picked instead of WINNER_EMOJI when the same place wins two weeks running (see isRepeatWinner in
// submissionService.ts) — a distinct, slightly-teasing pool rather than the regular celebratory one.
const REPEAT_WINNER_EMOJI = ['🔁', '😂', '🤯', '🎲'] as const;
const NOBODY_SUBMITTED_EMOJI = ['😴', '🦗', '👀', '🤷'] as const;
const ALL_SUBMITTED_EMOJI = ['✅', '🙌', '🎯', '💪'] as const;

// Widens a single calendar date to a window centered on it (daysBefore/daysAfter on each side)
// rather than only firing on the exact day — gives a themed pool a real chance of landing on one of
// that week's actual messages instead of needing a direct hit. Computed via real Date arithmetic
// rather than hand-counting month lengths, since Oct 31 + 3 days crosses into November.
function windowAround(monthDay: string, daysBefore: number, daysAfter: number): { from: string; to: string } {
  const [month, day] = monthDay.split('-').map(Number);
  // Only the month/day this produces is ever used, never the year itself — any year would give the
  // same result (none of these windows touch Feb 29), so this is deliberately a fixed, arbitrary
  // placeholder rather than "this year," which would wrongly suggest it needs bumping annually.
  const REFERENCE_YEAR = 1990;
  const format = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

  const from = new Date(Date.UTC(REFERENCE_YEAR, month - 1, day - daysBefore));
  const to = new Date(Date.UTC(REFERENCE_YEAR, month - 1, day + daysAfter));
  return { from: format(from), to: format(to) };
}

// Swaps in a themed pool on a handful of calendar dates, so a pick reads as a small seasonal touch
// on those days rather than always the same year-round handful. `from`/`to` are "MM-DD"; `from > to`
// wraps across the New Year (e.g. Dec 25 -> Jan 8). New Year is already a multi-day range by nature;
// the single-day holidays are widened to a week (3 days either side) via windowAround so they don't
// need to land on the exact date to show up.
const SEASONAL_POOLS: readonly { from: string; to: string; emoji: readonly string[] }[] = [
  { from: '12-25', to: '01-08', emoji: ['🎄', '🎅', '🎁', '❄️', '🥂'] },
  { ...windowAround('01-22', 3, 3), emoji: ['💙', '💛', '🇺🇦'] }, // День Соборності України
  { ...windowAround('02-14', 3, 3), emoji: ['💘', '😍', '🌹'] }, // День Валентина
  { ...windowAround('03-08', 3, 3), emoji: ['🌷', '🌸', '💐'] }, // Міжнародний жіночий день
  { ...windowAround('04-01', 3, 3), emoji: ['🤡', '😂', '🃏'] }, // День сміху
  { ...windowAround('06-28', 3, 3), emoji: ['💙', '💛', '📜'] }, // День Конституції України
  { ...windowAround('07-07', 3, 3), emoji: ['🔥', '🌻', '💧'] }, // Івана Купала
  { ...windowAround('08-24', 3, 3), emoji: ['💙', '💛', '🇺🇦'] }, // День Незалежності України
  { ...windowAround('10-31', 3, 3), emoji: ['🎃', '👻', '🕸️'] }, // Хелловін
];

function seasonalPool(monthDay: string): readonly string[] | undefined {
  return SEASONAL_POOLS.find(({ from, to }) => (from <= to ? monthDay >= from && monthDay <= to : monthDay >= from || monthDay <= to))
    ?.emoji;
}

export function pickRandomEmoji(pool: readonly string[]): string {
  // "YYYY-MM-DD" -> "MM-DD", same Kyiv-time date the scheduler ticks against, independent of the
  // server's own timezone.
  const effectivePool = seasonalPool(getKyivNow().date.slice(5)) ?? pool;
  return effectivePool[Math.floor(Math.random() * effectivePool.length)];
}

// isRepeatWinner (services/submissionService.ts) must be computed before recordDraw persists the
// new draw, then passed straight through here — see that function's own comment for why.
export function buildDrawAnnouncement(winner: Submission | undefined, isRepeatWinner = false): string {
  if (!winner) {
    return `${pickRandomEmoji(NOBODY_SUBMITTED_EMOJI)} Цього тижня всі мовчали... наступного разу точно хтось запропонує щось смачне!`;
  }

  if (isRepeatWinner) {
    return (
      `${pickRandomEmoji(REPEAT_WINNER_EMOJI)} ДеЖеремо цього тижня: ${placeLink(winner.place)} — знову?! ` +
      `Два тижні поспіль, доля явно щось знає 👀\n(дякуємо <b>${escapeHtml(winner.username)}</b> за ідею)`
    );
  }

  return (
    `${pickRandomEmoji(WINNER_EMOJI)} ДеЖеремо цього тижня: ${placeLink(winner.place)}!\n` +
    `(дякуємо <b>${escapeHtml(winner.username)}</b> за ідею)`
  );
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
