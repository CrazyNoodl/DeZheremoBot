import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

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

// Deliberately its own shape rather than reusing storage/store.ts's Submission: history only ever
// records actual place proposals (submissionService.ts's recordDraw filters out 'declined' rows
// before calling this), so it has no reason to know about submission status at all.
export interface HistorySubmission {
  userId: number;
  username: string;
  place: string;
}

export interface DrawRecord {
  chatId: number;
  drawnAt: number;
  winner: HistorySubmission | undefined;
  submissions: HistorySubmission[];
}

// submissions_history has no chat_id of its own — chat_id lives on the weekly_draws row it
// belongs to (via draw_id), so scoping to a chat requires this join.
const historicalSubmittersStmt = db.prepare(`
  SELECT sh.user_id AS userId, sh.username, MAX(sh.id) AS lastId
  FROM submissions_history sh
  JOIN weekly_draws wd ON wd.id = sh.draw_id
  WHERE wd.chat_id = ?
  GROUP BY sh.user_id
`);

export interface HistoricalSubmitter {
  userId: number;
  username: string;
}

// Everyone who has ever submitted a place in this chat in a past week — used as the "known
// members" roster for the final reminder's non-submitter tagging, since the Bot API has no way to
// list a group's actual membership. SQLite's bare-column + MAX(id) combo returns username from the
// same row as the max id per user (documented SQLite behavior), so a renamed user shows their most
// recent username instead of their first-ever one.
export function getHistoricalSubmitters(chatId: number): HistoricalSubmitter[] {
  return (historicalSubmittersStmt.all(chatId) as unknown as (HistoricalSubmitter & { lastId: number })[]).map(
    ({ userId, username }) => ({ userId, username }),
  );
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
