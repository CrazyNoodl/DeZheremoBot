import assert from 'node:assert/strict';
import { test } from 'node:test';
import { disableTimeSlotPoll, enableTimeSlotPoll, isTimeSlotPollEnabled } from './timeSlotPollState.js';

test('a chat is disabled by default, before enableTimeSlotPoll is ever called', () => {
  assert.equal(isTimeSlotPollEnabled(-42101), false);
});

test('enableTimeSlotPoll flips a chat to enabled', () => {
  enableTimeSlotPoll(-42102);
  assert.equal(isTimeSlotPollEnabled(-42102), true);
});

test('disableTimeSlotPoll reverses enableTimeSlotPoll', () => {
  enableTimeSlotPoll(-42103);
  disableTimeSlotPoll(-42103);
  assert.equal(isTimeSlotPollEnabled(-42103), false);
});

test('enabled state is isolated per chat', () => {
  enableTimeSlotPoll(-42104);
  assert.equal(isTimeSlotPollEnabled(-42105), false);
});

test('enableTimeSlotPoll is idempotent — calling it twice does not throw', () => {
  enableTimeSlotPoll(-42106);
  assert.doesNotThrow(() => enableTimeSlotPoll(-42106));
  assert.equal(isTimeSlotPollEnabled(-42106), true);
});

test('disableTimeSlotPoll on a chat that was never enabled does not throw', () => {
  assert.doesNotThrow(() => disableTimeSlotPoll(-42107));
  assert.equal(isTimeSlotPollEnabled(-42107), false);
});
