import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// scheduleService.ts sits on top of storage/groupSchedules.ts, which loads its state once at
// import time — same isolation approach as storage/groupSchedules.test.ts.
process.env.DEZHEREMO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dzb-scheduleservice-'));
const {
  getFinalReminderWeekday,
  getFirstReminderWeekday,
  getSchedule,
  isValidTime,
  MAX_TIME_SLOTS,
  resetSchedule,
  updateDeadlineSchedule,
  updateRatingSurveySchedule,
  updateReminderSchedule,
  updateTimeSlotPollTimes,
  updateTimeSlotPollWeekdays,
} = await import('./scheduleService.js');
const { DEFAULT_SCHEDULE } = await import('../storage/groupSchedules.js');

test('isValidTime accepts 24h HH:MM and rejects malformed input', () => {
  assert.equal(isValidTime('09:00'), true);
  assert.equal(isValidTime('23:59'), true);
  assert.equal(isValidTime('00:00'), true);
  assert.equal(isValidTime('24:00'), false);
  assert.equal(isValidTime('9:00'), false);
  assert.equal(isValidTime('09:60'), false);
  assert.equal(isValidTime('not a time'), false);
});

test('updateReminderSchedule rejects an invalid time and leaves the schedule untouched', () => {
  const result = updateReminderSchedule(-8001, [1, 3, 5], 'nope');

  assert.deepEqual(result, { ok: false, reason: 'invalid_time' });
  assert.deepEqual(getSchedule(-8001), DEFAULT_SCHEDULE);
});

test('updateReminderSchedule applies a valid change', () => {
  const result = updateReminderSchedule(-8002, [2, 4], '08:30');

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(getSchedule(-8002), { ...DEFAULT_SCHEDULE, reminderWeekdays: [2, 4], reminderTime: '08:30' });
});

test('updateDeadlineSchedule rejects drawTime <= lockTime', () => {
  const result = updateDeadlineSchedule(-8003, 5, '18:00', '18:00');

  assert.deepEqual(result, { ok: false, reason: 'draw_before_lock' });
  assert.deepEqual(getSchedule(-8003), DEFAULT_SCHEDULE);
});

test('updateDeadlineSchedule applies a valid change', () => {
  // Weekday 2 (Tue), not 6/0 — those are DEFAULT_SCHEDULE's own timeSlotPollWeekdays, which would
  // otherwise trip the new deadline/timeslot-poll conflict check for a test that isn't about that.
  const result = updateDeadlineSchedule(-8004, 2, '17:00', '17:30');

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(getSchedule(-8004), { ...DEFAULT_SCHEDULE, deadlineWeekday: 2, lockTime: '17:00', drawTime: '17:30' });
});

test('resetSchedule reverts an override back to DEFAULT_SCHEDULE', () => {
  updateReminderSchedule(-8005, [0], '11:00');
  resetSchedule(-8005);

  assert.deepEqual(getSchedule(-8005), DEFAULT_SCHEDULE);
});

test('updateReminderSchedule rejects a reminder landing on the deadline day at/after lockTime', () => {
  updateDeadlineSchedule(-8006, 5, '18:00', '18:15');

  const result = updateReminderSchedule(-8006, [5], '18:00');

  assert.deepEqual(result, { ok: false, reason: 'reminder_after_lock' });
  assert.deepEqual(getSchedule(-8006), { ...DEFAULT_SCHEDULE, deadlineWeekday: 5, lockTime: '18:00', drawTime: '18:15' });
});

test('updateReminderSchedule allows a reminder on the deadline day before lockTime', () => {
  updateDeadlineSchedule(-8007, 5, '18:00', '18:15');

  const result = updateReminderSchedule(-8007, [5], '09:00');

  assert.deepEqual(result, { ok: true });
});

test('updateDeadlineSchedule rejects moving lockTime to at/before an existing reminder on that day', () => {
  updateReminderSchedule(-8008, [5], '17:00');

  const result = updateDeadlineSchedule(-8008, 5, '17:00', '17:30');

  assert.deepEqual(result, { ok: false, reason: 'reminder_after_lock' });
  assert.deepEqual(getSchedule(-8008), { ...DEFAULT_SCHEDULE, reminderWeekdays: [5], reminderTime: '17:00' });
});

test('getFinalReminderWeekday picks the reminder that lands on the deadline day', () => {
  assert.equal(getFinalReminderWeekday({ ...DEFAULT_SCHEDULE, reminderWeekdays: [1, 3, 5], deadlineWeekday: 5 }), 5);
});

test('getFinalReminderWeekday picks the reminder closest before the deadline when none matches it', () => {
  // Mon(1)/Wed(3) reminders, Friday(5) deadline — Wed is 2 days before Friday, Mon is 4 days before.
  assert.equal(getFinalReminderWeekday({ ...DEFAULT_SCHEDULE, reminderWeekdays: [1, 3], deadlineWeekday: 5 }), 3);
});

test('getFinalReminderWeekday wraps across the week boundary', () => {
  // Sat(6) reminder, Mon(1) deadline — Sat is 2 days before Monday going forward through Sunday.
  assert.equal(getFinalReminderWeekday({ ...DEFAULT_SCHEDULE, reminderWeekdays: [6, 2], deadlineWeekday: 1 }), 6);
});

test('getFinalReminderWeekday returns the only reminder when just one is configured', () => {
  assert.equal(getFinalReminderWeekday({ ...DEFAULT_SCHEDULE, reminderWeekdays: [2], deadlineWeekday: 5 }), 2);
});

test('getFirstReminderWeekday picks the reminder farthest before the deadline', () => {
  // Mon(1)/Wed(3)/Fri(5) reminders, Friday(5) deadline — Mon is farthest (4 days before).
  assert.equal(getFirstReminderWeekday({ ...DEFAULT_SCHEDULE, reminderWeekdays: [1, 3, 5], deadlineWeekday: 5 }), 1);
});

test('getFirstReminderWeekday wraps across the week boundary', () => {
  // Sat(6)/Sun(0) reminders, Mon(1) deadline — Sun is farthest (going Sun->Sat->Mon is wrong; Sun is
  // 1 day before Monday, Sat is 2 days before — Sat is farthest.
  assert.equal(getFirstReminderWeekday({ ...DEFAULT_SCHEDULE, reminderWeekdays: [6, 0], deadlineWeekday: 1 }), 6);
});

test('getFirstReminderWeekday returns the only reminder when just one is configured', () => {
  assert.equal(getFirstReminderWeekday({ ...DEFAULT_SCHEDULE, reminderWeekdays: [2], deadlineWeekday: 5 }), 2);
});

test('updateRatingSurveySchedule rejects an invalid time and leaves the schedule untouched', () => {
  const result = updateRatingSurveySchedule(-8009, 0, 'nope');

  assert.deepEqual(result, { ok: false, reason: 'invalid_time' });
  assert.deepEqual(getSchedule(-8009), DEFAULT_SCHEDULE);
});

test('updateRatingSurveySchedule applies a valid change', () => {
  const result = updateRatingSurveySchedule(-8010, 3, '16:30');

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(getSchedule(-8010), { ...DEFAULT_SCHEDULE, ratingSurveyWeekday: 3, ratingSurveyTime: '16:30' });
});

test('updateTimeSlotPollWeekdays rejects a list that includes the current deadline day', () => {
  // DEFAULT_SCHEDULE's deadlineWeekday is Friday (5).
  const result = updateTimeSlotPollWeekdays(-8011, [5, 6]);

  assert.deepEqual(result, { ok: false, reason: 'timeslot_deadline_conflict' });
  assert.deepEqual(getSchedule(-8011), DEFAULT_SCHEDULE);
});

test('updateTimeSlotPollWeekdays applies a valid change', () => {
  const result = updateTimeSlotPollWeekdays(-8012, [6, 0, 1]);

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(getSchedule(-8012), { ...DEFAULT_SCHEDULE, timeSlotPollWeekdays: [6, 0, 1] });
});

test('updateDeadlineSchedule rejects moving the deadline onto a day already configured for the time-slot poll', () => {
  updateTimeSlotPollWeekdays(-8013, [6, 0]);

  const result = updateDeadlineSchedule(-8013, 6, '18:00', '18:15');

  assert.deepEqual(result, { ok: false, reason: 'timeslot_deadline_conflict' });
  assert.deepEqual(getSchedule(-8013), { ...DEFAULT_SCHEDULE, timeSlotPollWeekdays: [6, 0] });
});

test('updateDeadlineSchedule allows moving the deadline to a day not in the time-slot poll config', () => {
  updateTimeSlotPollWeekdays(-8014, [6, 0]);

  const result = updateDeadlineSchedule(-8014, 3, '18:00', '18:15');

  assert.deepEqual(result, { ok: true });
});

test('updateTimeSlotPollTimes rejects an invalid time format', () => {
  const result = updateTimeSlotPollTimes(-8015, ['10:00', 'nope']);

  assert.deepEqual(result, { ok: false, reason: 'invalid_time' });
  assert.deepEqual(getSchedule(-8015), DEFAULT_SCHEDULE);
});

test('updateTimeSlotPollTimes rejects more than MAX_TIME_SLOTS entries', () => {
  const result = updateTimeSlotPollTimes(-8016, Array.from({ length: MAX_TIME_SLOTS + 1 }, (_, i) => `${10 + i}:00`));

  assert.deepEqual(result, { ok: false, reason: 'too_many_time_slots' });
});

test('updateTimeSlotPollTimes accepts an empty list (hour screen skipped entirely)', () => {
  const result = updateTimeSlotPollTimes(-8017, []);

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(getSchedule(-8017).timeSlotPollTimes, []);
});
