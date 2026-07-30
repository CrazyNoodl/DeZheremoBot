import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearAwaitingSubmission,
  getAwaitingChatId,
  isCurrentAwaitingToken,
  markAwaitingSubmission,
} from './pendingState.js';

test('getAwaitingChatId returns undefined for a userId that was never marked', () => {
  assert.equal(getAwaitingChatId(18001), undefined);
});

test('markAwaitingSubmission sets the chatId such that getAwaitingChatId returns it', () => {
  markAwaitingSubmission(18002, -18002);
  assert.equal(getAwaitingChatId(18002), -18002);
});

test('awaiting state is isolated per user', () => {
  markAwaitingSubmission(18003, -18003);
  assert.equal(getAwaitingChatId(18004), undefined);
});

test('markAwaitingSubmission returns a token that isCurrentAwaitingToken confirms right after marking', () => {
  const token = markAwaitingSubmission(18005, -18005);
  assert.equal(isCurrentAwaitingToken(18005, token), true);
});

test('a second markAwaitingSubmission call returns a new token, invalidating the old one', () => {
  const oldToken = markAwaitingSubmission(18006, -18006);
  const newToken = markAwaitingSubmission(18006, -18006);
  assert.notEqual(newToken, oldToken);
  assert.equal(isCurrentAwaitingToken(18006, oldToken), false);
  assert.equal(isCurrentAwaitingToken(18006, newToken), true);
});

test('isCurrentAwaitingToken returns false for a userId that was never marked', () => {
  assert.equal(isCurrentAwaitingToken(18007, {}), false);
});

test('clearAwaitingSubmission clears both the chatId and the current token', () => {
  const token = markAwaitingSubmission(18008, -18008);
  clearAwaitingSubmission(18008);
  assert.equal(getAwaitingChatId(18008), undefined);
  assert.equal(isCurrentAwaitingToken(18008, token), false);
});

test('clearAwaitingSubmission on a user that was never marked does not throw', () => {
  assert.doesNotThrow(() => clearAwaitingSubmission(18009));
});
