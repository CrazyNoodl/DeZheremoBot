import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// timeSlotPollService.ts sits on top of services/scheduleService.ts, which loads
// storage/groupSchedules.ts state once at import time — same isolation approach as
// scheduleService.test.ts.
process.env.DEZHEREMO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dzb-timeslotpollservice-'));
const { getTimeSlotSuggestion, isTimeSlotPollEnabled, setTimeSlotPollEnabled } = await import('./timeSlotPollService.js');
const { updateTimeSlotPollTimes, updateTimeSlotPollWeekdays } = await import('./scheduleService.js');
const { addOrUpdateTimeSlotResponse } = await import('../storage/timeSlotResponses.js');
const { blockUser } = await import('../storage/blockedUsers.js');

test('a chat is disabled by default, before setTimeSlotPollEnabled is ever called', () => {
  assert.equal(isTimeSlotPollEnabled(-45101), false);
});

test('setTimeSlotPollEnabled(true) then (false) round-trips', () => {
  setTimeSlotPollEnabled(-45102, true);
  assert.equal(isTimeSlotPollEnabled(-45102), true);
  setTimeSlotPollEnabled(-45102, false);
  assert.equal(isTimeSlotPollEnabled(-45102), false);
});

test('getTimeSlotSuggestion returns undefined when the poll is disabled, even with responses recorded', () => {
  addOrUpdateTimeSlotResponse(-45103, 1, { days: [6], daysAny: false, times: [], timesAny: false });
  assert.equal(getTimeSlotSuggestion(-45103), undefined);
});

test('getTimeSlotSuggestion returns undefined when enabled but nobody answered this week', () => {
  setTimeSlotPollEnabled(-45104, true);
  assert.equal(getTimeSlotSuggestion(-45104), undefined);
});

test('getTimeSlotSuggestion picks the day with the most votes', () => {
  const chatId = -45105;
  setTimeSlotPollEnabled(chatId, true);
  updateTimeSlotPollWeekdays(chatId, [6, 0]);
  addOrUpdateTimeSlotResponse(chatId, 1, { days: [6], daysAny: false, times: [], timesAny: false });
  addOrUpdateTimeSlotResponse(chatId, 2, { days: [6], daysAny: false, times: [], timesAny: false });
  addOrUpdateTimeSlotResponse(chatId, 3, { days: [0], daysAny: false, times: [], timesAny: false });

  assert.equal(getTimeSlotSuggestion(chatId)?.day, 6);
});

test('getTimeSlotSuggestion tie-break picks the day closest to the deadline, measured forward from it', () => {
  const chatId = -45106;
  setTimeSlotPollEnabled(chatId, true);
  // Default deadlineWeekday is Friday (5). Sat(6) is 1 day after it, Mon(1) is 3 days after —
  // a tied vote must favor Sat.
  updateTimeSlotPollWeekdays(chatId, [6, 0, 1]);
  addOrUpdateTimeSlotResponse(chatId, 1, { days: [6], daysAny: false, times: [], timesAny: false });
  addOrUpdateTimeSlotResponse(chatId, 2, { days: [1], daysAny: false, times: [], timesAny: false });

  assert.equal(getTimeSlotSuggestion(chatId)?.day, 6);
});

test('daysAny contributes to every configured day, not just an explicit pick', () => {
  const chatId = -45107;
  setTimeSlotPollEnabled(chatId, true);
  updateTimeSlotPollWeekdays(chatId, [6, 0]);
  addOrUpdateTimeSlotResponse(chatId, 1, { days: [], daysAny: true, times: [], timesAny: false });
  addOrUpdateTimeSlotResponse(chatId, 2, { days: [0], daysAny: false, times: [], timesAny: false });

  // Sun(0) gets the explicit vote plus the "any" vote (2 total) vs. Sat's 1 "any" vote.
  assert.equal(getTimeSlotSuggestion(chatId)?.day, 0);
});

test('getTimeSlotSuggestion.time is undefined when this chat has no configured hours', () => {
  const chatId = -45108;
  setTimeSlotPollEnabled(chatId, true);
  updateTimeSlotPollWeekdays(chatId, [6]);
  updateTimeSlotPollTimes(chatId, []);
  addOrUpdateTimeSlotResponse(chatId, 1, { days: [6], daysAny: false, times: [], timesAny: false });

  assert.equal(getTimeSlotSuggestion(chatId)?.time, undefined);
});

test('getTimeSlotSuggestion picks the hour with the most votes, tie-break earliest', () => {
  const chatId = -45109;
  setTimeSlotPollEnabled(chatId, true);
  updateTimeSlotPollWeekdays(chatId, [6]);
  updateTimeSlotPollTimes(chatId, ['10:00', '10:30', '11:00']);
  addOrUpdateTimeSlotResponse(chatId, 1, { days: [6], daysAny: false, times: ['10:00'], timesAny: false });
  addOrUpdateTimeSlotResponse(chatId, 2, { days: [6], daysAny: false, times: ['10:30'], timesAny: false });

  // 10:00 and 10:30 tie at 1 vote each — earliest wins.
  assert.equal(getTimeSlotSuggestion(chatId)?.time, '10:00');
});

test('timesAny contributes to every configured hour', () => {
  const chatId = -45110;
  setTimeSlotPollEnabled(chatId, true);
  updateTimeSlotPollWeekdays(chatId, [6]);
  updateTimeSlotPollTimes(chatId, ['10:00', '11:00']);
  addOrUpdateTimeSlotResponse(chatId, 1, { days: [6], daysAny: false, times: [], timesAny: true });
  addOrUpdateTimeSlotResponse(chatId, 2, { days: [6], daysAny: false, times: ['11:00'], timesAny: false });

  assert.equal(getTimeSlotSuggestion(chatId)?.time, '11:00');
});

// blockUserFromGroup (services/submissionService.ts) already deletes a blocked user's response
// row outright, which would make this filter untestable through that path — this instead
// simulates the narrower race the filter defends against directly: someone answers, is blocked
// afterward (storage/blockedUsers.ts's blockUser, bypassing the row deletion), and their response
// row is still physically present when the suggestion is computed.
test('a blocked user\'s response is excluded from the aggregate even if the row is still present', () => {
  const chatId = -45111;
  setTimeSlotPollEnabled(chatId, true);
  updateTimeSlotPollWeekdays(chatId, [6, 0]);
  addOrUpdateTimeSlotResponse(chatId, 1, { days: [6], daysAny: false, times: [], timesAny: false });
  addOrUpdateTimeSlotResponse(chatId, 2, { days: [0], daysAny: false, times: [], timesAny: false });

  blockUser(chatId, 1, 'artem', 999);

  // Sat(6)'s only vote came from the now-blocked user 1 — Sun(0) should win with its one real vote.
  assert.equal(getTimeSlotSuggestion(chatId)?.day, 0);
});
