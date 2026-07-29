import { Markup } from 'telegraf';

export const ADD_BUTTON = '➕ Додати';
export const LIST_BUTTON = '📋 Список';
export const DECLINE_GROUP_BUTTON = '🙅 Не йду';
export const START_ADD_PREFIX = 'add_';
export const START_LIST_PREFIX = 'list_';
// Declining needs no free text (unlike adding a place), so it can be a direct callback button
// right here in the group message instead of routing through the private-chat add/list deep-link
// dance — one tap, no navigation.
export const DECLINE_GROUP_ACTION = 'decline_group';

export function buildGroupMenu(botUsername: string, chatId: number) {
  return Markup.inlineKeyboard([
    [Markup.button.url(ADD_BUTTON, `https://t.me/${botUsername}?start=${START_ADD_PREFIX}${chatId}`)],
    [Markup.button.url(LIST_BUTTON, `https://t.me/${botUsername}?start=${START_LIST_PREFIX}${chatId}`)],
    [Markup.button.callback(DECLINE_GROUP_BUTTON, DECLINE_GROUP_ACTION)],
  ]);
}
