import { db } from './db.js';

export type ScheduledAction = 'reminder' | 'lock' | 'draw';

db.exec(`
  CREATE TABLE IF NOT EXISTS fired_events (
    chat_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    fired_date TEXT NOT NULL,
    PRIMARY KEY (chat_id, action)
  );
`);

const markFiredStmt = db.prepare(`
  INSERT INTO fired_events (chat_id, action, fired_date)
  VALUES (?, ?, ?)
  ON CONFLICT(chat_id, action) DO UPDATE SET fired_date = excluded.fired_date
`);

const hasFiredStmt = db.prepare(`SELECT 1 FROM fired_events WHERE chat_id = ? AND action = ? AND fired_date = ?`);

export function hasFiredToday(chatId: number, action: ScheduledAction, date: string): boolean {
  return hasFiredStmt.get(chatId, action, date) !== undefined;
}

export function markFired(chatId: number, action: ScheduledAction, date: string): void {
  markFiredStmt.run(chatId, action, date);
}
