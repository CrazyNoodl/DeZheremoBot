import { listBlockedUsersInGroup } from './submissionService.js';
import { getLatestDraw, getSubmissionsForDraw, type HistorySubmission } from '../storage/history.js';
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
export function getRatingSurveyContext(chatId: number): RatingSurveyContext | undefined {
  const draw = getLatestDraw(chatId);
  if (!draw?.winnerPlace) return undefined;

  const blockedIds = new Set(listBlockedUsersInGroup(chatId).map((b) => b.userId));
  const recipients = getSubmissionsForDraw(draw.id).filter((s) => !blockedIds.has(s.userId));

  return { drawId: draw.id, winnerPlace: draw.winnerPlace, recipients };
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
