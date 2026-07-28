import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getAllSubmissions,
  isGroupPaused,
  isSubmissionLocked,
  lockSubmissions,
  MAX_PLACE_LENGTH,
  pauseGroup,
  pickWeeklyWinner,
  resetWeek,
  resumeGroup,
  submitPlace,
} from './submissionService.js';

test('a fresh submission succeeds with no previousPlace', () => {
  const result = submitPlace(-9001, 1, 'artem', 'Дежерьома');

  assert.deepEqual(result, { ok: true, previousPlace: undefined });
  assert.equal(getAllSubmissions(-9001)[0]?.place, 'Дежерьома');
});

test('a locked chat rejects any submission', () => {
  lockSubmissions(-9002);

  const result = submitPlace(-9002, 1, 'artem', 'Дежерьома');

  assert.deepEqual(result, { ok: false, reason: 'locked' });
  assert.equal(isSubmissionLocked(-9002), true);
});

test('a place longer than MAX_PLACE_LENGTH is rejected as too_long', () => {
  const tooLong = 'a'.repeat(MAX_PLACE_LENGTH + 1);

  const result = submitPlace(-9003, 1, 'artem', tooLong);

  assert.deepEqual(result, { ok: false, reason: 'too_long' });
});

test('a place at exactly MAX_PLACE_LENGTH is accepted', () => {
  const exactly = 'a'.repeat(MAX_PLACE_LENGTH);

  const result = submitPlace(-9004, 1, 'artem', exactly);

  assert.equal(result.ok, true);
});

test('resubmitting the exact same place is rejected as duplicate, not rate-limited', () => {
  submitPlace(-9005, 1, 'artem', 'Дежерьома');

  const result = submitPlace(-9005, 1, 'artem', 'Дежерьома');

  assert.deepEqual(result, { ok: false, reason: 'duplicate' });
});

test('changing to a different place twice within the cooldown is rate_limited', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });

  submitPlace(-9006, 1, 'artem', 'First place');
  const result = submitPlace(-9006, 1, 'artem', 'Second place');

  assert.deepEqual(result, { ok: false, reason: 'rate_limited' });
  // the rejected change must not have overwritten the stored submission
  assert.equal(getAllSubmissions(-9006)[0]?.place, 'First place');
});

test('changing to a different place after the cooldown elapses succeeds', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });

  submitPlace(-9007, 1, 'artem', 'First place');
  t.mock.timers.tick(10_001);
  const result = submitPlace(-9007, 1, 'artem', 'Second place');

  assert.deepEqual(result, { ok: true, previousPlace: 'First place' });
  assert.equal(getAllSubmissions(-9007)[0]?.place, 'Second place');
});

test('pickWeeklyWinner returns undefined when nobody submitted', () => {
  assert.equal(pickWeeklyWinner(-9008), undefined);
});

test('pickWeeklyWinner returns one of the submitted places', () => {
  submitPlace(-9009, 1, 'artem', 'Дежерьома');
  submitPlace(-9009, 2, 'olya', 'Пузата хата');

  const winner = pickWeeklyWinner(-9009);

  assert.ok(winner);
  assert.ok(['Дежерьома', 'Пузата хата'].includes(winner.place));
});

test('a paused chat rejects any submission', () => {
  pauseGroup(-9011);

  const result = submitPlace(-9011, 1, 'artem', 'Дежерьома');

  assert.deepEqual(result, { ok: false, reason: 'paused' });
  assert.equal(isGroupPaused(-9011), true);
});

test('resumeGroup reverses pauseGroup', () => {
  pauseGroup(-9012);
  resumeGroup(-9012);

  const result = submitPlace(-9012, 1, 'artem', 'Дежерьома');

  assert.equal(result.ok, true);
});

test('a paused chat is checked ahead of the lock check, but the lock is untouched by pausing', () => {
  pauseGroup(-9013);

  assert.deepEqual(submitPlace(-9013, 1, 'artem', 'Дежерьома'), { ok: false, reason: 'paused' });
  assert.equal(isSubmissionLocked(-9013), false);
});

test('resetWeek clears submissions and unlocks the chat', () => {
  submitPlace(-9010, 1, 'artem', 'Дежерьома');
  lockSubmissions(-9010);

  resetWeek(-9010);

  assert.equal(getAllSubmissions(-9010).length, 0);
  assert.equal(isSubmissionLocked(-9010), false);
});
