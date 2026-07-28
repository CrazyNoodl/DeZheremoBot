import { db } from './db.js';

db.exec(`CREATE TABLE IF NOT EXISTS chat_pauses (chat_id INTEGER PRIMARY KEY);`);

const pauseStmt = db.prepare(`INSERT OR IGNORE INTO chat_pauses (chat_id) VALUES (?)`);
const resumeStmt = db.prepare(`DELETE FROM chat_pauses WHERE chat_id = ?`);
const isPausedStmt = db.prepare(`SELECT 1 FROM chat_pauses WHERE chat_id = ?`);

export function pause(chatId: number): void {
  pauseStmt.run(chatId);
}

export function resume(chatId: number): void {
  resumeStmt.run(chatId);
}

export function isPaused(chatId: number): boolean {
  return isPausedStmt.get(chatId) !== undefined;
}
