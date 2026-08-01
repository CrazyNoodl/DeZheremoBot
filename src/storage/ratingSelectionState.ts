// Purely in-flight UI state for /admin's manual rating-survey send screen — same in-memory,
// no-TTL-needed simplicity as scheduleEditState.ts, since re-opening the screen always reseeds a
// fresh Set (see commands/admin.ts's "rating" action) rather than resuming a stale one.
export interface RatingSelectionState {
  chatId: number;
  selected: Set<number>;
}

const selections = new Map<number, RatingSelectionState>();

export function setRatingSelection(adminUserId: number, state: RatingSelectionState): void {
  selections.set(adminUserId, state);
}

export function getRatingSelection(adminUserId: number): RatingSelectionState | undefined {
  return selections.get(adminUserId);
}

export function clearRatingSelection(adminUserId: number): void {
  selections.delete(adminUserId);
}
