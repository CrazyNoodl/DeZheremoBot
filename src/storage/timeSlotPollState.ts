import { db } from './db.js';

// Presence in this table means the poll is enabled — the inverse of ratingSurveyState.ts's
// rating_survey_disabled convention, because this feature's default is *disabled* (a brand-new
// experimental feature, opt-in), whereas the rating survey's default is *enabled*. A
// presence-means-enabled table stays empty except for the groups that actually opted in.
db.exec(`CREATE TABLE IF NOT EXISTS time_slot_poll_enabled (chat_id INTEGER PRIMARY KEY);`);

const enableStmt = db.prepare(`INSERT OR IGNORE INTO time_slot_poll_enabled (chat_id) VALUES (?)`);
const disableStmt = db.prepare(`DELETE FROM time_slot_poll_enabled WHERE chat_id = ?`);
const isEnabledStmt = db.prepare(`SELECT 1 FROM time_slot_poll_enabled WHERE chat_id = ?`);

export function enableTimeSlotPoll(chatId: number): void {
  enableStmt.run(chatId);
}

export function disableTimeSlotPoll(chatId: number): void {
  disableStmt.run(chatId);
}

export function isTimeSlotPollEnabled(chatId: number): boolean {
  return isEnabledStmt.get(chatId) !== undefined;
}
