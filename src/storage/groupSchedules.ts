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
}

export const DEFAULT_SCHEDULE: GroupScheduleConfig = {
  reminderWeekdays: [1, 3, 5], // Mon/Wed/Fri
  reminderTime: '10:00',
  deadlineWeekday: 5, // Friday
  lockTime: '18:00',
  drawTime: '18:15',
};

function load(): Record<string, GroupScheduleConfig> {
  return readJsonFile<Record<string, GroupScheduleConfig>>(DATA_FILE, {});
}

const schedules = load();

function persist(): void {
  writeJsonFileAtomic(DATA_FILE, schedules);
}

export function getGroupSchedule(chatId: number): GroupScheduleConfig {
  return schedules[chatId] ?? DEFAULT_SCHEDULE;
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
