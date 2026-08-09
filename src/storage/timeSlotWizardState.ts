// Purely in-flight UI state for the private-chat day/hour availability picker (commands/
// timeSlotPoll.ts) — same in-memory, no-TTL-needed simplicity as ratingSelectionState.ts: this
// flow never reads free text (pure callback buttons), so unlike scheduleEditState.ts there's no
// risk of a later text message being misread as a reply to an abandoned wizard. Reopening the
// picker (via the personal menu's "🗓 Моя доступність" button) always reseeds from the persisted
// response (storage/timeSlotResponses.ts) or fresh/empty if none, rather than resuming this.
export interface TimeSlotWizardState {
  groupChatId: number;
  step: 'days' | 'times';
  selectedDays: Set<number>;
  daysAny: boolean;
  selectedTimes: Set<string>;
  timesAny: boolean;
}

const wizardStates = new Map<number, TimeSlotWizardState>();

export function setTimeSlotWizardState(userId: number, state: TimeSlotWizardState): void {
  wizardStates.set(userId, state);
}

export function getTimeSlotWizardState(userId: number): TimeSlotWizardState | undefined {
  return wizardStates.get(userId);
}

export function clearTimeSlotWizardState(userId: number): void {
  wizardStates.delete(userId);
}
