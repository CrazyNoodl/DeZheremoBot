import { db } from './db.js';

export interface Submission {
  userId: number;
  username: string;
  place: string;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    place TEXT NOT NULL,
    PRIMARY KEY (chat_id, user_id)
  );
`);

const upsertStmt = db.prepare(`
  INSERT INTO submissions (chat_id, user_id, username, place)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(chat_id, user_id) DO UPDATE SET username = excluded.username, place = excluded.place
`);

const listStmt = db.prepare(`SELECT user_id AS userId, username, place FROM submissions WHERE chat_id = ?`);
const getStmt = db.prepare(`SELECT user_id AS userId, username, place FROM submissions WHERE chat_id = ? AND user_id = ?`);
const clearStmt = db.prepare(`DELETE FROM submissions WHERE chat_id = ?`);
const removeStmt = db.prepare(`DELETE FROM submissions WHERE chat_id = ? AND user_id = ?`);

export function addSubmission(chatId: number, userId: number, username: string, place: string): void {
  upsertStmt.run(chatId, userId, username, place);
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
