import { db } from './db.js';

db.exec(`CREATE TABLE IF NOT EXISTS chat_locks (chat_id INTEGER PRIMARY KEY);`);

const lockStmt = db.prepare(`INSERT OR IGNORE INTO chat_locks (chat_id) VALUES (?)`);
const unlockStmt = db.prepare(`DELETE FROM chat_locks WHERE chat_id = ?`);
const isLockedStmt = db.prepare(`SELECT 1 FROM chat_locks WHERE chat_id = ?`);

export function lock(chatId: number): void {
  lockStmt.run(chatId);
}

export function unlock(chatId: number): void {
  unlockStmt.run(chatId);
}

export function isLocked(chatId: number): boolean {
  return isLockedStmt.get(chatId) !== undefined;
}
