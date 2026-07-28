import { recordDraw as persistDraw } from '../storage/history.js';
import { isLocked, lock, unlock } from '../storage/lockState.js';
import { isPaused, pause, resume } from '../storage/pauseState.js';
import { msSinceLastSubmit, recordSubmitTime } from '../storage/rateLimit.js';
import { addSubmission, clearSubmissions, getSubmission, listSubmissions, type Submission } from '../storage/store.js';

export const MAX_PLACE_LENGTH = 200;

// Guards against one user flooding the group chat with rapid "змінює варіант" announcements —
// duplicate resubmits of the same place never reach this check, since they're rejected first.
const RATE_LIMIT_MS = 10_000;

// Only links from these sources are accepted for now (menu/location/profile links, not free-text
// place names) — each entry matches one provider's share-link shape as seen in the wild:
// https://expz.menu/d0838ea9-b9ae-44dd-b99d-993f0a0206fd, https://maps.app.goo.gl/uKwFMyv1DMrUtZua8,
// https://www.instagram.com/milkbarkyiv. The trailing `(\?.*)?` on each tolerates a query string —
// e.g. Instagram's own "Share" button appends `?igsh=...` tracking params, which would otherwise
// fail a pattern anchored at the end of the path.
const PLACE_LINK_PATTERNS: RegExp[] = [
  /^https:\/\/expz\.menu\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?(\?.*)?$/i,
  /^https:\/\/maps\.app\.goo\.gl\/[A-Za-z0-9_-]+\/?(\?.*)?$/,
  /^https:\/\/(www\.)?instagram\.com\/[A-Za-z0-9._]+\/?(\?.*)?$/,
];

export function isValidPlaceLink(place: string): boolean {
  return PLACE_LINK_PATTERNS.some((pattern) => pattern.test(place));
}

export type SubmitResult =
  | { ok: true; previousPlace?: string }
  | { ok: false; reason: 'locked' | 'paused' | 'duplicate' | 'too_long' | 'invalid_format' | 'rate_limited' };

export function submitPlace(chatId: number, userId: number, username: string, place: string): SubmitResult {
  // Checked ahead of the lock check: pause and lock are independent flags (a paused chat is not
  // automatically locked), so without its own check here submissions would go through as normal
  // while paused.
  if (isPaused(chatId)) {
    return { ok: false, reason: 'paused' };
  }

  if (isLocked(chatId)) {
    return { ok: false, reason: 'locked' };
  }

  if (place.length > MAX_PLACE_LENGTH) {
    return { ok: false, reason: 'too_long' };
  }

  if (!isValidPlaceLink(place)) {
    return { ok: false, reason: 'invalid_format' };
  }

  const previousPlace = getSubmission(chatId, userId)?.place;
  if (previousPlace === place) {
    return { ok: false, reason: 'duplicate' };
  }

  if (msSinceLastSubmit(chatId, userId) < RATE_LIMIT_MS) {
    return { ok: false, reason: 'rate_limited' };
  }

  addSubmission(chatId, userId, username, place);
  recordSubmitTime(chatId, userId);
  return { ok: true, previousPlace };
}

export function getAllSubmissions(chatId: number): Submission[] {
  return listSubmissions(chatId);
}

export function getUserSubmission(chatId: number, userId: number): Submission | undefined {
  return getSubmission(chatId, userId);
}

export function isSubmissionLocked(chatId: number): boolean {
  return isLocked(chatId);
}

export function lockSubmissions(chatId: number): void {
  lock(chatId);
}

export function isGroupPaused(chatId: number): boolean {
  return isPaused(chatId);
}

export function pauseGroup(chatId: number): void {
  pause(chatId);
}

export function resumeGroup(chatId: number): void {
  resume(chatId);
}

export function pickWeeklyWinner(chatId: number): Submission | undefined {
  const submissions = listSubmissions(chatId);
  if (submissions.length === 0) return undefined;

  const index = Math.floor(Math.random() * submissions.length);
  return submissions[index];
}

export function resetWeek(chatId: number): void {
  clearSubmissions(chatId);
  unlock(chatId);
}

export function recordDraw(chatId: number, winner: Submission | undefined): void {
  persistDraw({ chatId, drawnAt: Date.now(), winner, submissions: listSubmissions(chatId) });
}
