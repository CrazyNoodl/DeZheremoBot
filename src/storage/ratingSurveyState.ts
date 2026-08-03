import { db } from './db.js';

// Presence in this table means the survey is disabled — the inverse of chat_pauses's convention
// (storage/pauseState.ts), where presence means paused. It has to be inverted here because the
// rating survey's default is *enabled*: a presence-means-enabled table would need a row for every
// untouched chat just to represent the common case, whereas presence-means-disabled keeps the table
// empty except for the groups that actually opted out.
db.exec(`CREATE TABLE IF NOT EXISTS rating_survey_disabled (chat_id INTEGER PRIMARY KEY);`);

const disableStmt = db.prepare(`INSERT OR IGNORE INTO rating_survey_disabled (chat_id) VALUES (?)`);
const enableStmt = db.prepare(`DELETE FROM rating_survey_disabled WHERE chat_id = ?`);
const isDisabledStmt = db.prepare(`SELECT 1 FROM rating_survey_disabled WHERE chat_id = ?`);

export function disableRatingSurvey(chatId: number): void {
  disableStmt.run(chatId);
}

export function enableRatingSurvey(chatId: number): void {
  enableStmt.run(chatId);
}

export function isRatingSurveyEnabled(chatId: number): boolean {
  return isDisabledStmt.get(chatId) === undefined;
}
