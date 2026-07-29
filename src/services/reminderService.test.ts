import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordDraw } from '../storage/history.js';
import { addSubmission } from '../storage/store.js';
import { getNonSubmittersInfo } from './reminderService.js';

test('getNonSubmittersInfo lists past submitters who have not submitted this week', () => {
  recordDraw({
    chatId: -6001,
    drawnAt: 1_700_000_000_000,
    winner: undefined,
    submissions: [
      { userId: 1, username: 'artem', place: 'A' },
      { userId: 2, username: 'olya', place: 'B' },
    ],
  });
  addSubmission(-6001, 1, 'artem', 'A');

  // 3 total: the bot + the 2 historical submitters, both accounted for (1 submitted, 1 didn't).
  const { nonSubmitters, unknownCount } = getNonSubmittersInfo(-6001, 3);

  assert.deepEqual(nonSubmitters, [{ userId: 2, username: 'olya' }]);
  assert.equal(unknownCount, 0);
});

test('getNonSubmittersInfo counts group members it has never seen submit as unknown', () => {
  recordDraw({
    chatId: -6002,
    drawnAt: 1_700_000_000_000,
    winner: undefined,
    submissions: [{ userId: 1, username: 'artem', place: 'A' }],
  });

  // 5 total members, bot excluded (-1), only 1 known historical submitter -> 3 unknown.
  const { nonSubmitters, unknownCount } = getNonSubmittersInfo(-6002, 5);

  assert.deepEqual(nonSubmitters, [{ userId: 1, username: 'artem' }]);
  assert.equal(unknownCount, 3);
});

test('getNonSubmittersInfo treats this week\'s first-time submitters as known, not unknown', () => {
  addSubmission(-6003, 1, 'artem', 'A');

  // 2 total members (bot + this first-time submitter) -> nothing unknown, nobody to tag.
  const { nonSubmitters, unknownCount } = getNonSubmittersInfo(-6003, 2);

  assert.deepEqual(nonSubmitters, []);
  assert.equal(unknownCount, 0);
});

test('getNonSubmittersInfo never returns a negative unknownCount', () => {
  recordDraw({
    chatId: -6004,
    drawnAt: 1_700_000_000_000,
    winner: undefined,
    submissions: [
      { userId: 1, username: 'artem', place: 'A' },
      { userId: 2, username: 'olya', place: 'B' },
    ],
  });

  // totalMembers understates reality (e.g. a failed getChatMembersCount fetch defaulting to 0).
  const { unknownCount } = getNonSubmittersInfo(-6004, 0);

  assert.equal(unknownCount, 0);
});
