const TIMEZONE = 'Europe/Kyiv';

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const kyivFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  hourCycle: 'h23',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

// en-CA formats dates as YYYY-MM-DD by default — used as the "which day is this" key for
// fired_events, so a fired reminder/lock/draw is tied to a specific calendar day, not just a
// weekday that recurs every week.
const kyivDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// Shared by scheduler.ts's per-minute tick and commands/schedule.ts's admin "force draw now"
// action — both need the same notion of "today" in Kyiv time to mark fired_events consistently,
// independent of the server's own timezone.
export function getKyivNow(): { weekday: number; time: string; date: string } {
  const now = new Date();
  const parts = kyivFormatter.formatToParts(now);
  const weekdayName = parts.find((p) => p.type === 'weekday')!.value;
  const hour = parts.find((p) => p.type === 'hour')!.value;
  const minute = parts.find((p) => p.type === 'minute')!.value;

  return { weekday: WEEKDAY_INDEX[weekdayName], time: `${hour}:${minute}`, date: kyivDateFormatter.format(now) };
}
