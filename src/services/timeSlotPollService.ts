import { getSchedule } from './scheduleService.js';
import { listBlockedUsersInGroup } from './submissionService.js';
import {
  disableTimeSlotPoll,
  enableTimeSlotPoll,
  isTimeSlotPollEnabled as isEnabled,
} from '../storage/timeSlotPollState.js';
import { listTimeSlotResponses } from '../storage/timeSlotResponses.js';

export function isTimeSlotPollEnabled(chatId: number): boolean {
  return isEnabled(chatId);
}

export function setTimeSlotPollEnabled(chatId: number, enabled: boolean): void {
  if (enabled) {
    enableTimeSlotPoll(chatId);
  } else {
    disableTimeSlotPoll(chatId);
  }
}

export interface TimeSlotSuggestion {
  day: number;
  time: string | undefined; // undefined when this chat's poll has no configured hours at all
}

// A single day + single hour suggestion, not a ranked list — a lightweight nudge for the winner
// announcement ("if this doesn't work for someone, arrange separately"), not a vote tally. Returns
// undefined when the poll is disabled for this chat or nobody answered at all this week.
export function getTimeSlotSuggestion(chatId: number): TimeSlotSuggestion | undefined {
  if (!isEnabled(chatId)) return undefined;

  const schedule = getSchedule(chatId);
  const blockedIds = new Set(listBlockedUsersInGroup(chatId).map((b) => b.userId));
  const responses = listTimeSlotResponses(chatId).filter((r) => !blockedIds.has(r.userId));
  if (responses.length === 0) return undefined;

  const dayVotes = new Map<number, number>(schedule.timeSlotPollWeekdays.map((d) => [d, 0]));
  for (const response of responses) {
    if (response.daysAny) {
      for (const day of schedule.timeSlotPollWeekdays) dayVotes.set(day, (dayVotes.get(day) ?? 0) + 1);
    } else {
      for (const day of response.days) {
        if (dayVotes.has(day)) dayVotes.set(day, (dayVotes.get(day) ?? 0) + 1);
      }
    }
  }

  const bestDay = schedule.timeSlotPollWeekdays.reduce((best, day) => {
    const votes = dayVotes.get(day) ?? 0;
    const bestVotes = dayVotes.get(best) ?? 0;
    if (votes !== bestVotes) return votes > bestVotes ? day : best;
    // Tie-break: closer to the deadline, measured *forward from the deadline* to this weekday —
    // the mirror image of scheduleService.ts's getFinalReminderWeekday distance measure (that one
    // measures forward from a candidate weekday *to* the deadline, ranking days before it; poll
    // days all fall after the deadline, so the direction has to flip).
    const distance = (day - schedule.deadlineWeekday + 7) % 7;
    const bestDistance = (best - schedule.deadlineWeekday + 7) % 7;
    return distance < bestDistance ? day : best;
  });

  let bestTime: string | undefined;
  if (schedule.timeSlotPollTimes.length > 0) {
    const timeVotes = new Map<string, number>(schedule.timeSlotPollTimes.map((t) => [t, 0]));
    for (const response of responses) {
      if (response.timesAny) {
        for (const time of schedule.timeSlotPollTimes) timeVotes.set(time, (timeVotes.get(time) ?? 0) + 1);
      } else {
        for (const time of response.times) {
          if (timeVotes.has(time)) timeVotes.set(time, (timeVotes.get(time) ?? 0) + 1);
        }
      }
    }

    bestTime = schedule.timeSlotPollTimes.reduce((best, time) => {
      const votes = timeVotes.get(time) ?? 0;
      const bestVotes = timeVotes.get(best) ?? 0;
      if (votes !== bestVotes) return votes > bestVotes ? time : best;
      return time < best ? time : best; // earliest wins on a tie — plain string compare is correct for zero-padded HH:MM
    });
  }

  return { day: bestDay, time: bestTime };
}
