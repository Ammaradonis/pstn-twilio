/**
 * Sequence variables from a lead's sheet row and the Status cell written for
 * the call. Rows are keyed by normalized header ("websiteUrl" → "websiteurl").
 *
 *   {{school_name}}  title                      {{called_number}} the number dialed
 *   {{website}}      websiteUrl (bare domain)   {{my_number}}     Status "from: …"
 *   {{rating}}       rating                     {{call_time}}     Status "time: …" + weekday
 *   {{review_count}} reviewCount                {{call_note}}     Status note
 *   {{category}}     category (lowercase)       {{street}}        address, street name only
 *   {{city}}         address (US: before the state, UK: before the postcode)
 *   {{state}}        US: state from the address. UK has no states, and "target"
 *                    is the search area rather than the school's county, so the
 *                    town is used instead.
 */

import { CALL_STATUS_TAGS, US_STATES } from '@pstn-twilio/shared';

import type { Region, SequenceVars } from './follow-up-sequences';
import { parseUsAddress } from './sheets-timezone.service';
import { formatLocalTime, formatLocalWeekday, nationalDigits } from './sheets.util';

export type RowData = Record<string, string>;

export interface FollowUpContext {
  spreadsheetId: string;
  sheetTitle: string;
  destinationE164: string;
  callerE164: string;
  cellValue: string;
  customNote: string | null;
  schoolName: string | null;
  callEndedAt: Date;
  timeZone: string;
}

export interface SheetRegions {
  usSheetId: string;
  ukSheetId: string;
}

/** U.S. Conquest emails use the US demo line, The Official UK the UK one; others go by the lead's number. */
export function regionFor(
  ctx: { spreadsheetId: string; destinationE164: string },
  sheets: SheetRegions,
): Region {
  if (ctx.spreadsheetId === sheets.ukSheetId) return 'UK';
  if (ctx.spreadsheetId === sheets.usSheetId) return 'US';
  return ctx.destinationE164.replace(/\s/g, '').startsWith('+44') ? 'UK' : 'US';
}

export interface ParsedStatus {
  tags: string[];
  note: string | null;
  from: string | null;
  time: string | null;
  weekday: string | null;
}

const TAGS_LONGEST_FIRST = [...CALL_STATUS_TAGS].sort((a, b) => b.length - a.length);

/**
 * "Rang out, Voicemail, <note>, from: 02045726501, time: 10:28am on a Monday"
 * → tags, note, caller and time. Older cells have no weekday.
 */
export function parseStatusCell(cell: string): ParsedStatus {
  let rest = cell.replace(/\s+/g, ' ').trim();
  let time: string | null = null;
  let weekday: string | null = null;
  let from: string | null = null;

  const timeMatch =
    /,?\s*time:\s*(\d{1,2}:\d{2}\s*[ap]\.?m\.?)(?:\s+on\s+(?:a\s+)?([a-z]+day))?\s*$/i.exec(rest);
  if (timeMatch) {
    time = timeMatch[1]!.replace(/\s|\./g, '').toLowerCase();
    weekday = timeMatch[2] ? capitalize(timeMatch[2]) : null;
    rest = rest.slice(0, timeMatch.index).trim();
  }
  const fromMatch = /,?\s*from:\s*([+\d][\d\s()+.-]*)$/i.exec(rest);
  if (fromMatch) {
    from = fromMatch[1]!.trim();
    rest = rest.slice(0, fromMatch.index).trim();
  }

  const tags: string[] = [];
  for (;;) {
    const lower = rest.toLowerCase();
    const tag = TAGS_LONGEST_FIRST.find(
      (t) => lower.startsWith(t.toLowerCase()) && /^(,|$)/.test(rest.slice(t.length).trimStart()),
    );
    if (!tag) break;
    tags.push(tag);
    rest = rest
      .slice(tag.length)
      .replace(/^\s*,\s*/, '')
      .trim();
  }
  return { tags, note: rest.replace(/^,\s*/, '').trim() || null, from, time, weekday };
}

const STREET_SUFFIX =
  /\b(st|street|rd|road|ave|avenue|blvd|boulevard|dr|drive|ln|lane|way|wy|pkwy|parkway|hwy|highway|ct|court|pl|place|cir|circle|ter|terrace|sq|square|pike|trl|trail|loop|row|close|cl|crescent|cres|grove|gr|hill|gardens|gdns|walk|mews|parade|pde|broadway|green|vale|rise|bypass|esplanade|plaza|fwy|freeway|expy|route|rte|run|pass|crossing|xing|turnpike|tpke|causeway|alley|aly|commons|hollow)\.?$/i;
const UNIT_TAIL =
  /\s+(?:suite|ste|unit|apt|apartment|bldg|building|floor|fl|room|rm|#)\b\.?\s*[\w-]*.*$|\s+#\s*\w+.*$/i;
const UK_POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;
// Only as its own word: "Skipton BD23 1US" ends in a postcode, not a country.
const COUNTRY_TAIL =
  /(?:^|,|\s)(?:usa|us|u\.s\.a?\.?|united states(?: of america)?|uk|u\.k\.|united kingdom|england|scotland|wales|northern ireland)\.?\s*$/i;
// A segment that is only a unit ("Unit E", "Ground floor"), not "Unit 7 Barfield Cl".
const UNIT_ONLY =
  /^(?:(?:unit|suite|ste|flat|apt|#)\s*[\w-]*|(?:ground|first|second|top)?\s*floor)$/i;

function cleanStreet(segment: string): string {
  return segment
    .replace(UNIT_TAIL, '')
    .replace(/^(?:unit|suite|ste|#)\s*[\w-]+\s+/i, '')
    .replace(/^\d+[a-z]?(?:\s*[-–/]\s*\d+[a-z]?)?\s+/i, '')
    .trim();
}

function addressSegments(address: string): string[] {
  return address
    .replace(/\s+/g, ' ')
    .replace(COUNTRY_TAIL, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "8910 SW 34th Ave Suite 500, Amarillo, TX 79124" → "SW 34th Ave". */
export function streetFromAddress(address: string, region: Region): string | null {
  const segments = addressSegments(address);
  // Drop the trailing locality: "City, ST 12345" (US) or "Town POSTCODE" (UK).
  let localityStart = segments.length;
  if (region === 'US') {
    const city = parseUsAddress(address).city;
    const idx = city ? segments.findIndex((s) => s.toLowerCase() === city.toLowerCase()) : -1;
    localityStart = idx > 0 ? idx : Math.max(1, segments.length - 2);
  } else {
    const idx = segments.findIndex((s) => UK_POSTCODE.test(s));
    localityStart = idx > 0 ? idx : Math.max(1, segments.length - 1);
  }
  const candidates = segments.slice(0, localityStart).filter((s) => !UNIT_ONLY.test(s));
  const cleaned = candidates.map(cleanStreet).filter((s) => /[a-z]/i.test(s));
  const withSuffix = [...cleaned].reverse().find((s) => STREET_SUFFIX.test(s));
  if (withSuffix) return withSuffix;
  // US addresses lead with the house number ("1816 US-96"). Building names
  // ("Taro Leisure Centre") are not streets.
  const numbered = candidates.find((s) => /^\d+[a-z]?\s+\S/i.test(s));
  const street = numbered ? cleanStreet(numbered) : '';
  return /[a-z]/i.test(street) ? street : null;
}

/** US: the city before the state. UK: the town before the postcode. */
export function cityFromAddress(address: string, region: Region): string | null {
  if (region === 'US') return parseUsAddress(address).city;
  const segments = addressSegments(address);
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]!;
    if (!UK_POSTCODE.test(segment)) continue;
    const town = segment.replace(UK_POSTCODE, '').trim();
    // Google sometimes leaves a stray word ("Hilsea, The PO3 5LF").
    if (town.length > 3 && !/^the$/i.test(town)) return town;
    return segments[i - 1] && !/\d/.test(segments[i - 1]!) ? segments[i - 1]! : null;
  }
  const last = segments[segments.length - 1];
  return last && segments.length > 1 && !/\d/.test(last) ? last : null;
}

/** US: the state's name (address, then "target", then the tab name). UK: the town. */
export function stateFor(
  row: RowData,
  address: string,
  region: Region,
  sheetTitle: string,
): string | null {
  if (region === 'UK') return cityFromAddress(address, region);
  const targetParts = (row.target ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const code = parseUsAddress(address).stateCode;
  const fromAddress = code ? US_STATES.find((s) => s.code === code)?.name : undefined;
  if (fromAddress) return fromAddress;
  const byName = (name: string) =>
    US_STATES.find((s) => s.name.toLowerCase() === name.toLowerCase())?.name;
  for (const part of targetParts) {
    const name = byName(part);
    if (name) return name;
  }
  return byName(sheetTitle.trim()) ?? null;
}

/** US numbers as "(409) 920-1462"; UK numbers as written locally, digits only ("07921122548"). */
export function localNumber(raw: string, region: Region): string {
  const national = nationalDigits(raw) ?? raw.replace(/\D/g, '');
  if (region === 'US' && /^\d{10}$/.test(national)) {
    return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
  }
  return national;
}

/** "https://www.teamhask.co.uk/?utm=x" → "teamhask.co.uk". */
export function websiteDisplay(url: string): string {
  return url
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function sentence(note: string): string {
  const trimmed = note.trim();
  return /[.!?…"')]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Normalized-header snapshot of a sheet row. */
export function rowRecord(headers: string[], row: unknown[]): RowData {
  const out: RowData = {};
  headers.forEach((header, i) => {
    const value = row[i];
    const textValue = value === null || value === undefined ? '' : String(value).trim();
    if (header && textValue) out[header] = textValue;
  });
  return out;
}

export function buildSequenceVars(
  row: RowData,
  ctx: FollowUpContext,
  region: Region,
): SequenceVars {
  const address = row.address ?? row.fulladdress ?? row.streetaddress ?? '';
  const status = parseStatusCell(ctx.cellValue);
  const city = (address && cityFromAddress(address, region)) || row.city || '';
  const state = stateFor(row, address, region, ctx.sheetTitle) || row.state || '';
  // The time written in the Status cell; the call's own time if the cell has none.
  const time = status.time ?? formatLocalTime(ctx.callEndedAt, ctx.timeZone);
  const weekday = status.weekday ?? formatLocalWeekday(ctx.callEndedAt, ctx.timeZone);
  const note = ctx.customNote?.trim() || status.note;
  const website = row.websiteurl ?? row.website ?? row.url ?? '';
  return {
    school_name:
      (row.title ?? row.schoolname ?? row.name ?? ctx.schoolName ?? '').trim() || 'your school',
    website: website ? websiteDisplay(website) : 'your website',
    rating: (row.rating ?? '').trim(),
    review_count: (row.reviewcount ?? row.reviews ?? '').replace(/[^\d]/g, ''),
    category: (row.category ?? '').trim().toLowerCase() || 'martial arts school',
    street: (address && streetFromAddress(address, region)) || '',
    city: city || state,
    state: state || city,
    // The number actually dialed (a phoneNumber cell can list several).
    called_number: localNumber(ctx.destinationE164, region),
    my_number: localNumber(status.from ?? ctx.callerE164, region),
    call_time: `${time} on ${weekday}`,
    call_note: note ? sentence(note) : '',
  };
}
