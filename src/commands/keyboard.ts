import { Markup } from 'telegraf';

export const ADD_BUTTON = '➕ Додати';
export const LIST_BUTTON = '📋 Список';
export const START_ADD_PREFIX = 'add_';
export const START_LIST_PREFIX = 'list_';

export function buildGroupMenu(botUsername: string, chatId: number) {
  return Markup.inlineKeyboard([
    [Markup.button.url(ADD_BUTTON, `https://t.me/${botUsername}?start=${START_ADD_PREFIX}${chatId}`)],
    [Markup.button.url(LIST_BUTTON, `https://t.me/${botUsername}?start=${START_LIST_PREFIX}${chatId}`)],
  ]);
}
