import { db } from './db.js';

export type SubmissionStatus = 'submitted' | 'declined';

export interface Submission {
  userId: number;
  username: string;
  // Empty string for a 'declined' row — there's no place to render, and the column stays
  // NOT NULL so every other reader can keep treating it as a plain string.
  place: string;
  status: SubmissionStatus;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    place TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'submitted',
    PRIMARY KEY (chat_id, user_id)
  );
`);

// Migration for a state.db created before "не йду" existed: CREATE TABLE IF NOT EXISTS above is a
// no-op against an already-existing table, so an existing production db needs the column added
// explicitly (SQLite has no ADD COLUMN IF NOT EXISTS).
const submissionColumns = db.prepare(`PRAGMA table_info(submissions)`).all() as { name: string }[];
if (!submissionColumns.some((c) => c.name === 'status')) {
  db.exec(`ALTER TABLE submissions ADD COLUMN status TEXT NOT NULL DEFAULT 'submitted'`);
}

const upsertStmt = db.prepare(`
  INSERT INTO submissions (chat_id, user_id, username, place, status)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(chat_id, user_id) DO UPDATE SET username = excluded.username, place = excluded.place, status = excluded.status
`);

const listStmt = db.prepare(`SELECT user_id AS userId, username, place, status FROM submissions WHERE chat_id = ?`);
const getStmt = db.prepare(`SELECT user_id AS userId, username, place, status FROM submissions WHERE chat_id = ? AND user_id = ?`);
const clearStmt = db.prepare(`DELETE FROM submissions WHERE chat_id = ?`);
const removeStmt = db.prepare(`DELETE FROM submissions WHERE chat_id = ? AND user_id = ?`);

export function addSubmission(chatId: number, userId: number, username: string, place: string): void {
  upsertStmt.run(chatId, userId, username, place, 'submitted');
}

// Records "не йду цього тижня" — same (chat_id, user_id) row as a place submission, so it
// overwrites one the same way a resubmit does, and disappears on the same weekly clearSubmissions.
export function addDecline(chatId: number, userId: number, username: string): void {
  upsertStmt.run(chatId, userId, username, '', 'declined');
}

export function listSubmissions(chatId: number): Submission[] {
  return listStmt.all(chatId) as unknown as Submission[];
}

export function getSubmission(chatId: number, userId: number): Submission | undefined {
  return getStmt.get(chatId, userId) as unknown as Submission | undefined;
}

export function clearSubmissions(chatId: number): void {
  clearStmt.run(chatId);
}

export function removeSubmission(chatId: number, userId: number): void {
  removeStmt.run(chatId, userId);
}
