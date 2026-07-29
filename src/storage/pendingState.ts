const awaitingSubmission = new Map<number, number>(); // userId -> which group chat this submission is for
// An opaque token per markAwaitingSubmission call, so a later TTL-based cleanup (commands/add.ts)
// can tell "this is still the same prompt I set" from "superseded by a newer one since" — the same
// problem menuMessages.ts/panelMessages.ts solve by comparing a tracked messageId.
const awaitingTokens = new Map<number, object>();

export function markAwaitingSubmission(userId: number, chatId: number): object {
  const token = {};
  awaitingSubmission.set(userId, chatId);
  awaitingTokens.set(userId, token);
  return token;
}

export function getAwaitingChatId(userId: number): number | undefined {
  return awaitingSubmission.get(userId);
}

export function isCurrentAwaitingToken(userId: number, token: object): boolean {
  return awaitingTokens.get(userId) === token;
}

export function clearAwaitingSubmission(userId: number): void {
  awaitingSubmission.delete(userId);
  awaitingTokens.delete(userId);
}
