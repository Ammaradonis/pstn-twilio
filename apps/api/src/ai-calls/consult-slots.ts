import { addDays, spokenDateTime, zonedParts, zonedTimeToUtc } from './zoned-time';

export interface ConsultSchedule {
  durationMinutes: number;
  // Slots start on multiples of this many minutes past the hour.
  stepMinutes: number;
  // Prospect-local hours a consultation may start and must end by.
  dayStartHour: number;
  dayEndHour: number;
  // Prospect-local weekdays, 0 = Sunday ... 6 = Saturday.
  weekdays: number[];
  minLeadMinutes: number;
  horizonDays: number;
  // Free time kept around existing calendar events.
  bufferMinutes: number;
}

export interface BusyInterval {
  start: Date;
  end: Date;
}

export type PartOfDay = 'morning' | 'afternoon' | 'any';

export interface SlotPreference {
  // Prospect-local date, YYYY-MM-DD.
  date?: string;
  partOfDay?: PartOfDay;
}

export interface ConsultSlot {
  start: Date;
  end: Date;
  spoken: string;
}

const NOON = 12;

function parseDate(value: string | undefined): { year: number; month: number; day: number } | null {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function overlapsBusy(start: Date, end: Date, busy: BusyInterval[], bufferMs: number): boolean {
  return busy.some(
    (b) =>
      start.getTime() < b.end.getTime() + bufferMs && end.getTime() > b.start.getTime() - bufferMs,
  );
}

// Every free slot in the scheduling window, earliest first.
export function freeConsultSlots(
  now: Date,
  timeZone: string,
  schedule: ConsultSchedule,
  busy: BusyInterval[],
  preference: SlotPreference = {},
): ConsultSlot[] {
  const earliest = now.getTime() + schedule.minLeadMinutes * 60_000;
  const bufferMs = schedule.bufferMinutes * 60_000;
  const durationMs = schedule.durationMinutes * 60_000;
  const today = zonedParts(now, timeZone);
  const preferredDate = parseDate(preference.date);
  const partOfDay = preference.partOfDay ?? 'any';
  const slots: ConsultSlot[] = [];

  for (let offset = 0; offset <= schedule.horizonDays; offset += 1) {
    const date = addDays(today, offset);
    if (!schedule.weekdays.includes(date.weekday)) continue;
    if (
      preferredDate &&
      (date.year !== preferredDate.year ||
        date.month !== preferredDate.month ||
        date.day !== preferredDate.day)
    ) {
      continue;
    }

    for (
      let minutes = schedule.dayStartHour * 60;
      minutes + schedule.durationMinutes <= schedule.dayEndHour * 60;
      minutes += schedule.stepMinutes
    ) {
      const hour = Math.floor(minutes / 60);
      if (partOfDay === 'morning' && hour >= NOON) continue;
      if (partOfDay === 'afternoon' && hour < NOON) continue;

      const start = zonedTimeToUtc({ ...date, hour, minute: minutes % 60 }, timeZone);
      // A wall time skipped by daylight saving resolves to a different hour.
      if (zonedParts(start, timeZone).hour !== hour) continue;
      if (start.getTime() < earliest) continue;
      const end = new Date(start.getTime() + durationMs);
      if (overlapsBusy(start, end, busy, bufferMs)) continue;
      slots.push({ start, end, spoken: spokenDateTime(start, timeZone) });
    }
  }
  return slots;
}

// A short menu to read out: the first free slot, then the first slot on each
// following day, so the prospect hears different days rather than
// back-to-back half hours.
export function pickSlotOptions(slots: ConsultSlot[], timeZone: string, max = 3): ConsultSlot[] {
  const picked: ConsultSlot[] = [];
  const days = new Set<string>();
  for (const slot of slots) {
    const p = zonedParts(slot.start, timeZone);
    const key = `${p.year}-${p.month}-${p.day}`;
    if (days.has(key)) continue;
    days.add(key);
    picked.push(slot);
    if (picked.length === max) return picked;
  }
  // Fewer days than options: fill from the remaining slots in order.
  for (const slot of slots) {
    if (picked.length === max) break;
    if (!picked.includes(slot)) picked.push(slot);
  }
  return picked.sort((a, b) => a.start.getTime() - b.start.getTime());
}

// Whether a requested start is still a valid, free slot.
export function isBookableSlot(
  start: Date,
  now: Date,
  timeZone: string,
  schedule: ConsultSchedule,
  busy: BusyInterval[],
): boolean {
  const p = zonedParts(start, timeZone);
  const date = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  return freeConsultSlots(now, timeZone, schedule, busy, { date }).some(
    (slot) => slot.start.getTime() === start.getTime(),
  );
}
