export type ScheduleEditState =
  | { flow: 'reminder'; step: 'weekdays'; chatId: number; selected: Set<number> }
  | { flow: 'reminder'; step: 'time'; chatId: number; weekdays: number[] }
  | { flow: 'deadline'; step: 'weekday'; chatId: number }
  | { flow: 'deadline'; step: 'lockTime'; chatId: number; weekday: number }
  | { flow: 'deadline'; step: 'drawTime'; chatId: number; weekday: number; lockTime: string };

const editStates = new Map<number, ScheduleEditState>();

export function setScheduleEditState(userId: number, state: ScheduleEditState): void {
  editStates.set(userId, state);
}

export function getScheduleEditState(userId: number): ScheduleEditState | undefined {
  return editStates.get(userId);
}

export function clearScheduleEditState(userId: number): void {
  editStates.delete(userId);
}
