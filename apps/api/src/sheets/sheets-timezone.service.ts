/**
 * Resolves the IANA time zone of a called school from the address in its row.
 *
 * Resolution order:
 *  1. UK numbers (+44): Europe/London.
 *  2. ZIP code in the address: zip2tz (ZIP → zone), which gets the split
 *     states right — Florida panhandle, Indiana, Kentucky, Tennessee, El Paso,
 *     Navajo Nation, Malheur County OR, northern Idaho, western Kansas/Nebraska/
 *     Dakotas, Michigan's Upper Peninsula.
 *  3. City + state learned from the "U.S. Conquest" workbook: every address
 *     there that has a ZIP teaches the zone of its city, so later addresses
 *     without a ZIP still resolve. Built by SheetsService.checkConquest().
 *  4. A short list of known split-state cities.
 *  5. The state, when the whole state shares one zone.
 *  6. A guess: the state's main zone (or Eastern with no state at all).
 *
 * Zone names only — the offset for the call's date (DST or not) is applied by
 * Intl when the time is formatted, so clock changes are handled automatically.
 */

import { Injectable, Logger } from '@nestjs/common';
import { US_STATES, type SheetsTimeZoneSource } from '@pstn-twilio/shared';
import { lookup as zipToTimeZone } from 'zip2tz';

import { RedisService } from '../redis/redis.service';

const LEARNED_CITIES_KEY = 'sheets:learned-city-tz:v1';

// Split-state cities, for addresses that carry no ZIP. Key: "city,st".
const CITY_OVERRIDES: Record<string, string> = {
  'pensacola,fl': 'America/Chicago',
  'panama city,fl': 'America/Chicago',
  'panama city beach,fl': 'America/Chicago',
  'fort walton beach,fl': 'America/Chicago',
  'destin,fl': 'America/Chicago',
  'crestview,fl': 'America/Chicago',
  'niceville,fl': 'America/Chicago',
  'navarre,fl': 'America/Chicago',
  'milton,fl': 'America/Chicago',
  'gary,in': 'America/Chicago',
  'hammond,in': 'America/Chicago',
  'merrillville,in': 'America/Chicago',
  'valparaiso,in': 'America/Chicago',
  'crown point,in': 'America/Chicago',
  'evansville,in': 'America/Chicago',
  'memphis,tn': 'America/Chicago',
  'nashville,tn': 'America/Chicago',
  'clarksville,tn': 'America/Chicago',
  'murfreesboro,tn': 'America/Chicago',
  'jackson,tn': 'America/Chicago',
  'franklin,tn': 'America/Chicago',
  'paducah,ky': 'America/Chicago',
  'bowling green,ky': 'America/Chicago',
  'owensboro,ky': 'America/Chicago',
  'hopkinsville,ky': 'America/Chicago',
  'el paso,tx': 'America/Denver',
  'rapid city,sd': 'America/Denver',
  'dickinson,nd': 'America/Denver',
  'scottsbluff,ne': 'America/Denver',
  'goodland,ks': 'America/Denver',
  'coeur d alene,id': 'America/Los_Angeles',
  'lewiston,id': 'America/Los_Angeles',
  'moscow,id': 'America/Los_Angeles',
  'ontario,or': 'America/Boise',
  'iron mountain,mi': 'America/Menominee',
  'menominee,mi': 'America/Menominee',
  'ironwood,mi': 'America/Menominee',
  'window rock,az': 'America/Denver',
  'chinle,az': 'America/Denver',
  'kayenta,az': 'America/Denver',
  'tuba city,az': 'America/Denver',
};

export interface ParsedUsAddress {
  city: string | null;
  stateCode: string | null;
  zip: string | null;
}

export interface ResolvedTimeZone {
  timeZone: string;
  source: SheetsTimeZoneSource;
}

@Injectable()
export class SheetsTimezoneService {
  private readonly logger = new Logger(SheetsTimezoneService.name);
  private learned: Record<string, string> | null = null;

  constructor(private readonly redis: RedisService) {}

  async resolve(address: string | null, destinationE164: string): Promise<ResolvedTimeZone> {
    return resolveTimeZone(address, destinationE164, await this.learnedCities());
  }

  async saveLearnedCities(cities: Record<string, string>): Promise<void> {
    this.learned = cities;
    await this.redis.client.set(LEARNED_CITIES_KEY, JSON.stringify(cities));
  }

  private async learnedCities(): Promise<Record<string, string>> {
    if (this.learned) return this.learned;
    try {
      const raw = await this.redis.client.get(LEARNED_CITIES_KEY);
      this.learned = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    } catch (err) {
      // Resolution still works without the learned cities; retry next call.
      this.logger.warn(`Could not load learned cities: ${(err as Error).message}`);
      return {};
    }
    return this.learned;
  }
}

export function resolveTimeZone(
  address: string | null,
  destinationE164: string,
  learnedCities: Record<string, string> = {},
): ResolvedTimeZone {
  if (destinationE164.startsWith('+44')) return { timeZone: 'Europe/London', source: 'uk' };

  const { city, stateCode, zip } = parseUsAddress(address ?? '');
  if (zip) {
    const fromZip = zipToTimeZone(zip);
    if (fromZip) return { timeZone: fromZip, source: 'zip' };
  }
  if (city && stateCode) {
    const key = cityKey(city, stateCode);
    const known = learnedCities[key] ?? CITY_OVERRIDES[key];
    if (known) return { timeZone: known, source: 'city' };
  }
  const state = stateCode ? US_STATES.find((s) => s.code === stateCode) : undefined;
  if (state?.timeZones.length === 1) return { timeZone: state.timeZones[0]!, source: 'state' };
  return { timeZone: state?.timeZones[0] ?? 'America/New_York', source: 'guess' };
}

export function cityKey(city: string, stateCode: string): string {
  const name = city
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${name},${stateCode.toLowerCase()}`;
}

const STATE_NAMES: [string, string][] = [
  ...US_STATES.map((s): [string, string] => [s.name, s.code]),
  ['District of Columbia', 'DC'],
];
const STATE_BY_NAME = new Map(STATE_NAMES.map(([name, code]) => [name.toLowerCase(), code]));
const STATE_CODES = new Set(STATE_NAMES.map(([, code]) => code));

// "<before> ST 12345" / "<before> State Name 12345-6789" (ZIP optional).
const ZIP_TAIL = String.raw`\s*(\d{5})?(?:-\d{4})?$`;
const STATE_CODE_RE = new RegExp(String.raw`^(.*?)\s*\b([A-Za-z]{2})\.?` + ZIP_TAIL);
const STATE_NAME_RE = new RegExp(
  String.raw`^(.*?)\s*\b(` +
    STATE_NAMES.map(([name]) => name)
      .sort((a, b) => b.length - a.length)
      .join('|') +
    ')' +
    ZIP_TAIL,
  'i',
);
const ZIP_ONLY_RE = /^(\d{5})(?:-\d{4})?$/;
const COUNTRY_SUFFIX = /,?\s*(usa|us|u\.s\.a?\.?|united states(?: of america)?)\s*$/i;

/**
 * Pulls city, state and ZIP out of a one-line US address:
 *   "123 Main St, Springfield, IL 62701"   "Springfield, IL"
 *   "123 Main St, Pensacola, Florida 32501, USA"   "... TX 79901-1234"
 */
export function parseUsAddress(raw: string): ParsedUsAddress {
  const text = raw.replace(/\s+/g, ' ').trim().replace(COUNTRY_SUFFIX, '').trim();
  if (!text) return { city: null, stateCode: null, zip: null };

  const segments = text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Walk from the end: the state (with optional ZIP) is in the last segment or two.
  for (let i = segments.length - 1; i >= 0 && i >= segments.length - 3; i--) {
    const segment = segments[i]!;
    const match = matchState(segment);
    if (!match) continue;
    const zip = match.zip ?? ZIP_ONLY_RE.exec(segments[i + 1] ?? '')?.[1] ?? null;
    // "Springfield IL 62701" (no comma before the state): the city is `before`.
    const city = match.before ? lastWords(match.before) : (segments[i - 1] ?? null);
    return { city: city?.trim() || null, stateCode: match.stateCode, zip };
  }

  // No recognizable state; a trailing ZIP alone still pins the zone.
  const trailingZip = /\b(\d{5})(?:-\d{4})?$/.exec(text);
  return { city: null, stateCode: null, zip: trailingZip?.[1] ?? null };
}

function matchState(
  segment: string,
): { before: string; stateCode: string; zip: string | null } | null {
  for (const re of [STATE_CODE_RE, STATE_NAME_RE]) {
    const m = re.exec(segment);
    if (!m) continue;
    const text = m[2]!.trim();
    const stateCode =
      text.length === 2 && STATE_CODES.has(text.toUpperCase())
        ? text.toUpperCase()
        : (STATE_BY_NAME.get(text.toLowerCase()) ?? null);
    if (stateCode) return { before: m[1]!.trim(), stateCode, zip: m[3] ?? null };
  }
  return null;
}

// Without a comma we can't tell street from city; the last two words are the
// best guess and only feed the city lookup, never the ZIP.
function lastWords(text: string): string {
  return text.trim().split(' ').slice(-2).join(' ');
}
