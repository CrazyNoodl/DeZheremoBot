import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearMenuMessage, getMenuMessage, setMenuMessage } from './menuMessages.js';

test('getMenuMessage returns undefined for a userId never set', () => {
  assert.equal(getMenuMessage(19001), undefined);
});

test('setMenuMessage then getMenuMessage round-trips all four fields', () => {
  setMenuMessage(19002, 999, 1, -19002);

  assert.deepEqual(getMenuMessage(19002), {
    chatId: 999,
    messageId: 1,
    groupChatId: -19002,
  });
});

test('storage is isolated per user', () => {
  setMenuMessage(19003, 1000, 2, -19003);

  assert.equal(getMenuMessage(19004), undefined);
});

test('setMenuMessage again for the same user overwrites the previous ref entirely', () => {
  setMenuMessage(19005, 1001, 3, -19005);
  setMenuMessage(19005, 1002, 4, -19006);

  assert.deepEqual(getMenuMessage(19005), {
    chatId: 1002,
    messageId: 4,
    groupChatId: -19006,
  });
});

test('clearMenuMessage makes getMenuMessage return undefined again', () => {
  setMenuMessage(19006, 1003, 5, -19007);
  clearMenuMessage(19006);

  assert.equal(getMenuMessage(19006), undefined);
});

test('clearMenuMessage on a user never set does not throw', () => {
  assert.doesNotThrow(() => clearMenuMessage(19007));
});
