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

// Used by /admin's audit log viewer to render admin_actions.created_at (a raw epoch ms) as a
// readable Kyiv timestamp, independent of the server's own timezone.
const kyivDateTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  hourCycle: 'h23',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatKyivDateTime(ms: number): string {
  const parts = kyivDateTimeFormatter.formatToParts(new Date(ms));
  const day = parts.find((p) => p.type === 'day')!.value;
  const month = parts.find((p) => p.type === 'month')!.value;
  const hour = parts.find((p) => p.type === 'hour')!.value;
  const minute = parts.find((p) => p.type === 'minute')!.value;
  return `${day}.${month} ${hour}:${minute}`;
}

// Same day/month, without the time — used by /admin's "⭐ Оцінки місць" tab to label each vote for
// a repeat-winning place with which visit it belongs to (a bare "was there"/star count alone reads
// as an accidental duplicate rather than two separate weeks).
export function formatKyivDate(ms: number): string {
  const parts = kyivDateTimeFormatter.formatToParts(new Date(ms));
  const day = parts.find((p) => p.type === 'day')!.value;
  const month = parts.find((p) => p.type === 'month')!.value;
  return `${day}.${month}`;
}

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
