const awaitingSubmission = new Map<number, number>(); // userId -> which group chat this submission is for

export function markAwaitingSubmission(userId: number, chatId: number): void {
  awaitingSubmission.set(userId, chatId);
}

export function getAwaitingChatId(userId: number): number | undefined {
  return awaitingSubmission.get(userId);
}

export function clearAwaitingSubmission(userId: number): void {
  awaitingSubmission.delete(userId);
}
