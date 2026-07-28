import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getAllSubmissions,
  isGroupPaused,
  isSubmissionLocked,
  isValidPlaceLink,
  lockSubmissions,
  MAX_PLACE_LENGTH,
  pauseGroup,
  pickWeeklyWinner,
  resetWeek,
  resumeGroup,
  submitPlace,
} from './submissionService.js';

const DEZHEROMA_LINK = 'https://www.instagram.com/dezheroma';
const PUZATA_HATA_LINK = 'https://www.instagram.com/puzatahata';
const FIRST_PLACE_LINK = 'https://www.instagram.com/firstplace';
const SECOND_PLACE_LINK = 'https://www.instagram.com/secondplace';

test('a fresh submission succeeds with no previousPlace', () => {
  const result = submitPlace(-9001, 1, 'artem', DEZHEROMA_LINK);

  assert.deepEqual(result, { ok: true, previousPlace: undefined });
  assert.equal(getAllSubmissions(-9001)[0]?.place, DEZHEROMA_LINK);
});

test('a locked chat rejects any submission', () => {
  lockSubmissions(-9002);

  const result = submitPlace(-9002, 1, 'artem', DEZHEROMA_LINK);

  assert.deepEqual(result, { ok: false, reason: 'locked' });
  assert.equal(isSubmissionLocked(-9002), true);
});

test('a place longer than MAX_PLACE_LENGTH is rejected as too_long', () => {
  const tooLong = 'a'.repeat(MAX_PLACE_LENGTH + 1);

  const result = submitPlace(-9003, 1, 'artem', tooLong);

  assert.deepEqual(result, { ok: false, reason: 'too_long' });
});

test('a valid link at exactly MAX_PLACE_LENGTH is accepted', () => {
  const prefix = 'https://www.instagram.com/';
  const exactly = prefix + 'a'.repeat(MAX_PLACE_LENGTH - prefix.length);
  assert.equal(exactly.length, MAX_PLACE_LENGTH);

  const result = submitPlace(-9004, 1, 'artem', exactly);

  assert.equal(result.ok, true);
});

test('isValidPlaceLink accepts expz.menu, maps.app.goo.gl, and instagram.com links', () => {
  assert.equal(isValidPlaceLink('https://expz.menu/d0838ea9-b9ae-44dd-b99d-993f0a0206fd'), true);
  assert.equal(isValidPlaceLink('https://maps.app.goo.gl/uKwFMyv1DMrUtZua8'), true);
  assert.equal(isValidPlaceLink('https://www.instagram.com/milkbarkyiv'), true);
  assert.equal(isValidPlaceLink('https://instagram.com/milkbarkyiv'), true);
});

test('isValidPlaceLink rejects plain text and unsupported domains', () => {
  assert.equal(isValidPlaceLink('Дежерьома'), false);
  assert.equal(isValidPlaceLink('https://example.com/somewhere'), false);
  assert.equal(isValidPlaceLink('https://www.google.com/maps/place/Foo'), false);
});

test('a place that is not a recognized link is rejected as invalid_format', () => {
  const result = submitPlace(-9014, 1, 'artem', 'Дежерьома');

  assert.deepEqual(result, { ok: false, reason: 'invalid_format' });
});

test('resubmitting the exact same place is rejected as duplicate, not rate-limited', () => {
  submitPlace(-9005, 1, 'artem', DEZHEROMA_LINK);

  const result = submitPlace(-9005, 1, 'artem', DEZHEROMA_LINK);

  assert.deepEqual(result, { ok: false, reason: 'duplicate' });
});

test('changing to a different place twice within the cooldown is rate_limited', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });

  submitPlace(-9006, 1, 'artem', FIRST_PLACE_LINK);
  const result = submitPlace(-9006, 1, 'artem', SECOND_PLACE_LINK);

  assert.deepEqual(result, { ok: false, reason: 'rate_limited' });
  // the rejected change must not have overwritten the stored submission
  assert.equal(getAllSubmissions(-9006)[0]?.place, FIRST_PLACE_LINK);
});

test('changing to a different place after the cooldown elapses succeeds', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });

  submitPlace(-9007, 1, 'artem', FIRST_PLACE_LINK);
  t.mock.timers.tick(10_001);
  const result = submitPlace(-9007, 1, 'artem', SECOND_PLACE_LINK);

  assert.deepEqual(result, { ok: true, previousPlace: FIRST_PLACE_LINK });
  assert.equal(getAllSubmissions(-9007)[0]?.place, SECOND_PLACE_LINK);
});

test('pickWeeklyWinner returns undefined when nobody submitted', () => {
  assert.equal(pickWeeklyWinner(-9008), undefined);
});

test('pickWeeklyWinner returns one of the submitted places', () => {
  submitPlace(-9009, 1, 'artem', DEZHEROMA_LINK);
  submitPlace(-9009, 2, 'olya', PUZATA_HATA_LINK);

  const winner = pickWeeklyWinner(-9009);

  assert.ok(winner);
  assert.ok([DEZHEROMA_LINK, PUZATA_HATA_LINK].includes(winner.place));
});

test('a paused chat rejects any submission', () => {
  pauseGroup(-9011);

  const result = submitPlace(-9011, 1, 'artem', DEZHEROMA_LINK);

  assert.deepEqual(result, { ok: false, reason: 'paused' });
  assert.equal(isGroupPaused(-9011), true);
});

test('resumeGroup reverses pauseGroup', () => {
  pauseGroup(-9012);
  resumeGroup(-9012);

  const result = submitPlace(-9012, 1, 'artem', DEZHEROMA_LINK);

  assert.equal(result.ok, true);
});

test('a paused chat is checked ahead of the lock check, but the lock is untouched by pausing', () => {
  pauseGroup(-9013);

  assert.deepEqual(submitPlace(-9013, 1, 'artem', DEZHEROMA_LINK), { ok: false, reason: 'paused' });
  assert.equal(isSubmissionLocked(-9013), false);
});

test('resetWeek clears submissions and unlocks the chat', () => {
  submitPlace(-9010, 1, 'artem', DEZHEROMA_LINK);
  lockSubmissions(-9010);

  resetWeek(-9010);

  assert.equal(getAllSubmissions(-9010).length, 0);
  assert.equal(isSubmissionLocked(-9010), false);
});
