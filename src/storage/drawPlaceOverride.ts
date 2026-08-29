import { db } from './history.js';

// Shares history.ts's connection (same reasoning as placeRatings.ts/auditLog.ts) since this FKs
// onto weekly_draws(id). At most one row per draw — present only when an admin has manually
// corrected which place the post-draw rating survey should ask about, for the "winner couldn't
// make it, the group went somewhere else on the list instead" case. Deliberately does not touch
// weekly_draws.winner_place itself: the draw's own record and win-count statistics stay tied to
// what the random draw actually picked, this table only redirects the *survey*.
db.exec(`
  CREATE TABLE IF NOT EXISTS draw_place_overrides (
    draw_id INTEGER PRIMARY KEY REFERENCES weekly_draws(id),
    place TEXT NOT NULL,
    submitter_user_id INTEGER,
    set_by_user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

const upsertStmt = db.prepare(`
  INSERT INTO draw_place_overrides (draw_id, place, submitter_user_id, set_by_user_id, created_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(draw_id) DO UPDATE SET
    place = excluded.place,
    submitter_user_id = excluded.submitter_user_id,
    set_by_user_id = excluded.set_by_user_id,
    created_at = excluded.created_at
`);

// Upsert rather than insert-only: an admin changing their mind about which place it actually was
// just overwrites the previous override instead of erroring on the PRIMARY KEY.
export function setDrawPlaceOverride(drawId: number, place: string, submitterUserId: number | undefined, setByUserId: number): void {
  upsertStmt.run(drawId, place, submitterUserId ?? null, setByUserId, Date.now());
}

const deleteStmt = db.prepare('DELETE FROM draw_place_overrides WHERE draw_id = ?');

export function clearDrawPlaceOverride(drawId: number): void {
  deleteStmt.run(drawId);
}

export interface DrawPlaceOverride {
  place: string;
  submitterUserId: number | null;
}

const getStmt = db.prepare('SELECT place, submitter_user_id AS submitterUserId FROM draw_place_overrides WHERE draw_id = ?');

export function getDrawPlaceOverride(drawId: number): DrawPlaceOverride | undefined {
  const row = getStmt.get(drawId) as unknown as DrawPlaceOverride | undefined;
  // node:sqlite rows are null-prototype objects — spread into a plain one so a caller's
  // deepEqual/deepStrictEqual against a literal (tests) or JSON.stringify doesn't trip on the
  // prototype mismatch.
  return row ? { ...row } : undefined;
}
