import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { Submission } from './store.js';

const DATA_DIR = path.join(process.cwd(), 'data');
// Same test-isolation override as storage/db.ts — see the comment there.
const DB_FILE = process.env.DEZHEREMO_HISTORY_DB ?? path.join(DATA_DIR, 'history.db');

if (DB_FILE !== ':memory:') {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const db = new DatabaseSync(DB_FILE);

db.exec(`
  CREATE TABLE IF NOT EXISTS weekly_draws (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    drawn_at INTEGER NOT NULL,
    winner_user_id INTEGER,
    winner_place TEXT,
    total_submissions INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS submissions_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draw_id INTEGER NOT NULL REFERENCES weekly_draws(id),
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    place TEXT NOT NULL,
    is_winner INTEGER NOT NULL
  );
`);

const insertDrawStmt = db.prepare(`
  INSERT INTO weekly_draws (chat_id, drawn_at, winner_user_id, winner_place, total_submissions)
  VALUES (?, ?, ?, ?, ?)
`);

const insertSubmissionStmt = db.prepare(`
  INSERT INTO submissions_history (draw_id, user_id, username, place, is_winner)
  VALUES (?, ?, ?, ?, ?)
`);

export interface DrawRecord {
  chatId: number;
  drawnAt: number;
  winner: Submission | undefined;
  submissions: Submission[];
}

export function recordDraw(record: DrawRecord): void {
  insertDrawStmt.run(
    record.chatId,
    record.drawnAt,
    record.winner?.userId ?? null,
    record.winner?.place ?? null,
    record.submissions.length,
  );

  const drawId = db.prepare('SELECT last_insert_rowid() AS id').get()!.id as number;

  for (const submission of record.submissions) {
    insertSubmissionStmt.run(
      drawId,
      submission.userId,
      submission.username,
      submission.place,
      submission.userId === record.winner?.userId ? 1 : 0,
    );
  }
}
