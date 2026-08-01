import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  blockUserFromGroup,
  declinePlace,
  getAllSubmissions,
  getDeclinedPlace,
  isGroupPaused,
  isRepeatWinner,
  isSubmissionLocked,
  isUserBlocked,
  isValidPlaceLink,
  listBlockedUsersInGroup,
  lockSubmissions,
  MAX_PLACE_LENGTH,
  pauseGroup,
  pickWeeklyWinner,
  recordDraw,
  resetWeek,
  resumeGroup,
  submitPlace,
  unblockUserFromGroup,
} from './submissionService.js';
import { getHistoricalSubmitters } from '../storage/history.js';

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

test('isValidPlaceLink accepts links with a trailing query string', () => {
  assert.equal(isValidPlaceLink('https://www.instagram.com/franyk.kyiv?igsh=bnhrNzNwenp1ajl0'), true);
  assert.equal(isValidPlaceLink('https://maps.app.goo.gl/uKwFMyv1DMrUtZua8?g_st=ic'), true);
  assert.equal(isValidPlaceLink('https://expz.menu/d0838ea9-b9ae-44dd-b99d-993f0a0206fd?ref=share'), true);
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

test('a blocked user is rejected even though nothing else prevents them from submitting', () => {
  blockUserFromGroup(-9015, 1, 'artem', 999);

  const result = submitPlace(-9015, 1, 'artem', DEZHEROMA_LINK);

  assert.deepEqual(result, { ok: false, reason: 'blocked' });
  assert.equal(isUserBlocked(-9015, 1), true);
});

test('blockUserFromGroup drops the user\'s current-week submission', () => {
  submitPlace(-9016, 1, 'artem', DEZHEROMA_LINK);

  blockUserFromGroup(-9016, 1, 'artem', 999);

  assert.equal(getAllSubmissions(-9016).length, 0);
});

test('unblockUserFromGroup reverses blockUserFromGroup', () => {
  blockUserFromGroup(-9017, 1, 'artem', 999);
  unblockUserFromGroup(-9017, 1);

  const result = submitPlace(-9017, 1, 'artem', DEZHEROMA_LINK);

  assert.equal(result.ok, true);
});

test('listBlockedUsersInGroup returns everyone blocked in that chat', () => {
  blockUserFromGroup(-9018, 1, 'artem', 999);
  blockUserFromGroup(-9018, 2, 'olya', 999);

  const blocked = listBlockedUsersInGroup(-9018);

  assert.equal(blocked.length, 2);
});

test('declinePlace records a decline, and a second decline cancels it back to no response', () => {
  const first = declinePlace(-9019, 1, 'artem');
  assert.deepEqual(first, { ok: true, declined: true, previousPlace: undefined });
  assert.equal(getAllSubmissions(-9019)[0]?.status, 'declined');

  const second = declinePlace(-9019, 1, 'artem');
  assert.deepEqual(second, { ok: true, declined: false });
  assert.equal(getAllSubmissions(-9019).length, 0);
});

test('declinePlace overwrites an existing place submission, and submitPlace overwrites a decline', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });

  submitPlace(-9020, 1, 'artem', DEZHEROMA_LINK);
  const declineResult = declinePlace(-9020, 1, 'artem');
  assert.deepEqual(declineResult, { ok: true, declined: true, previousPlace: DEZHEROMA_LINK });
  assert.equal(getAllSubmissions(-9020)[0]?.status, 'declined');

  t.mock.timers.tick(10_001); // past the resubmit cooldown, otherwise this looks rate_limited
  const result = submitPlace(-9020, 1, 'artem', DEZHEROMA_LINK);
  // Fresh submission (previousPlace undefined), not "updated", since the prior row was a decline,
  // not a real place — text.ts renders these two outcomes with different wording.
  assert.deepEqual(result, { ok: true, previousPlace: undefined });
  assert.equal(getAllSubmissions(-9020)[0]?.status, 'submitted');
});

test('declinePlace is rejected the same way submitPlace is when blocked/paused/locked', () => {
  blockUserFromGroup(-9021, 1, 'artem', 999);
  assert.deepEqual(declinePlace(-9021, 1, 'artem'), { ok: false, reason: 'blocked' });

  pauseGroup(-9022);
  assert.deepEqual(declinePlace(-9022, 1, 'artem'), { ok: false, reason: 'paused' });

  lockSubmissions(-9023);
  assert.deepEqual(declinePlace(-9023, 1, 'artem'), { ok: false, reason: 'locked' });
});

test('pickWeeklyWinner never draws a declined response', () => {
  submitPlace(-9024, 1, 'artem', DEZHEROMA_LINK);
  declinePlace(-9024, 2, 'olya');

  const winner = pickWeeklyWinner(-9024);

  assert.equal(winner?.userId, 1);
});

test('recordDraw does not add a decliner to getHistoricalSubmitters', () => {
  submitPlace(-9025, 1, 'artem', DEZHEROMA_LINK);
  declinePlace(-9025, 2, 'olya');

  recordDraw(-9025, pickWeeklyWinner(-9025));

  const submitters = getHistoricalSubmitters(-9025).map((s) => s.userId);
  assert.deepEqual(submitters, [1]);
});

test('isRepeatWinner is false when the chat has no previous draw', () => {
  submitPlace(-9031, 1, 'artem', DEZHEROMA_LINK);
  const winner = pickWeeklyWinner(-9031);

  assert.equal(isRepeatWinner(-9031, winner), false);
});

test('isRepeatWinner is true when the same place wins two weeks running', () => {
  submitPlace(-9032, 1, 'artem', DEZHEROMA_LINK);
  recordDraw(-9032, pickWeeklyWinner(-9032));
  resetWeek(-9032);

  // A different user proposes the same place the following week — same-user resubmission within
  // the test's own rate-limit window would otherwise be rejected as 'rate_limited', not because of
  // anything isRepeatWinner itself is checking.
  submitPlace(-9032, 2, 'olya', DEZHEROMA_LINK);
  const secondWinner = pickWeeklyWinner(-9032);

  assert.equal(isRepeatWinner(-9032, secondWinner), true);
});

test('isRepeatWinner is false when a different place wins the following week', () => {
  submitPlace(-9033, 1, 'artem', DEZHEROMA_LINK);
  recordDraw(-9033, pickWeeklyWinner(-9033));
  resetWeek(-9033);

  submitPlace(-9033, 2, 'olya', PUZATA_HATA_LINK);
  const secondWinner = pickWeeklyWinner(-9033);

  assert.equal(isRepeatWinner(-9033, secondWinner), false);
});

test('isRepeatWinner is false when there is no winner this week', () => {
  assert.equal(isRepeatWinner(-9034, undefined), false);
});

test('getDeclinedPlace is undefined when the user has never declined', () => {
  assert.equal(getDeclinedPlace(-9026, 1), undefined);
});

test('declinePlace remembers the exact place it retracted, retrievable via getDeclinedPlace', () => {
  submitPlace(-9027, 1, 'artem', FIRST_PLACE_LINK);

  declinePlace(-9027, 1, 'artem');

  assert.equal(getDeclinedPlace(-9027, 1), FIRST_PLACE_LINK);
});

test('getDeclinedPlace is undefined when the decline had nothing to retract', () => {
  declinePlace(-9028, 1, 'artem'); // first-ever response this week is a decline, no prior place

  assert.equal(getDeclinedPlace(-9028, 1), undefined);
});

test('declining again with nothing to retract clears a previously remembered place', () => {
  submitPlace(-9029, 1, 'artem', FIRST_PLACE_LINK);
  declinePlace(-9029, 1, 'artem'); // remembers FIRST_PLACE_LINK
  assert.equal(getDeclinedPlace(-9029, 1), FIRST_PLACE_LINK);

  declinePlace(-9029, 1, 'artem'); // cancels the decline (toggle back to no response)
  declinePlace(-9029, 1, 'artem'); // declines again with nothing submitted in between

  assert.equal(getDeclinedPlace(-9029, 1), undefined);
});

test('resetWeek clears any remembered declined place for that chat', () => {
  submitPlace(-9030, 1, 'artem', FIRST_PLACE_LINK);
  declinePlace(-9030, 1, 'artem');
  assert.equal(getDeclinedPlace(-9030, 1), FIRST_PLACE_LINK);

  resetWeek(-9030);

  assert.equal(getDeclinedPlace(-9030, 1), undefined);
});

test('resetWeek clears submissions and unlocks the chat', () => {
  submitPlace(-9010, 1, 'artem', DEZHEROMA_LINK);
  lockSubmissions(-9010);

  resetWeek(-9010);

  assert.equal(getAllSubmissions(-9010).length, 0);
  assert.equal(isSubmissionLocked(-9010), false);
});
