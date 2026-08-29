import { listBlockedUsersInGroup } from './submissionService.js';
import { getLatestDraw, getSubmissionsForDraw, type HistorySubmission } from '../storage/history.js';
import {
  clearDrawPlaceOverride,
  getDrawPlaceOverride,
  setDrawPlaceOverride,
  type DrawPlaceOverride,
} from '../storage/drawPlaceOverride.js';
import {
  disableRatingSurvey,
  enableRatingSurvey,
  isRatingSurveyEnabled as isEnabled,
} from '../storage/ratingSurveyState.js';

export interface RatingSurveyContext {
  drawId: number;
  winnerPlace: string;
  recipients: HistorySubmission[];
}

// A blocked user shouldn't be asked to rate a place either, even if they submitted to this exact
// draw before being blocked — submissions_history is never retroactively edited by a later block
// (see "Interaction with blocking" in CLAUDE.md), so without this filter a since-blocked submitter
// would still receive the survey and still show up as a selectable target in /admin's picker.
// Same exclusion reminderService.ts's getNonSubmittersInfo already applies, for the identical reason.
//
// winnerPlace here is the *effective* survey place, not necessarily the actual draw winner: when an
// admin has set a manual override for this draw (see "Manual place override for the rating survey"
// in CLAUDE.md — the winner couldn't make it, the group went somewhere else on the list instead),
// that overridden place is returned here instead, so both the automatic/manual survey send and
// /admin's "Надіслати опитування зараз" preview screen see the corrected place with no changes of
// their own needed. This never touches the draw record itself — getTopWinningPlaces/isRepeatWinner
// keep reading the real winner_place, unaffected by any override.
export function getRatingSurveyContext(chatId: number): RatingSurveyContext | undefined {
  const draw = getLatestDraw(chatId);
  if (!draw?.winnerPlace) return undefined;

  const override = getDrawPlaceOverride(draw.id);
  const blockedIds = new Set(listBlockedUsersInGroup(chatId).map((b) => b.userId));
  const recipients = getSubmissionsForDraw(draw.id).filter((s) => !blockedIds.has(s.userId));

  return { drawId: draw.id, winnerPlace: override?.place ?? draw.winnerPlace, recipients };
}

export interface OverridePlaceResult {
  ok: boolean;
  reason?: 'no_draw' | 'invalid_submitter';
}

// Lets an admin correct which place the survey asks about, when the drawn winner falls through at
// the last minute and the group actually goes with a different place from that same week's
// submissions — see "Manual place override for the rating survey" in CLAUDE.md. Deliberately
// restricted to that week's actual submitters (submitterUserId), not a free-text place: the caller
// (commands/admin.ts) only ever offers a pick-from-list UI, never a typed link, so submitterUserId
// not resolving to an actual submission of the latest draw means a stale button, not a real place.
export function setSurveyPlaceOverride(chatId: number, submitterUserId: number, actorUserId: number): OverridePlaceResult {
  const draw = getLatestDraw(chatId);
  if (!draw) return { ok: false, reason: 'no_draw' };

  const submission = getSubmissionsForDraw(draw.id).find((s) => s.userId === submitterUserId);
  if (!submission) return { ok: false, reason: 'invalid_submitter' };

  setDrawPlaceOverride(draw.id, submission.place, submitterUserId, actorUserId);
  return { ok: true };
}

// Returns the survey target to the algorithmic draw winner. A no-op if nothing was overridden (or
// there's no draw at all yet) — same "harmless when tapped stale" tolerance as /admin's other
// reset-style actions (e.g. "🔓 Відкрити прийом заявок" has no "already unlocked" guard either).
export function clearSurveyPlaceOverride(chatId: number): void {
  const draw = getLatestDraw(chatId);
  if (!draw) return;
  clearDrawPlaceOverride(draw.id);
}

// Read-only lookup for /admin's picker screen, to show whether the latest draw currently has an
// override and, if so, which submitter it points at (for the ✅ checkmark on that submitter's row).
export function getSurveyPlaceOverride(chatId: number): DrawPlaceOverride | undefined {
  const draw = getLatestDraw(chatId);
  if (!draw) return undefined;
  return getDrawPlaceOverride(draw.id);
}

export function isRatingSurveyEnabled(chatId: number): boolean {
  return isEnabled(chatId);
}

export function setRatingSurveyEnabled(chatId: number, enabled: boolean): void {
  if (enabled) {
    enableRatingSurvey(chatId);
  } else {
    disableRatingSurvey(chatId);
  }
}
