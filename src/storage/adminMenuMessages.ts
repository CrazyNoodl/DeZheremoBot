interface AdminMenuMessageRef {
  chatId: number;
  messageId: number;
}

const adminMenuMessages = new Map<number, AdminMenuMessageRef>();

export function setAdminMenuMessage(userId: number, chatId: number, messageId: number): void {
  adminMenuMessages.set(userId, { chatId, messageId });
}

export function getAdminMenuMessage(userId: number): AdminMenuMessageRef | undefined {
  return adminMenuMessages.get(userId);
}

export function clearAdminMenuMessage(userId: number): void {
  adminMenuMessages.delete(userId);
}
