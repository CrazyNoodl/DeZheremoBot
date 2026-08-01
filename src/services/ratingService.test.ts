import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getRatingSurveyContext } from './ratingService.js';
import { blockUserFromGroup } from './submissionService.js';
import { recordDraw } from '../storage/history.js';

test('getRatingSurveyContext returns undefined when there is no draw yet', () => {
  assert.equal(getRatingSurveyContext(-10001), undefined);
});

test('getRatingSurveyContext returns undefined when the latest draw had no winner', () => {
  recordDraw({ chatId: -10002, drawnAt: 1_700_000_000_000, winner: undefined, submissions: [] });

  assert.equal(getRatingSurveyContext(-10002), undefined);
});

test('getRatingSurveyContext returns every submitter when nobody is blocked', () => {
  recordDraw({
    chatId: -10003,
    drawnAt: 1_700_000_000_000,
    winner: { userId: 1, username: 'artem', place: 'Дежерьома' },
    submissions: [
      { userId: 1, username: 'artem', place: 'Дежерьома' },
      { userId: 2, username: 'olya', place: 'Дежерьома' },
    ],
  });

  const context = getRatingSurveyContext(-10003)!;
  assert.equal(context.winnerPlace, 'Дежерьома');
  assert.deepEqual(
    context.recipients.map((r) => r.userId).sort(),
    [1, 2],
  );
});

test('getRatingSurveyContext excludes a submitter who was blocked after submitting to that draw', () => {
  const chatId = -10004;
  recordDraw({
    chatId,
    drawnAt: 1_700_000_000_000,
    winner: { userId: 1, username: 'artem', place: 'Дежерьома' },
    submissions: [
      { userId: 1, username: 'artem', place: 'Дежерьома' },
      { userId: 2, username: 'olya', place: 'Дежерьома' },
    ],
  });

  // Blocking never edits submissions_history — only a since-added filter can keep a blocked
  // submitter out of the rating-survey recipient list.
  blockUserFromGroup(chatId, 2, 'olya', 999);

  const context = getRatingSurveyContext(chatId)!;
  assert.deepEqual(
    context.recipients.map((r) => r.userId),
    [1],
  );
});
