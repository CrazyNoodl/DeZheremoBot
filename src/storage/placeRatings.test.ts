import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addOrUpdateRating, getPlaceRatingSummaries, getTopRaters, markAsAbsent } from './placeRatings.js';
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

test('getPlaceRatingSummaries averages only real stars but still lists an absent vote', () => {
  const chatId = -6010;
  const drawId = drawWithTwoSubmitters(chatId); // winner_place is always 'Дежерьома' here
  addOrUpdateRating(drawId, 1, 4);
  addOrUpdateRating(drawId, 2, 2);
  markAsAbsent(drawId, 3); // never actually submitted this draw — see note below

  const [summary] = getPlaceRatingSummaries(chatId);
  assert.equal(summary.place, 'Дежерьома');
  assert.equal(summary.averageStars, 3); // (4 + 2) / 2, the absent tap excluded
  assert.equal(summary.ratingCount, 2);
  // user 3 never submitted to this draw, so there's no submissions_history row to join their
  // username from — same reason topRatersStmt's join can never see them either, in practice this
  // never happens since the real survey only ever targets that week's actual submitters.
  assert.deepEqual(
    summary.votes.map(({ userId, username, stars }) => ({ userId, username, stars })).sort((a, b) => a.userId - b.userId),
    [
      { userId: 1, username: 'artem', stars: 4 },
      { userId: 2, username: 'olya', stars: 2 },
    ],
  );
  assert.equal(summary.votes.every((v) => typeof v.ratedAt === 'number'), true);
});

test('getPlaceRatingSummaries gives every visit its own vote when a repeat winner is rated more than once', () => {
  const chatId = -6013;
  const firstDrawId = drawIdFor(chatId); // winner_place 'Дежерьома' both times
  markAsAbsent(firstDrawId, 1);
  const secondDrawId = drawIdFor(chatId);
  addOrUpdateRating(secondDrawId, 1, 4);

  const [summary] = getPlaceRatingSummaries(chatId);
  // Two separate visits from the same user, not one row overwriting the other — they're keyed by
  // (draw_id, user_id), and this is two different draw_ids.
  assert.equal(summary.votes.length, 2);
  assert.deepEqual(
    summary.votes.map((v) => v.stars).sort(),
    [4, null].sort(),
  );
  assert.equal(summary.votes.every((v) => v.userId === 1 && v.username === 'artem'), true);
});

test('getPlaceRatingSummaries includes a won-but-never-rated place with a null average and no votes', () => {
  const chatId = -6011;
  drawIdFor(chatId); // winner_place 'Дежерьома', nobody rates it

  assert.deepEqual(getPlaceRatingSummaries(chatId), [{ place: 'Дежерьома', averageStars: null, ratingCount: 0, votes: [] }]);
});

test('getPlaceRatingSummaries sorts by average rating descending, unrated places last', () => {
  const chatId = -6012;
  const lowDrawId = (() => {
    recordDraw({
      chatId,
      drawnAt: 1_700_000_000_000,
      winner: { userId: 1, username: 'artem', place: 'Low place' },
      submissions: [{ userId: 1, username: 'artem', place: 'Low place' }],
    });
    return db.prepare('SELECT id FROM weekly_draws WHERE chat_id = ? ORDER BY id DESC LIMIT 1').get(chatId)!.id as number;
  })();
  addOrUpdateRating(lowDrawId, 1, 2);

  const highDrawId = (() => {
    recordDraw({
      chatId,
      drawnAt: 1_700_000_000_000,
      winner: { userId: 1, username: 'artem', place: 'High place' },
      submissions: [{ userId: 1, username: 'artem', place: 'High place' }],
    });
    return db.prepare('SELECT id FROM weekly_draws WHERE chat_id = ? ORDER BY id DESC LIMIT 1').get(chatId)!.id as number;
  })();
  addOrUpdateRating(highDrawId, 1, 5);

  recordDraw({
    chatId,
    drawnAt: 1_700_000_000_000,
    winner: { userId: 1, username: 'artem', place: 'Unrated place' },
    submissions: [{ userId: 1, username: 'artem', place: 'Unrated place' }],
  });

  assert.deepEqual(
    getPlaceRatingSummaries(chatId).map((s) => s.place),
    ['High place', 'Low place', 'Unrated place'],
  );
});
