import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addOrUpdateRating, getTopRaters, markAsAbsent } from './placeRatings.js';
import { db, recordDraw } from './history.js';

function drawIdFor(chatId: number): number {
  recordDraw({
    chatId,
    drawnAt: 1_700_000_000_000,
    winner: { userId: 1, username: 'artem', place: 'Дежерьома' },
    submissions: [{ userId: 1, username: 'artem', place: 'Дежерьома' }],
  });
  return db.prepare('SELECT id FROM weekly_draws WHERE chat_id = ? ORDER BY id DESC LIMIT 1').get(chatId)!.id as number;
}

test('addOrUpdateRating stores a new rating', () => {
  const drawId = drawIdFor(-6001);
  addOrUpdateRating(drawId, 42, 5);

  const row = db.prepare('SELECT stars FROM place_ratings WHERE draw_id = ? AND user_id = ?').get(drawId, 42);
  assert.equal(row?.stars, 5);
});

test('addOrUpdateRating upserts on a second tap instead of erroring', () => {
  const drawId = drawIdFor(-6002);
  addOrUpdateRating(drawId, 42, 2);
  addOrUpdateRating(drawId, 42, 4);

  const rows = db.prepare('SELECT stars FROM place_ratings WHERE draw_id = ? AND user_id = ?').all(drawId, 42);
  assert.equal(rows.length, 1); // still one row, not two
  assert.equal(rows[0].stars, 4);
});

test('addOrUpdateRating keeps ratings for different users on the same draw separate', () => {
  const drawId = drawIdFor(-6003);
  addOrUpdateRating(drawId, 1, 3);
  addOrUpdateRating(drawId, 2, 5);

  const rows = (db.prepare('SELECT user_id AS userId, stars FROM place_ratings WHERE draw_id = ?').all(drawId) as {
    userId: number;
    stars: number;
  }[]).map((row) => ({ ...row })); // node:sqlite rows are null-prototype — spread before deepEqual
  assert.deepEqual(
    rows.sort((a, b) => a.userId - b.userId),
    [
      { userId: 1, stars: 3 },
      { userId: 2, stars: 5 },
    ],
  );
});

test('markAsAbsent stores a NULL-stars row', () => {
  const drawId = drawIdFor(-6004);
  markAsAbsent(drawId, 42);

  const row = db.prepare('SELECT stars FROM place_ratings WHERE draw_id = ? AND user_id = ?').get(drawId, 42);
  assert.equal(row?.stars, null);
});

test('markAsAbsent overwrites a previously given star rating (upsert, same as changing stars)', () => {
  const drawId = drawIdFor(-6005);
  addOrUpdateRating(drawId, 42, 4);
  markAsAbsent(drawId, 42);

  const rows = db.prepare('SELECT stars FROM place_ratings WHERE draw_id = ? AND user_id = ?').all(drawId, 42);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stars, null);
});

test('addOrUpdateRating overwrites a previous "absent" mark back to a real rating', () => {
  const drawId = drawIdFor(-6006);
  markAsAbsent(drawId, 42);
  addOrUpdateRating(drawId, 42, 5);

  const row = db.prepare('SELECT stars FROM place_ratings WHERE draw_id = ? AND user_id = ?').get(drawId, 42);
  assert.equal(row?.stars, 5);
});

function drawWithTwoSubmitters(chatId: number): number {
  recordDraw({
    chatId,
    drawnAt: 1_700_000_000_000,
    winner: { userId: 1, username: 'artem', place: 'Дежерьома' },
    submissions: [
      { userId: 1, username: 'artem', place: 'Дежерьома' },
      { userId: 2, username: 'olya', place: 'Пузата хата' },
    ],
  });
  return db.prepare('SELECT id FROM weekly_draws WHERE chat_id = ? ORDER BY id DESC LIMIT 1').get(chatId)!.id as number;
}

test('getTopRaters ranks submitters by how many star ratings they have given, most first', () => {
  const chatId = -6007;
  const drawA = drawWithTwoSubmitters(chatId);
  const drawB = drawWithTwoSubmitters(chatId);
  addOrUpdateRating(drawA, 1, 5);
  addOrUpdateRating(drawB, 1, 4);
  addOrUpdateRating(drawA, 2, 3);

  assert.deepEqual(
    getTopRaters(chatId).map((r) => ({ ...r })),
    [
      { userId: 1, username: 'artem', ratings: 2 },
      { userId: 2, username: 'olya', ratings: 1 },
    ],
  );
});

test('getTopRaters excludes "🙅 Мене не було" (NULL-stars) taps and is isolated per chat', () => {
  const chatId = -6008;
  const drawId = drawWithTwoSubmitters(chatId);
  addOrUpdateRating(drawId, 1, 5);
  markAsAbsent(drawId, 2);

  assert.deepEqual(
    getTopRaters(chatId).map((r) => ({ ...r })),
    [{ userId: 1, username: 'artem', ratings: 1 }],
  );
  assert.deepEqual(getTopRaters(-6009), []);
});
