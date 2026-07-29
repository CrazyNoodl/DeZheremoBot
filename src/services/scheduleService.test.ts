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
  getSchedule,
  isValidTime,
  resetSchedule,
  updateDeadlineSchedule,
  updateReminderSchedule,
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
  const result = updateDeadlineSchedule(-8004, 6, '17:00', '17:30');

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(getSchedule(-8004), { ...DEFAULT_SCHEDULE, deadlineWeekday: 6, lockTime: '17:00', drawTime: '17:30' });
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
