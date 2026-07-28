import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordDraw } from './history.js';

test('recordDraw does not throw when there is a winner', () => {
  assert.doesNotThrow(() =>
    recordDraw({
      chatId: -5001,
      drawnAt: 1_700_000_000_000,
      winner: { userId: 1, username: 'artem', place: 'Дежерьома' },
      submissions: [
        { userId: 1, username: 'artem', place: 'Дежерьома' },
        { userId: 2, username: 'olya', place: 'Пузата хата' },
      ],
    }),
  );
});

test('recordDraw does not throw when nobody submitted', () => {
  assert.doesNotThrow(() =>
    recordDraw({
      chatId: -5002,
      drawnAt: 1_700_000_000_000,
      winner: undefined,
      submissions: [],
    }),
  );
});
