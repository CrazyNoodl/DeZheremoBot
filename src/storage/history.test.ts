import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getHistoricalSubmitters, recordDraw } from './history.js';

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

test('getHistoricalSubmitters returns everyone who has ever submitted in that chat, deduplicated', () => {
  recordDraw({
    chatId: -5003,
    drawnAt: 1_700_000_000_000,
    winner: { userId: 1, username: 'artem', place: 'Дежерьома' },
    submissions: [
      { userId: 1, username: 'artem', place: 'Дежерьома' },
      { userId: 2, username: 'olya', place: 'Пузата хата' },
    ],
  });
  recordDraw({
    chatId: -5003,
    drawnAt: 1_700_000_100_000,
    winner: { userId: 2, username: 'olya', place: 'Пузата хата' },
    submissions: [{ userId: 2, username: 'olya', place: 'Пузата хата' }],
  });

  const submitters = getHistoricalSubmitters(-5003).sort((a, b) => a.userId - b.userId);
  assert.deepEqual(submitters, [
    { userId: 1, username: 'artem' },
    { userId: 2, username: 'olya' },
  ]);
});

test('getHistoricalSubmitters returns the most recent username for a user who changed it', () => {
  recordDraw({
    chatId: -5004,
    drawnAt: 1_700_000_000_000,
    winner: undefined,
    submissions: [{ userId: 1, username: 'old_name', place: 'A' }],
  });
  recordDraw({
    chatId: -5004,
    drawnAt: 1_700_000_100_000,
    winner: undefined,
    submissions: [{ userId: 1, username: 'new_name', place: 'B' }],
  });

  assert.deepEqual([...getHistoricalSubmitters(-5004)], [{ userId: 1, username: 'new_name' }]);
});

test('getHistoricalSubmitters is isolated per chat', () => {
  recordDraw({
    chatId: -5005,
    drawnAt: 1_700_000_000_000,
    winner: undefined,
    submissions: [{ userId: 9, username: 'someone', place: 'A' }],
  });

  assert.deepEqual(getHistoricalSubmitters(-5006), []);
});
