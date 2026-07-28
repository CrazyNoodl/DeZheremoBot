interface ScheduleMenuMessageRef {
  chatId: number;
  messageId: number;
}

const scheduleMenuMessages = new Map<number, ScheduleMenuMessageRef>();

export function setScheduleMenuMessage(userId: number, chatId: number, messageId: number): void {
  scheduleMenuMessages.set(userId, { chatId, messageId });
}

export function getScheduleMenuMessage(userId: number): ScheduleMenuMessageRef | undefined {
  return scheduleMenuMessages.get(userId);
}

export function clearScheduleMenuMessage(userId: number): void {
  scheduleMenuMessages.delete(userId);
}
