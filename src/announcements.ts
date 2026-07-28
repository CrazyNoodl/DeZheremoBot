import { escapeHtml, placeLink } from './htmlFormat.js';
import type { Submission } from './storage/store.js';

// Shared by scheduler.ts's own draw branch and admin.ts's "force draw now" action, so a manual
// draw's group announcement stays byte-identical to a scheduled one (see "Admin controls" in
// CLAUDE.md: a manual draw must be indistinguishable from an automatic one).
const WINNER_EMOJI = ['🎉', '🥳', '🏆', '😋', '🙌'] as const;
const NOBODY_SUBMITTED_EMOJI = ['😴', '🦗', '👀', '🤷'] as const;

export function pickRandomEmoji(pool: readonly string[]): string {
  return pool[Math.floor(Math.random() * pool.length)];
}

export function buildDrawAnnouncement(winner: Submission | undefined): string {
  return winner
    ? `${pickRandomEmoji(WINNER_EMOJI)} ДеЖеремо цього тижня: ${placeLink(winner.place)}!\n` +
      `(дякуємо <b>${escapeHtml(winner.username)}</b> за ідею)`
    : `${pickRandomEmoji(NOBODY_SUBMITTED_EMOJI)} Цього тижня всі мовчали... наступного разу точно хтось запропонує щось смачне!`;
}
