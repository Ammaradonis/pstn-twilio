import { describe, expect, it } from 'vitest';

import {
  formatCallLength,
  formatDayHeading,
  formatDialInput,
  formatListTime,
  formatNumber,
  formatTimer,
  groupByDay,
  initials,
} from './format';

describe('voice formatting', () => {
  it('formats numbers like a phone', () => {
    expect(formatNumber('+18776524532')).toBe('(877) 652-4532');
    expect(formatNumber('+442045726501')).toBe('+44 20 4572 6501');
    expect(formatNumber('+447458904436')).toBe('+44 7458 904436');
    expect(formatNumber('client:Anonymous')).toBe('Unknown');
    expect(formatNumber(null)).toBe('Unknown');
  });

  it('formats dialer input as it is typed', () => {
    expect(formatDialInput('415')).toBe('415');
    expect(formatDialInput('41555')).toBe('(415) 55');
    expect(formatDialInput('4155550100')).toBe('(415) 555-0100');
    expect(formatDialInput('14155550100')).toBe('1 (415) 555-0100');
    expect(formatDialInput('+4420')).toBe('+4420');
    expect(formatDialInput('*67')).toBe('*67');
  });

  it("uses the device's local day for lists and headings", () => {
    const now = new Date(2026, 9, 5, 15, 0);
    const earlierToday = new Date(2026, 9, 5, 9, 30).toISOString();
    const yesterday = new Date(2026, 9, 4, 23, 59).toISOString();
    const lastYear = new Date(2025, 2, 1, 12, 0).toISOString();
    expect(formatListTime(earlierToday, now)).toMatch(/9:30/);
    expect(formatListTime(yesterday, now)).toBe('Yesterday');
    expect(formatListTime(lastYear, now)).toMatch(/2025/);
    expect(formatDayHeading(earlierToday, now)).toBe('Today');
    expect(formatDayHeading(yesterday, now)).toBe('Yesterday');
  });

  it('groups consecutive items by local day', () => {
    const items = [
      { at: new Date(2026, 9, 5, 10).toISOString() },
      { at: new Date(2026, 9, 5, 8).toISOString() },
      { at: new Date(2026, 9, 3, 22).toISOString() },
    ];
    const groups = groupByDay(items, (item) => item.at);
    expect(groups.map((g) => g.items.length)).toEqual([2, 1]);
  });

  it('formats lengths and initials', () => {
    expect(formatTimer(83)).toBe('1:23');
    expect(formatTimer(3725)).toBe('1:02:05');
    expect(formatCallLength(42)).toBe('42 sec');
    expect(formatCallLength(185)).toBe('3 min');
    expect(formatCallLength(0)).toBe('');
    expect(initials('jane van doe')).toBe('JD');
    expect(initials('+1 415')).toBe('');
  });
});
