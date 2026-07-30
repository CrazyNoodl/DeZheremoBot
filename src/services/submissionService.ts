import { blockUser, isBlocked, listBlockedUsers, unblockUser, type BlockedUser } from '../storage/blockedUsers.js';
import {
  clearDeclinedPlace,
  clearDeclinedPlacesForChat,
  getDeclinedPlace as getRememberedDeclinedPlace,
  rememberDeclinedPlace,
} from '../storage/declinedPlace.js';
import { recordDraw as persistDraw } from '../storage/history.js';
import { isLocked, lock, unlock } from '../storage/lockState.js';
import { isPaused, pause, resume } from '../storage/pauseState.js';
import { msSinceLastSubmit, recordSubmitTime } from '../storage/rateLimit.js';
import {
  addDecline,
  addSubmission,
  clearSubmissions,
  getSubmission,
  listSubmissions,
  removeSubmission,
  type Submission,
} from '../storage/store.js';

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
  | { ok: false; reason: 'locked' | 'paused' | 'blocked' | 'duplicate' | 'too_long' | 'invalid_format' | 'rate_limited' };

export function submitPlace(chatId: number, userId: number, username: string, place: string): SubmitResult {
  // Checked ahead of every other gate: a blocked user shouldn't get a pause/lock-specific
  // message that implies they'd be allowed to submit once that state clears.
  if (isBlocked(chatId, userId)) {
    return { ok: false, reason: 'blocked' };
  }

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

  const existing = getSubmission(chatId, userId);
  // Only a real prior place counts as "previous" — a 'declined' row's place is the empty-string
  // placeholder, not an actual place to show a "було: ..." diff against or match for dedup.
  const previousPlace = existing?.status === 'submitted' ? existing.place : undefined;
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

export type DeclineResult =
  // previousPlace is set only when declining actually retracted a real place submission — the
  // caller uses that (and only that) to decide whether the group needs to be told, since a
  // decline that had nothing to retract is a no-op from the group's point of view.
  | { ok: true; declined: boolean; previousPlace?: string }
  | { ok: false; reason: 'locked' | 'paused' | 'blocked' };

// Toggles "не йду цього тижня" — mutually exclusive with an actual place submission, since it
// shares the same (chatId, userId) row: declining overwrites any existing place the same way
// resubmitting a place overwrites a previous decline. Declining a second time cancels it back to
// no response at all, since there's no separate "cancel" affordance in the menu.
export function declinePlace(chatId: number, userId: number, username: string): DeclineResult {
  if (isBlocked(chatId, userId)) {
    return { ok: false, reason: 'blocked' };
  }

  if (isPaused(chatId)) {
    return { ok: false, reason: 'paused' };
  }

  if (isLocked(chatId)) {
    return { ok: false, reason: 'locked' };
  }

  const existing = getSubmission(chatId, userId);
  if (existing?.status === 'declined') {
    removeSubmission(chatId, userId);
    return { ok: true, declined: false };
  }

  const previousPlace = existing?.status === 'submitted' ? existing.place : undefined;
  // Remembers exactly the place this decline is retracting — not anything from an earlier week or
  // response — so cancelling the decline can offer it straight back (see getDeclinedPlace below).
  // Explicitly cleared when there's no real previous place, so a stale value from an earlier
  // week/response can never leak forward as if it were this decline's.
  if (previousPlace !== undefined) {
    rememberDeclinedPlace(chatId, userId, previousPlace);
  } else {
    clearDeclinedPlace(chatId, userId);
  }

  addDecline(chatId, userId, username);
  return { ok: true, declined: true, previousPlace };
}

// The place a user had submitted right before their current decline, if any — see
// storage/declinedPlace.ts for why this is tracked separately from the submissions table itself
// (declining overwrites/empties that row, so the place is otherwise gone once declined).
export function getDeclinedPlace(chatId: number, userId: number): string | undefined {
  return getRememberedDeclinedPlace(chatId, userId);
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

// Unlocks without touching submissions — distinct from resetWeek, which is for starting a fresh
// week. This is for an admin extending/reopening the current week's window after it's already
// locked (by schedule or by a prior manual lock), without losing what's already been submitted.
export function reopenSubmissions(chatId: number): void {
  unlock(chatId);
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

export function isUserBlocked(chatId: number, userId: number): boolean {
  return isBlocked(chatId, userId);
}

// Drops the user's current-week submission along with blocking them — a blocked user shouldn't
// keep a live entry in the draw pool just because they submitted before being blocked.
export function blockUserFromGroup(chatId: number, userId: number, username: string | undefined, blockedBy: number): void {
  blockUser(chatId, userId, username, blockedBy);
  removeSubmission(chatId, userId);
}

export function unblockUserFromGroup(chatId: number, userId: number): void {
  unblockUser(chatId, userId);
}

export function listBlockedUsersInGroup(chatId: number): BlockedUser[] {
  return listBlockedUsers(chatId);
}

// Only counts actual place proposals — a 'declined' row is a considered response, not a candidate
// for the draw.
export function pickWeeklyWinner(chatId: number): Submission | undefined {
  const candidates = listSubmissions(chatId).filter((s) => s.status === 'submitted');
  if (candidates.length === 0) return undefined;

  const index = Math.floor(Math.random() * candidates.length);
  return candidates[index];
}

export function resetWeek(chatId: number): void {
  clearSubmissions(chatId);
  unlock(chatId);
  // A fresh week means nothing left over from the last one — without this, a decline remembered
  // two weeks ago could resurface as a quick-pick option in a week that never touched it.
  clearDeclinedPlacesForChat(chatId);
}

export function recordDraw(chatId: number, winner: Submission | undefined): void {
  // History only ever records actual place proposals, same reasoning as pickWeeklyWinner above —
  // a decliner has never proposed a place, so they shouldn't show up in historical "who submits
  // most"/getHistoricalSubmitters analytics.
  const placeSubmissions = listSubmissions(chatId).filter((s) => s.status === 'submitted');
  persistDraw({ chatId, drawnAt: Date.now(), winner, submissions: placeSubmissions });
}
