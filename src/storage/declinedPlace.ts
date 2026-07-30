// Remembers the exact place a user had submitted right before declining ("не йду цього тижня"),
// so cancelling the decline within the same cycle can offer that one place back as a one-tap
// quick-pick instead of forcing a retyped link — see services/submissionService.ts's declinePlace
// (which sets/clears this) and commands/menu.ts's handleDeclineAction/handleResubmitDeclinedAction
// (which read it). Purely in-flight UI convenience, same "cheap to lose" category as
// pendingState.ts/menuMessages.ts: if lost (a restart), the user just types the link again.
const declinedPlaces = new Map<number, Map<number, string>>(); // chatId -> userId -> place

export function rememberDeclinedPlace(chatId: number, userId: number, place: string): void {
  let byUser = declinedPlaces.get(chatId);
  if (!byUser) {
    byUser = new Map();
    declinedPlaces.set(chatId, byUser);
  }
  byUser.set(userId, place);
}

export function getDeclinedPlace(chatId: number, userId: number): string | undefined {
  return declinedPlaces.get(chatId)?.get(userId);
}

export function clearDeclinedPlace(chatId: number, userId: number): void {
  declinedPlaces.get(chatId)?.delete(userId);
}

export function clearDeclinedPlacesForChat(chatId: number): void {
  declinedPlaces.delete(chatId);
}
