/**
 * Small pure helpers for the Sheets module.
 */

/**
 * Format a moment as "5:45pm" in the given IANA time zone. Intl applies the
 * zone's DST rules for that date, so clock changes need no special handling.
 */
export function formatLocalTime(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('hour')}:${get('minute')}${get('dayPeriod').toLowerCase()}`;
}

/** Weekday name ("Monday") of a moment in the given time zone. */
export function formatLocalWeekday(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(date);
}

/**
 * A phone number the way a local reader writes it: no country code, digits
 * only. +442045726501 → 02045726501, +16672206726 → 6672206726.
 */
export function stripCountryCode(e164: string): string {
  return nationalDigits(e164) ?? e164.replace(/\D/g, '');
}

/**
 * National digits of a US/UK number written in any common format, so that
 * "+1 (205) 555-1234", "205.555.1234" and "12055551234" all compare equal,
 * as do "+44 20 4572 6501" and "020 4572 6501". Returns null for text that
 * isn't a plausible phone number.
 */
export function nationalDigits(raw: string): string | null {
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  // UK written as "+44 (0)20 …".
  if (digits.startsWith('440') && digits.length === 13) return `0${digits.slice(3)}`;
  // UK with country code: 44 + 10 digits (the trunk 0 is dropped).
  if (digits.startsWith('44') && digits.length === 12) return `0${digits.slice(2)}`;
  // UK national: 0 + 10 digits.
  if (digits.startsWith('0') && digits.length === 11) return digits;
  // NANP with country code.
  if (digits.startsWith('1') && digits.length === 11) return digits.slice(1);
  // NANP national.
  if (digits.length === 10) return digits;
  return null;
}

/**
 * True when a sheet cell holds the given number. A cell may list more than
 * one number ("205-555-1234 / 205-555-9999"), so each piece is checked.
 */
export function cellHasPhone(cell: string, target: string): boolean {
  if (!cell.trim()) return false;
  const pieces = [cell, ...cell.split(/[/,;|\n]|\bor\b|\s{2,}/i)];
  return pieces.some((piece) => {
    if (nationalDigits(piece) === target) return true;
    // Sheets turns a typed 02045726501 into the number 2045726501.
    return target.startsWith('0') && piece.replace(/\D/g, '') === target.slice(1);
  });
}

/** Header text reduced to lowercase letters and digits ("E-mail Address" → "emailaddress"). */
export function normalizeHeader(header: unknown): string {
  return String(header ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** A1 range for a whole tab or a single cell, with the tab name quoted. */
export function a1(sheetTitle: string, cell?: string): string {
  const quoted = `'${sheetTitle.replace(/'/g, "''")}'`;
  return cell ? `${quoted}!${cell}` : quoted;
}

/** 1-based column index to A1 letters: 1 → A, 27 → AA. */
export function columnLetter(col: number): string {
  let s = '';
  let n = col;
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

/** First email address found in a cell, or null. */
export function extractEmail(cell: string): string | null {
  return EMAIL_RE.exec(cell)?.[0] ?? null;
}
