import { describe, expect, it } from 'vitest';

import {
  freeConsultSlots,
  isBookableSlot,
  pickSlotOptions,
  type ConsultSchedule,
} from './consult-slots';
import { localNowText, spokenDateTime, zonedParts, zonedTimeToUtc } from './zoned-time';

const CHICAGO = 'America/Chicago';

const schedule: ConsultSchedule = {
  durationMinutes: 20,
  stepMinutes: 30,
  dayStartHour: 9,
  dayEndHour: 18,
  weekdays: [1, 2, 3, 4, 5],
  minLeadMinutes: 120,
  horizonDays: 10,
  bufferMinutes: 10,
};

describe('zoned time', () => {
  it('converts Central wall time to UTC across daylight saving', () => {
    // CDT (UTC-5) in September, CST (UTC-6) in December.
    expect(
      zonedTimeToUtc({ year: 2026, month: 9, day: 15, hour: 10, minute: 0 }, CHICAGO).toISOString(),
    ).toBe('2026-09-15T15:00:00.000Z');
    expect(
      zonedTimeToUtc(
        { year: 2026, month: 12, day: 15, hour: 10, minute: 0 },
        CHICAGO,
      ).toISOString(),
    ).toBe('2026-12-15T16:00:00.000Z');
  });

  it('handles the fall-back and spring-forward days', () => {
    // 2026-11-01: clocks fall back at 2 AM. 9 AM that day is CST.
    expect(
      zonedTimeToUtc({ year: 2026, month: 11, day: 1, hour: 9, minute: 0 }, CHICAGO).toISOString(),
    ).toBe('2026-11-01T15:00:00.000Z');
    // 2026-03-08: clocks spring forward at 2 AM. 9 AM that day is CDT.
    expect(
      zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 9, minute: 30 }, CHICAGO).toISOString(),
    ).toBe('2026-03-08T14:30:00.000Z');
  });

  it('reads parts and speaks times in the prospect zone', () => {
    const instant = new Date('2026-09-15T15:30:00Z');
    expect(zonedParts(instant, CHICAGO)).toMatchObject({ hour: 10, minute: 30, weekday: 2 });
    expect(spokenDateTime(instant, CHICAGO)).toBe('Tuesday, September 15 at 10:30 AM');
    expect(spokenDateTime(new Date('2026-09-15T15:00:00Z'), CHICAGO)).toBe(
      'Tuesday, September 15 at 10 AM',
    );
    expect(localNowText(instant, CHICAGO)).toBe('Tuesday, September 15, 2026 at 10:30 AM');
  });
});

describe('freeConsultSlots', () => {
  // Monday 2026-09-14, 1:33 PM Central.
  const now = new Date('2026-09-14T18:33:00Z');

  it('starts after the lead time, inside prospect-local business hours, on weekdays', () => {
    const slots = freeConsultSlots(now, CHICAGO, schedule, []);
    // Earliest: 1:33 PM + 2h = 3:33 PM, so 4:00 PM. Last start: 5:30 PM (ends 5:50).
    expect(slots[0]!.spoken).toBe('Monday, September 14 at 4 PM');
    expect(
      slots.filter((s) => zonedParts(s.start, CHICAGO).day === 14).map((s) => s.spoken),
    ).toEqual([
      'Monday, September 14 at 4 PM',
      'Monday, September 14 at 4:30 PM',
      'Monday, September 14 at 5 PM',
      'Monday, September 14 at 5:30 PM',
    ]);
    for (const slot of slots) {
      const p = zonedParts(slot.start, CHICAGO);
      expect(p.weekday).toBeGreaterThanOrEqual(1);
      expect(p.weekday).toBeLessThanOrEqual(5);
      expect(p.hour).toBeGreaterThanOrEqual(9);
      expect(slot.end.getTime() - slot.start.getTime()).toBe(20 * 60_000);
      expect(
        zonedParts(slot.end, CHICAGO).hour * 60 + zonedParts(slot.end, CHICAGO).minute,
      ).toBeLessThanOrEqual(18 * 60);
    }
    // Saturday the 19th and Sunday the 20th are skipped.
    expect(slots.some((s) => [19, 20].includes(zonedParts(s.start, CHICAGO).day))).toBe(false);
  });

  it('keeps a buffer around busy calendar time', () => {
    const busy = [
      // Tuesday 10:00-11:00 AM Central.
      { start: new Date('2026-09-15T15:00:00Z'), end: new Date('2026-09-15T16:00:00Z') },
    ];
    const tuesday = freeConsultSlots(now, CHICAGO, schedule, busy, { date: '2026-09-15' }).map(
      (s) => s.spoken,
    );
    // 9:30 ends 9:50, exactly the 10-minute buffer before 10:00: allowed.
    // 11:00 starts right at the busy end, inside the buffer: blocked.
    expect(tuesday).toContain('Tuesday, September 15 at 9 AM');
    expect(tuesday).toContain('Tuesday, September 15 at 9:30 AM');
    expect(tuesday).not.toContain('Tuesday, September 15 at 10 AM');
    expect(tuesday).not.toContain('Tuesday, September 15 at 11 AM');
    expect(tuesday).toContain('Tuesday, September 15 at 11:30 AM');
  });

  it('filters by morning or afternoon on a preferred date', () => {
    const mornings = freeConsultSlots(now, CHICAGO, schedule, [], {
      date: '2026-09-16',
      partOfDay: 'morning',
    });
    expect(mornings.map((s) => zonedParts(s.start, CHICAGO).hour)).toEqual([9, 9, 10, 10, 11, 11]);
    const afternoons = freeConsultSlots(now, CHICAGO, schedule, [], {
      date: '2026-09-16',
      partOfDay: 'afternoon',
    });
    expect(afternoons.every((s) => zonedParts(s.start, CHICAGO).hour >= 12)).toBe(true);
    expect(freeConsultSlots(now, CHICAGO, schedule, [], { date: '2026-09-19' })).toEqual([]);
  });

  it('uses the zone it is given', () => {
    const eastern = freeConsultSlots(now, 'America/New_York', schedule, []);
    // 2:33 PM Eastern + 2h = 4:33 PM, so 5:00 PM Eastern.
    expect(eastern[0]!.spoken).toBe('Monday, September 14 at 5 PM');
  });
});

describe('pickSlotOptions', () => {
  const now = new Date('2026-09-14T18:33:00Z');

  it('offers the first slot and then the first slot of following days', () => {
    const options = pickSlotOptions(freeConsultSlots(now, CHICAGO, schedule, []), CHICAGO);
    expect(options.map((o) => o.spoken)).toEqual([
      'Monday, September 14 at 4 PM',
      'Tuesday, September 15 at 9 AM',
      'Wednesday, September 16 at 9 AM',
    ]);
  });

  it('fills from one day when that is all there is', () => {
    const slots = freeConsultSlots(now, CHICAGO, schedule, [], { date: '2026-09-16' });
    expect(pickSlotOptions(slots, CHICAGO).map((o) => o.spoken)).toEqual([
      'Wednesday, September 16 at 9 AM',
      'Wednesday, September 16 at 9:30 AM',
      'Wednesday, September 16 at 10 AM',
    ]);
  });
});

describe('isBookableSlot', () => {
  const now = new Date('2026-09-14T18:33:00Z');

  it('accepts a free slot and rejects taken, off-grid, and too-soon starts', () => {
    const busy = [
      { start: new Date('2026-09-15T15:00:00Z'), end: new Date('2026-09-15T16:00:00Z') },
    ];
    expect(isBookableSlot(new Date('2026-09-15T14:00:00Z'), now, CHICAGO, schedule, busy)).toBe(
      true,
    );
    expect(isBookableSlot(new Date('2026-09-15T15:00:00Z'), now, CHICAGO, schedule, busy)).toBe(
      false,
    );
    expect(isBookableSlot(new Date('2026-09-15T14:10:00Z'), now, CHICAGO, schedule, busy)).toBe(
      false,
    );
    expect(isBookableSlot(new Date('2026-09-14T19:00:00Z'), now, CHICAGO, schedule, busy)).toBe(
      false,
    );
  });
});
