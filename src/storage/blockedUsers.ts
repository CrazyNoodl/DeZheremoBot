import { db } from './db.js';

export interface BlockedUser {
  userId: number;
  username: string | null;
  blockedAt: number;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS blocked_users (
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    username TEXT,
    blocked_at INTEGER NOT NULL,
    blocked_by INTEGER NOT NULL,
    PRIMARY KEY (chat_id, user_id)
  );
`);

const blockStmt = db.prepare(`
  INSERT INTO blocked_users (chat_id, user_id, username, blocked_at, blocked_by)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(chat_id, user_id) DO UPDATE SET username = excluded.username, blocked_at = excluded.blocked_at, blocked_by = excluded.blocked_by
`);
const unblockStmt = db.prepare(`DELETE FROM blocked_users WHERE chat_id = ? AND user_id = ?`);
const isBlockedStmt = db.prepare(`SELECT 1 FROM blocked_users WHERE chat_id = ? AND user_id = ?`);
const listStmt = db.prepare(`
  SELECT user_id AS userId, username, blocked_at AS blockedAt FROM blocked_users WHERE chat_id = ?
`);

export function blockUser(chatId: number, userId: number, username: string | undefined, blockedBy: number): void {
  blockStmt.run(chatId, userId, username ?? null, Date.now(), blockedBy);
}

export function unblockUser(chatId: number, userId: number): void {
  unblockStmt.run(chatId, userId);
}

export function isBlocked(chatId: number, userId: number): boolean {
  return isBlockedStmt.get(chatId, userId) !== undefined;
}

export function listBlockedUsers(chatId: number): BlockedUser[] {
  return listStmt.all(chatId) as unknown as BlockedUser[];
}
