import { db } from './history.js';

// Shares history.ts's connection onto history.db (same reasoning as auditLog.ts) since this
// references weekly_draws(id) — no reason to open a second connection onto the same file.
db.exec(`
  CREATE TABLE IF NOT EXISTS place_ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draw_id INTEGER NOT NULL REFERENCES weekly_draws(id),
    user_id INTEGER NOT NULL,
    stars INTEGER,
    rated_at INTEGER NOT NULL,
    UNIQUE(draw_id, user_id)
  );
`);

const upsertRatingStmt = db.prepare(`
  INSERT INTO place_ratings (draw_id, user_id, stars, rated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(draw_id, user_id) DO UPDATE SET stars = excluded.stars, rated_at = excluded.rated_at
`);

// Upsert rather than insert-only: tapping a different star after already rating just changes the
// answer instead of erroring on the UNIQUE(draw_id, user_id) constraint.
export function addOrUpdateRating(drawId: number, userId: number, stars: number): void {
  upsertRatingStmt.run(drawId, userId, stars, Date.now());
}

// A submitter can drop out between proposing the place and the group actually going — asking them
// to rate a visit that never happened for them doesn't make sense, so "🙅 Мене не було" records a
// NULL stars row instead of forcing a 1-5 answer. Shares the same upsert as a real rating (same
// UNIQUE(draw_id, user_id) row), so tapping a star after marking absent (or vice versa) just
// overwrites it, same as changing your mind about a star count.
export function markAsAbsent(drawId: number, userId: number): void {
  upsertRatingStmt.run(drawId, userId, null, Date.now());
}
