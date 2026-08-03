import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getHistoricalSubmitters,
  getLatestDraw,
  getSubmissionsForDraw,
  getTopParticipants,
  getTopWinningPlaces,
  recordDraw,
} from './history.js';

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

test('getLatestDraw returns undefined for a chat with no draws yet', () => {
  assert.equal(getLatestDraw(-5007), undefined);
});

test('getLatestDraw returns the most recent draw for that chat', () => {
  recordDraw({
    chatId: -5008,
    drawnAt: 1_700_000_000_000,
    winner: { userId: 1, username: 'artem', place: 'Дежерьома' },
    submissions: [{ userId: 1, username: 'artem', place: 'Дежерьома' }],
  });
  recordDraw({
    chatId: -5008,
    drawnAt: 1_700_000_100_000,
    winner: { userId: 2, username: 'olya', place: 'Пузата хата' },
    submissions: [{ userId: 2, username: 'olya', place: 'Пузата хата' }],
  });

  const latest = getLatestDraw(-5008);
  assert.equal(latest?.drawnAt, 1_700_000_100_000);
  assert.equal(latest?.winnerPlace, 'Пузата хата');
});

test('getLatestDraw returns a null winnerPlace when nobody submitted that week', () => {
  recordDraw({ chatId: -5009, drawnAt: 1_700_000_000_000, winner: undefined, submissions: [] });

  assert.equal(getLatestDraw(-5009)?.winnerPlace, null);
});

test('getSubmissionsForDraw returns every submitter for that specific draw, winner included', () => {
  recordDraw({
    chatId: -5010,
    drawnAt: 1_700_000_000_000,
    winner: { userId: 1, username: 'artem', place: 'Дежерьома' },
    submissions: [
      { userId: 1, username: 'artem', place: 'Дежерьома' },
      { userId: 2, username: 'olya', place: 'Пузата хата' },
    ],
  });
  const drawId = getLatestDraw(-5010)!.id;

  // node:sqlite rows are null-prototype — spread before deepEqual (deepEqual is deepStrictEqual,
  // which also compares prototypes).
  const submitters = getSubmissionsForDraw(drawId)
    .map((row) => ({ ...row }))
    .sort((a, b) => a.userId - b.userId);
  assert.deepEqual(submitters, [
    { userId: 1, username: 'artem', place: 'Дежерьома' },
    { userId: 2, username: 'olya', place: 'Пузата хата' },
  ]);
});

test('getTopWinningPlaces ranks places by how many times each has won, most first', () => {
  recordDraw({
    chatId: -5011,
    drawnAt: 1_700_000_000_000,
    winner: { userId: 1, username: 'artem', place: 'Дежерьома' },
    submissions: [{ userId: 1, username: 'artem', place: 'Дежерьома' }],
  });
  recordDraw({
    chatId: -5011,
    drawnAt: 1_700_000_100_000,
    winner: { userId: 1, username: 'artem', place: 'Дежерьома' },
    submissions: [{ userId: 1, username: 'artem', place: 'Дежерьома' }],
  });
  recordDraw({
    chatId: -5011,
    drawnAt: 1_700_000_200_000,
    winner: { userId: 2, username: 'olya', place: 'Пузата хата' },
    submissions: [{ userId: 2, username: 'olya', place: 'Пузата хата' }],
  });

  assert.deepEqual(
    getTopWinningPlaces(-5011).map((p) => ({ ...p })),
    [
      { place: 'Дежерьома', wins: 2 },
      { place: 'Пузата хата', wins: 1 },
    ],
  );
});

test('getTopWinningPlaces excludes draws with no winner and is isolated per chat', () => {
  recordDraw({ chatId: -5012, drawnAt: 1_700_000_000_000, winner: undefined, submissions: [] });

  assert.deepEqual(getTopWinningPlaces(-5012), []);
});

test('getTopParticipants ranks submitters by how many times they submitted, most first', () => {
  recordDraw({
    chatId: -5013,
    drawnAt: 1_700_000_000_000,
    winner: { userId: 1, username: 'artem', place: 'A' },
    submissions: [
      { userId: 1, username: 'artem', place: 'A' },
      { userId: 2, username: 'olya', place: 'B' },
    ],
  });
  recordDraw({
    chatId: -5013,
    drawnAt: 1_700_000_100_000,
    winner: { userId: 1, username: 'artem', place: 'A' },
    submissions: [{ userId: 1, username: 'artem', place: 'A' }],
  });

  assert.deepEqual(
    getTopParticipants(-5013).map((p) => ({ ...p })),
    [
      { userId: 1, username: 'artem', submissions: 2 },
      { userId: 2, username: 'olya', submissions: 1 },
    ],
  );
});

test('getTopParticipants shows a renamed user\'s most recent username, same MAX(id) trick as getHistoricalSubmitters', () => {
  recordDraw({
    chatId: -5015,
    drawnAt: 1_700_000_000_000,
    winner: undefined,
    submissions: [{ userId: 1, username: 'old_name', place: 'A' }],
  });
  recordDraw({
    chatId: -5015,
    drawnAt: 1_700_000_100_000,
    winner: undefined,
    submissions: [{ userId: 1, username: 'new_name', place: 'B' }],
  });

  assert.deepEqual(
    getTopParticipants(-5015).map((p) => ({ ...p })),
    [{ userId: 1, username: 'new_name', submissions: 2 }],
  );
});

test('getTopParticipants is empty for a chat with no recorded draws', () => {
  assert.deepEqual(getTopParticipants(-5014), []);
});
