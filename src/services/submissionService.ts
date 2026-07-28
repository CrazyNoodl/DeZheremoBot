import { recordDraw as persistDraw } from '../storage/history.js';
import { isLocked, lock, unlock } from '../storage/lockState.js';
import { isPaused, pause, resume } from '../storage/pauseState.js';
import { msSinceLastSubmit, recordSubmitTime } from '../storage/rateLimit.js';
import { addSubmission, clearSubmissions, getSubmission, listSubmissions, type Submission } from '../storage/store.js';

export const MAX_PLACE_LENGTH = 100;

// Guards against one user flooding the group chat with rapid "змінює варіант" announcements —
// duplicate resubmits of the same place never reach this check, since they're rejected first.
const RATE_LIMIT_MS = 10_000;

export type SubmitResult =
  | { ok: true; previousPlace?: string }
  | { ok: false; reason: 'locked' | 'paused' | 'duplicate' | 'too_long' | 'rate_limited' };

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
