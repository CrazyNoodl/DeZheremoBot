import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearSurveyPlaceOverride,
  getRatingSurveyContext,
  getSurveyPlaceOverride,
  isRatingSurveyEnabled,
  setRatingSurveyEnabled,
  setSurveyPlaceOverride,
} from './ratingService.js';
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

test('a chat is rating-survey-enabled by default, and setRatingSurveyEnabled toggles it', () => {
  const chatId = -10005;
  assert.equal(isRatingSurveyEnabled(chatId), true);

  setRatingSurveyEnabled(chatId, false);
  assert.equal(isRatingSurveyEnabled(chatId), false);

  setRatingSurveyEnabled(chatId, true);
  assert.equal(isRatingSurveyEnabled(chatId), true);
});

test('setSurveyPlaceOverride redirects getRatingSurveyContext to the overridden place, not the draw winner', () => {
  const chatId = -10006;
  recordDraw({
    chatId,
    drawnAt: 1_700_000_000_000,
    winner: { userId: 1, username: 'artem', place: 'Дежерьома' },
    submissions: [
      { userId: 1, username: 'artem', place: 'Дежерьома' },
      { userId: 2, username: 'olya', place: 'Пузата хата' },
    ],
  });

  const result = setSurveyPlaceOverride(chatId, 2, 999);
  assert.equal(result.ok, true);

  assert.equal(getRatingSurveyContext(chatId)?.winnerPlace, 'Пузата хата');
  assert.deepEqual(getSurveyPlaceOverride(chatId), { place: 'Пузата хата', submitterUserId: 2 });
});

test('setSurveyPlaceOverride rejects a submitterUserId that never submitted to the latest draw', () => {
  const chatId = -10007;
  recordDraw({
    chatId,
    drawnAt: 1_700_000_000_000,
    winner: { userId: 1, username: 'artem', place: 'Дежерьома' },
    submissions: [{ userId: 1, username: 'artem', place: 'Дежерьома' }],
  });

  const result = setSurveyPlaceOverride(chatId, 999, 1);
  assert.deepEqual(result, { ok: false, reason: 'invalid_submitter' });
  assert.equal(getRatingSurveyContext(chatId)?.winnerPlace, 'Дежерьома'); // unchanged
});

test('setSurveyPlaceOverride rejects a chat with no draw at all yet', () => {
  const result = setSurveyPlaceOverride(-10008, 1, 999);
  assert.deepEqual(result, { ok: false, reason: 'no_draw' });
});

test('clearSurveyPlaceOverride returns the survey to the draw winner, and is a harmless no-op before any override', () => {
  const chatId = -10009;
  recordDraw({
    chatId,
    drawnAt: 1_700_000_000_000,
    winner: { userId: 1, username: 'artem', place: 'Дежерьома' },
    submissions: [
      { userId: 1, username: 'artem', place: 'Дежерьома' },
      { userId: 2, username: 'olya', place: 'Пузата хата' },
    ],
  });

  clearSurveyPlaceOverride(chatId); // nothing set yet — must not throw
  assert.equal(getRatingSurveyContext(chatId)?.winnerPlace, 'Дежерьома');

  setSurveyPlaceOverride(chatId, 2, 999);
  assert.equal(getRatingSurveyContext(chatId)?.winnerPlace, 'Пузата хата');

  clearSurveyPlaceOverride(chatId);
  assert.equal(getRatingSurveyContext(chatId)?.winnerPlace, 'Дежерьома');
  assert.equal(getSurveyPlaceOverride(chatId), undefined);
});
