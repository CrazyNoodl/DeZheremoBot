import { db, getTopWinningPlaces } from './history.js';

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

export interface RaterCount {
  userId: number;
  username: string;
  ratings: number;
}

// place_ratings has no username column of its own — ratings only ever go to a draw's submitters
// (see ratingService.ts's getRatingSurveyContext), so joining back to that same draw's
// submissions_history row for the same (draw_id, user_id) always finds one. Counts only actual
// star ratings (stars IS NOT NULL), not "🙅 Мене не було" taps — used by /admin's
// "📈 Активність" statistics tab.
const topRatersStmt = db.prepare(`
  SELECT pr.user_id AS userId, sh.username, COUNT(*) AS ratings, MAX(sh.id) AS lastId
  FROM place_ratings pr
  JOIN weekly_draws wd ON wd.id = pr.draw_id
  JOIN submissions_history sh ON sh.draw_id = pr.draw_id AND sh.user_id = pr.user_id
  WHERE wd.chat_id = ? AND pr.stars IS NOT NULL
  GROUP BY pr.user_id
  ORDER BY ratings DESC
`);

export function getTopRaters(chatId: number): RaterCount[] {
  return (topRatersStmt.all(chatId) as unknown as (RaterCount & { lastId: number })[]).map(
    ({ userId, username, ratings }) => ({ userId, username, ratings }),
  );
}

// A submitter can drop out between proposing the place and the group actually going — asking them
// to rate a visit that never happened for them doesn't make sense, so "🙅 Мене не було" records a
// NULL stars row instead of forcing a 1-5 answer. Shares the same upsert as a real rating (same
// UNIQUE(draw_id, user_id) row), so tapping a star after marking absent (or vice versa) just
// overwrites it, same as changing your mind about a star count.
export function markAsAbsent(drawId: number, userId: number): void {
  upsertRatingStmt.run(drawId, userId, null, Date.now());
}

export interface PlaceVote {
  userId: number;
  username: string;
  stars: number | null; // null = "🙅 Мене не було", excluded from averageStars but still listed
  ratedAt: number; // epoch ms — a place that's won more than once can get several votes from the
  // same user (one per visit), so the caller needs this to label/group repeat votes by date rather
  // than have them read as an accidental duplicate.
}

export interface PlaceRatingSummary {
  place: string;
  averageStars: number | null; // null when the place has no real star ratings yet
  ratingCount: number; // real 1-5 votes only, same exclusion as getTopRaters
  votes: PlaceVote[]; // every vote for this place, most recent first, absent taps included
}

// Same join reasoning as topRatersStmt: a rating only ever goes to a draw's own submitter, so
// joining place_ratings back to that exact (draw_id, user_id) row in submissions_history always
// finds the username, no aggregation needed.
const placeVotesStmt = db.prepare(`
  SELECT wd.winner_place AS place, pr.user_id AS userId, sh.username, pr.stars, pr.rated_at AS ratedAt
  FROM weekly_draws wd
  JOIN place_ratings pr ON pr.draw_id = wd.id
  JOIN submissions_history sh ON sh.draw_id = pr.draw_id AND sh.user_id = pr.user_id
  WHERE wd.chat_id = ? AND wd.winner_place IS NOT NULL
  ORDER BY pr.rated_at DESC
`);

// Every place that has ever won a draw in this chat, each with its average star rating (absent
// taps excluded, same as getTopRaters) and the full list of individual votes underneath — the
// "average rating per place" CLAUDE.md's "Known future directions" flagged as still unread from
// place_ratings. Reuses getTopWinningPlaces for the place roster rather than deriving it from
// place_ratings itself, so a place that won but was never rated still shows up, with an empty
// votes list, instead of being invisible. Sorted by averageStars descending (unrated places last,
// same-average ties broken by win count) — a ratings screen is more useful ranked by "was it good"
// than by "how often did it win," which getTopWinningPlaces's own win-count order already covers.
export function getPlaceRatingSummaries(chatId: number): PlaceRatingSummary[] {
  const votesByPlace = new Map<string, PlaceVote[]>();
  for (const row of placeVotesStmt.all(chatId) as unknown as {
    place: string;
    userId: number;
    username: string;
    stars: number | null;
    ratedAt: number;
  }[]) {
    const votes = votesByPlace.get(row.place) ?? [];
    votes.push({ userId: row.userId, username: row.username, stars: row.stars, ratedAt: row.ratedAt });
    votesByPlace.set(row.place, votes);
  }

  return getTopWinningPlaces(chatId)
    .map(({ place, wins }) => {
      const votes = votesByPlace.get(place) ?? [];
      const starVotes = votes.filter((v) => v.stars !== null).map((v) => v.stars as number);
      const averageStars = starVotes.length > 0 ? starVotes.reduce((sum, s) => sum + s, 0) / starVotes.length : null;
      return { place, averageStars, ratingCount: starVotes.length, votes, wins };
    })
    .sort((a, b) => {
      if (a.averageStars === null && b.averageStars === null) return b.wins - a.wins;
      if (a.averageStars === null) return 1;
      if (b.averageStars === null) return -1;
      return b.averageStars - a.averageStars || b.wins - a.wins;
    })
    .map(({ place, averageStars, ratingCount, votes }) => ({ place, averageStars, ratingCount, votes }));
}
