import {
  getGroupSchedule,
  resetGroupSchedule,
  setGroupSchedule,
  type GroupScheduleConfig,
} from '../storage/groupSchedules.js';

export type { GroupScheduleConfig };

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// 1 to 5 hour options on the availability poll's hour screen — 0 is also valid (means the hour
// screen is skipped entirely) but that's the empty array, not a MIN constant to check against.
export const MAX_TIME_SLOTS = 5;

export type UpdateResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'invalid_time' | 'draw_before_lock' | 'reminder_after_lock' | 'timeslot_deadline_conflict' | 'too_many_time_slots';
    };

export function isValidTime(value: string): boolean {
  return TIME_RE.test(value);
}

export function getSchedule(chatId: number): GroupScheduleConfig {
  return getGroupSchedule(chatId);
}

// There's no fixed reminder count (a group can configure any number of reminderWeekdays), so
// "the last reminder before the deadline" is identified positionally: whichever configured weekday
// falls fewest days before deadlineWeekday, cycling through the week. When a reminder lands on
// deadlineWeekday itself (the common case) that's a same-day distance of 0, which always wins.
export function getFinalReminderWeekday(config: GroupScheduleConfig): number {
  return config.reminderWeekdays.reduce((closest, weekday) => {
    const distance = (config.deadlineWeekday - weekday + 7) % 7;
    const closestDistance = (config.deadlineWeekday - closest + 7) % 7;
    return distance < closestDistance ? weekday : closest;
  });
}

// Mirrors getFinalReminderWeekday's own "distance from deadlineWeekday, cycling through the week"
// measure rather than comparing raw weekday numbers (0=Sun would otherwise look "first" even when
// it's chronologically the last reminder before a Monday deadline): the first reminder is whichever
// configured weekday is *farthest* from deadlineWeekday going in the same cyclic direction. Only
// meaningful when there's more than one reminder configured — with just one, it's also the final
// reminder, so callers gate on reminderWeekdays.length > 1 rather than comparing the two results.
export function getFirstReminderWeekday(config: GroupScheduleConfig): number {
  return config.reminderWeekdays.reduce((farthest, weekday) => {
    const distance = (config.deadlineWeekday - weekday + 7) % 7;
    const farthestDistance = (config.deadlineWeekday - farthest + 7) % 7;
    return distance > farthestDistance ? weekday : farthest;
  });
}

// A reminder that lands on the deadline weekday at/after lockTime would tell people to add a
// place after submissions are already closed — catches that regardless of which side (reminder
// or deadline) is the one being edited, since either edit can create the conflict.
function reminderConflictsWithLock(config: GroupScheduleConfig): boolean {
  return config.reminderWeekdays.includes(config.deadlineWeekday) && config.reminderTime >= config.lockTime;
}

export function updateReminderSchedule(chatId: number, weekdays: number[], time: string): UpdateResult {
  if (!isValidTime(time)) return { ok: false, reason: 'invalid_time' };

  const current = getGroupSchedule(chatId);
  const next = { ...current, reminderWeekdays: weekdays, reminderTime: time };
  if (reminderConflictsWithLock(next)) return { ok: false, reason: 'reminder_after_lock' };

  setGroupSchedule(chatId, next);
  return { ok: true };
}

export function updateDeadlineSchedule(
  chatId: number,
  weekday: number,
  lockTime: string,
  drawTime: string,
): UpdateResult {
  if (!isValidTime(lockTime) || !isValidTime(drawTime)) return { ok: false, reason: 'invalid_time' };
  if (drawTime <= lockTime) return { ok: false, reason: 'draw_before_lock' };

  const current = getGroupSchedule(chatId);
  // The availability poll only ever offers days after the deadline (see
  // updateTimeSlotPollWeekdays below) — moving the deadline onto a day already configured there
  // would leave that config silently inconsistent, so this is rejected the same way a
  // reminder/lock conflict already is, rather than the poll's config being left to drift.
  if (current.timeSlotPollWeekdays.includes(weekday)) return { ok: false, reason: 'timeslot_deadline_conflict' };

  const next = { ...current, deadlineWeekday: weekday, lockTime, drawTime };
  if (reminderConflictsWithLock(next)) return { ok: false, reason: 'reminder_after_lock' };

  setGroupSchedule(chatId, next);
  return { ok: true };
}

export function resetSchedule(chatId: number): void {
  resetGroupSchedule(chatId);
}

// No cross-field conflict is possible here the way reminder/deadline can conflict with each other:
// the survey always targets the most recently completed draw, which is always in the past relative
// to any future occurrence of any weekday/time, so 'invalid_time' is the only failure mode.
export function updateRatingSurveySchedule(chatId: number, weekday: number, time: string): UpdateResult {
  if (!isValidTime(time)) return { ok: false, reason: 'invalid_time' };

  const current = getGroupSchedule(chatId);
  setGroupSchedule(chatId, { ...current, ratingSurveyWeekday: weekday, ratingSurveyTime: time });
  return { ok: true };
}

// Because weekdays are cyclic, "must start the day after the deadline" reduces to a simple
// exclusion: every day except deadlineWeekday itself already falls after this week's deadline and
// before next week's (e.g. for a Friday deadline, Sat through Thu all qualify — only Friday
// doesn't). The UI enforces "at least 1 day selected" itself (mirroring updateReminderSchedule,
// which doesn't check that here either); this only guards the deadline-day exclusion.
export function updateTimeSlotPollWeekdays(chatId: number, weekdays: number[]): UpdateResult {
  const current = getGroupSchedule(chatId);
  if (weekdays.includes(current.deadlineWeekday)) return { ok: false, reason: 'timeslot_deadline_conflict' };

  setGroupSchedule(chatId, { ...current, timeSlotPollWeekdays: weekdays });
  return { ok: true };
}

// Times are built up incrementally in commands/schedule.ts's wizard (add/remove one at a time,
// validated there before this is called with the final list) — this re-validates defensively
// rather than trusting the caller blindly.
export function updateTimeSlotPollTimes(chatId: number, times: string[]): UpdateResult {
  if (times.some((t) => !isValidTime(t))) return { ok: false, reason: 'invalid_time' };
  if (times.length > MAX_TIME_SLOTS) return { ok: false, reason: 'too_many_time_slots' };

  const current = getGroupSchedule(chatId);
  setGroupSchedule(chatId, { ...current, timeSlotPollTimes: times });
  return { ok: true };
}
