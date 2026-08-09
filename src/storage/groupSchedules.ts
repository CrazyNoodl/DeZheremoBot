import path from 'node:path';
import { readJsonFile, writeJsonFileAtomic } from './jsonFile.js';

// Same test-isolation override as storage/groupChats.ts.
const DATA_DIR = process.env.DEZHEREMO_DATA_DIR ?? path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'groupSchedules.json');

export interface GroupScheduleConfig {
  reminderWeekdays: number[]; // 0=Sunday..6=Saturday, matches Date#getDay()
  reminderTime: string; // "HH:MM", 24h
  deadlineWeekday: number; // 0-6, day lock+draw happen on
  lockTime: string; // "HH:MM"
  drawTime: string; // "HH:MM", must be > lockTime same day
  ratingSurveyWeekday: number; // 0-6, day the rating survey goes out on
  ratingSurveyTime: string; // "HH:MM"
  timeSlotPollWeekdays: number[]; // 0-6, min 1 max 7 — days offered on the availability poll's day screen
  timeSlotPollTimes: string[]; // "HH:MM", 0 to 5 entries — hour screen is skipped entirely when empty
}

// Whether the survey/poll is sent/offered at all (ratingSurveyEnabled, and the experimental
// time-slot poll's own enabled flag) deliberately isn't a field here — those live in
// storage/ratingSurveyState.ts / storage/timeSlotPollState.ts instead, alongside chat_pauses,
// specifically so resetGroupSchedule below doesn't also silently re-enable/disable them as a side
// effect of resetting the day/time (see "Post-draw rating survey" in CLAUDE.md).
export const DEFAULT_SCHEDULE: GroupScheduleConfig = {
  reminderWeekdays: [1, 3, 5], // Mon/Wed/Fri
  reminderTime: '10:00',
  deadlineWeekday: 5, // Friday
  lockTime: '18:00',
  drawTime: '18:15',
  ratingSurveyWeekday: 0, // Sunday
  ratingSurveyTime: '15:00',
  timeSlotPollWeekdays: [6, 0], // Sat/Sun — after a typical Friday deadline
  timeSlotPollTimes: ['10:00', '10:30', '11:00'],
};

function load(): Record<string, GroupScheduleConfig> {
  return readJsonFile<Record<string, GroupScheduleConfig>>(DATA_FILE, {});
}

const schedules = load();

function persist(): void {
  writeJsonFileAtomic(DATA_FILE, schedules);
}

export function getGroupSchedule(chatId: number): GroupScheduleConfig {
  // Merged rather than an all-or-nothing fallback: a chat that customized its schedule before a
  // new field (e.g. ratingSurveyWeekday) existed has a persisted object missing that key, which
  // would otherwise come back as undefined instead of picking up the new default.
  return { ...DEFAULT_SCHEDULE, ...(schedules[chatId] ?? {}) };
}

export function setGroupSchedule(chatId: number, config: GroupScheduleConfig): void {
  schedules[chatId] = config;
  persist();
}

export function resetGroupSchedule(chatId: number): void {
  if (!(chatId in schedules)) return;
  delete schedules[chatId];
  persist();
}
