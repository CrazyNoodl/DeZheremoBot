import { db } from './db.js';

export interface TimeSlotResponse {
  userId: number;
  days: number[];
  // "Будь-коли" on the day screen — when set, this response counts toward every configured day
  // (see services/timeSlotPollService.ts) rather than only whatever's in `days`, which is left
  // empty in that case (mutually exclusive with picking specific days in the wizard UI).
  daysAny: boolean;
  times: string[];
  timesAny: boolean;
}

// One row per user per week — same shape/lifecycle as submissions (upserted, cleared by
// resetWeek, dropped on block).
db.exec(`
  CREATE TABLE IF NOT EXISTS time_slot_responses (
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    days TEXT NOT NULL,
    days_any INTEGER NOT NULL DEFAULT 0,
    times TEXT NOT NULL,
    times_any INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (chat_id, user_id)
  );
`);

const upsertStmt = db.prepare(`
  INSERT INTO time_slot_responses (chat_id, user_id, days, days_any, times, times_any)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(chat_id, user_id) DO UPDATE SET
    days = excluded.days, days_any = excluded.days_any, times = excluded.times, times_any = excluded.times_any
`);
const getStmt = db.prepare(`
  SELECT user_id AS userId, days, days_any AS daysAny, times, times_any AS timesAny
  FROM time_slot_responses WHERE chat_id = ? AND user_id = ?
`);
const listStmt = db.prepare(`
  SELECT user_id AS userId, days, days_any AS daysAny, times, times_any AS timesAny
  FROM time_slot_responses WHERE chat_id = ?
`);
const clearStmt = db.prepare(`DELETE FROM time_slot_responses WHERE chat_id = ?`);
const removeStmt = db.prepare(`DELETE FROM time_slot_responses WHERE chat_id = ? AND user_id = ?`);

interface RawRow {
  userId: number;
  days: string;
  daysAny: number;
  times: string;
  timesAny: number;
}

function toResponse(row: RawRow): TimeSlotResponse {
  return {
    userId: row.userId,
    days: row.days === '' ? [] : row.days.split(',').map(Number),
    daysAny: row.daysAny === 1,
    times: row.times === '' ? [] : row.times.split(','),
    timesAny: row.timesAny === 1,
  };
}

export function addOrUpdateTimeSlotResponse(
  chatId: number,
  userId: number,
  response: Omit<TimeSlotResponse, 'userId'>,
): void {
  upsertStmt.run(chatId, userId, response.days.join(','), response.daysAny ? 1 : 0, response.times.join(','), response.timesAny ? 1 : 0);
}

export function getTimeSlotResponse(chatId: number, userId: number): TimeSlotResponse | undefined {
  const row = getStmt.get(chatId, userId) as unknown as RawRow | undefined;
  return row ? toResponse(row) : undefined;
}

export function listTimeSlotResponses(chatId: number): TimeSlotResponse[] {
  return (listStmt.all(chatId) as unknown as RawRow[]).map(toResponse);
}

export function clearTimeSlotResponses(chatId: number): void {
  clearStmt.run(chatId);
}

export function removeTimeSlotResponse(chatId: number, userId: number): void {
  removeStmt.run(chatId, userId);
}
