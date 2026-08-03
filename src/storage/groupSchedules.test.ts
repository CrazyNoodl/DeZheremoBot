import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Same isolation approach as groupChats.test.ts — see the comment there.
process.env.DEZHEREMO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dzb-groupschedules-'));
const { DEFAULT_SCHEDULE, getGroupSchedule, resetGroupSchedule, setGroupSchedule } = await import('./groupSchedules.js');

test('getGroupSchedule falls back to DEFAULT_SCHEDULE when no override exists', () => {
  assert.deepEqual(getGroupSchedule(-7001), DEFAULT_SCHEDULE);
});

test('setGroupSchedule persists an override that getGroupSchedule then returns', () => {
  const custom = { ...DEFAULT_SCHEDULE, reminderTime: '09:00' };
  setGroupSchedule(-7002, custom);
  assert.deepEqual(getGroupSchedule(-7002), custom);
});

test('resetGroupSchedule removes the override, reverting to DEFAULT_SCHEDULE', () => {
  setGroupSchedule(-7003, { ...DEFAULT_SCHEDULE, lockTime: '19:00' });
  resetGroupSchedule(-7003);
  assert.deepEqual(getGroupSchedule(-7003), DEFAULT_SCHEDULE);
});

test('overrides are isolated per chat', () => {
  setGroupSchedule(-7004, { ...DEFAULT_SCHEDULE, drawTime: '20:00' });
  assert.deepEqual(getGroupSchedule(-7005), DEFAULT_SCHEDULE);
});

// A chat that customized its schedule before ratingSurvey* fields existed has a persisted object
// missing those keys — getGroupSchedule must backfill them from DEFAULT_SCHEDULE rather than
// returning the stored object as-is (which would leave ratingSurveyWeekday/ratingSurveyTime undefined).
test('getGroupSchedule backfills fields missing from a previously persisted override', () => {
  const legacyOverride = { reminderTime: '09:30' } as unknown as Parameters<typeof setGroupSchedule>[1];
  setGroupSchedule(-7006, legacyOverride);

  assert.deepEqual(getGroupSchedule(-7006), { ...DEFAULT_SCHEDULE, reminderTime: '09:30' });
});
