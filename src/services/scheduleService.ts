import {
  getGroupSchedule,
  resetGroupSchedule,
  setGroupSchedule,
  type GroupScheduleConfig,
} from '../storage/groupSchedules.js';

export type { GroupScheduleConfig };

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export type UpdateResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_time' | 'draw_before_lock' | 'reminder_after_lock' };

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
  const next = { ...current, deadlineWeekday: weekday, lockTime, drawTime };
  if (reminderConflictsWithLock(next)) return { ok: false, reason: 'reminder_after_lock' };

  setGroupSchedule(chatId, next);
  return { ok: true };
}

export function resetSchedule(chatId: number): void {
  resetGroupSchedule(chatId);
}
