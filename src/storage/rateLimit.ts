const lastSubmitAt = new Map<string, number>();

// An entry is only ever relevant for RATE_LIMIT_MS (10s, in submissionService.ts) after it's
// written — past that it's dead weight that would otherwise sit in this Map for the lifetime of
// the process, one entry per (chat, user) pair that ever submitted. Comfortably above any real
// rate-limit window; just needs to bound growth, not track the limit itself.
const STALE_AFTER_MS = 60 * 60 * 1000;

function key(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}

export function recordSubmitTime(chatId: number, userId: number): void {
  const now = Date.now();
  lastSubmitAt.set(key(chatId, userId), now);

  for (const [k, ts] of lastSubmitAt) {
    if (now - ts > STALE_AFTER_MS) lastSubmitAt.delete(k);
  }
}

export function msSinceLastSubmit(chatId: number, userId: number): number {
  const last = lastSubmitAt.get(key(chatId, userId));
  return last === undefined ? Infinity : Date.now() - last;
}
