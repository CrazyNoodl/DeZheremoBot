interface MenuMessageRef {
  chatId: number; // private chat where the card lives
  messageId: number;
  groupChatId: number; // which group's cycle this card currently represents
}

const menuMessages = new Map<number, MenuMessageRef>();

export function setMenuMessage(userId: number, chatId: number, messageId: number, groupChatId: number): void {
  menuMessages.set(userId, { chatId, messageId, groupChatId });
}

export function getMenuMessage(userId: number): MenuMessageRef | undefined {
  return menuMessages.get(userId);
}

export function clearMenuMessage(userId: number): void {
  menuMessages.delete(userId);
}
