import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearDrawPlaceOverride, getDrawPlaceOverride, setDrawPlaceOverride } from './drawPlaceOverride.js';
import { db, recordDraw } from './history.js';

function drawIdFor(chatId: number): number {
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

test('getDrawPlaceOverride returns undefined when nothing was ever set', () => {
  const drawId = drawIdFor(-7001);
  assert.equal(getDrawPlaceOverride(drawId), undefined);
});

test('setDrawPlaceOverride stores a place plus who it came from and who set it', () => {
  const drawId = drawIdFor(-7002);
  setDrawPlaceOverride(drawId, 'Пузата хата', 2, 999);

  assert.deepEqual(getDrawPlaceOverride(drawId), { place: 'Пузата хата', submitterUserId: 2 });
});

test('setDrawPlaceOverride upserts on a second call instead of erroring on the PRIMARY KEY', () => {
  const drawId = drawIdFor(-7003);
  setDrawPlaceOverride(drawId, 'Пузата хата', 2, 999);
  setDrawPlaceOverride(drawId, 'Дежерьома', 1, 999);

  assert.deepEqual(getDrawPlaceOverride(drawId), { place: 'Дежерьома', submitterUserId: 1 });
});

test('setDrawPlaceOverride accepts an undefined submitterUserId as a stored NULL', () => {
  const drawId = drawIdFor(-7004);
  setDrawPlaceOverride(drawId, 'Пузата хата', undefined, 999);

  assert.deepEqual(getDrawPlaceOverride(drawId), { place: 'Пузата хата', submitterUserId: null });
});

test('clearDrawPlaceOverride removes the row, and is a harmless no-op when nothing was set', () => {
  const drawId = drawIdFor(-7005);
  setDrawPlaceOverride(drawId, 'Пузата хата', 2, 999);
  clearDrawPlaceOverride(drawId);
  assert.equal(getDrawPlaceOverride(drawId), undefined);

  clearDrawPlaceOverride(drawId); // already cleared — must not throw
  assert.equal(getDrawPlaceOverride(drawId), undefined);
});

test('overrides on different draws are independent', () => {
  const drawA = drawIdFor(-7006);
  const drawB = drawIdFor(-7006);
  setDrawPlaceOverride(drawA, 'Пузата хата', 2, 999);

  assert.deepEqual(getDrawPlaceOverride(drawA), { place: 'Пузата хата', submitterUserId: 2 });
  assert.equal(getDrawPlaceOverride(drawB), undefined);
});
