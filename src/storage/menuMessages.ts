import { createPanelMessageStore, type PanelMessageRef } from './panelMessages.js';

export interface MenuMessageRef extends PanelMessageRef {
  groupChatId: number; // which group's cycle this card currently represents
}

const store = createPanelMessageStore<MenuMessageRef>();

export function setMenuMessage(userId: number, chatId: number, messageId: number, groupChatId: number): void {
  store.set(userId, { chatId, messageId, groupChatId });
}

export function getMenuMessage(userId: number): MenuMessageRef | undefined {
  return store.get(userId);
}

export function clearMenuMessage(userId: number): void {
  store.clear(userId);
}
