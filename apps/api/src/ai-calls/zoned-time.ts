// Wall-clock arithmetic in an IANA time zone using only Intl, so daylight
// saving transitions follow the runtime's tz database.

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  // 0 = Sunday ... 6 = Saturday
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function zonedParts(date: Date, timeZone: string): ZonedParts & { second: number } {
  const values: Record<string, string> = {};
  for (const part of formatterFor(timeZone).formatToParts(date)) values[part.type] = part.value;
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    weekday: WEEKDAYS[values.weekday] ?? 0,
  };
}

// Milliseconds the zone is ahead of UTC at `date`.
function offsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// The instant a wall-clock time occurs in `timeZone`. A time skipped by a
// spring-forward transition resolves to the instant just after the gap.
export function zonedTimeToUtc(
  wall: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): Date {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const first = guess - offsetMs(new Date(guess), timeZone);
  const second = guess - offsetMs(new Date(first), timeZone);
  return new Date(second);
}

// Calendar date `days` after the given wall date (no time zone involved).
export function addDays(
  date: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number; weekday: number } {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
  };
}

// "Tuesday, September 15 at 10 AM" / "... at 10:30 AM", in the given zone.
export function spokenDateTime(date: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(date);
  const { minute } = zonedParts(date, timeZone);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    ...(minute === 0 ? {} : { minute: '2-digit' }),
    hour12: true,
  }).format(date);
  return `${day} at ${time}`;
}

// "Monday, September 14, 2026, 1:33 PM" in the given zone.
export function localNowText(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}
