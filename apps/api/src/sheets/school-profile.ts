/**
 * What the worker's profile pass learned about one school.
 *
 * The facts come from the pages a visitor reads (home, classes, about,
 * contact, and the Facebook/Instagram profile when the site has none of it), so
 * they can be turned into sentences the owner recognises: "Tuesday is your kids
 * karate night". They are stored per finder row and read again at push time.
 *
 * The worker is the only writer, but the API is the one that puts these strings
 * in front of a person, so it normalises and caps them: a list of unknown
 * strings is not a profile, and no sentence should carry a stray 4,000
 * characters of page text.
 */

export interface SchoolProfile {
  /** Paired programmes first ("kids karate"), then the styles on their own. */
  programs: string[];
  audiences: string[];
  styles: string[];
  instructors: string[];
  events: string[];
  /** "Tuesdays and Thursdays 5–6pm". */
  hours: string[];
  /** Weekday names, likeliest first. */
  days: string[];
  /** "5–6pm". */
  times: string[];
  offers: string[];
  /** "1998" or "20 years". */
  since: string | null;
  /** Pages the facts came from (http(s) only). */
  sources: string[];
}

export const PROFILE_LISTS = [
  'programs',
  'audiences',
  'styles',
  'instructors',
  'events',
  'hours',
  'days',
  'times',
  'offers',
  'sources',
] as const satisfies readonly (keyof SchoolProfile)[];

/** Longest text kept for one fact; a programme name is a phrase, not a page. */
export const MAX_FACT_CHARS = 120;
const MAX_SOURCES = 6;
const LIMITS: Record<(typeof PROFILE_LISTS)[number], number> = {
  programs: 6,
  audiences: 3,
  styles: 4,
  instructors: 4,
  events: 4,
  hours: 4,
  days: 4,
  times: 3,
  offers: 3,
  sources: MAX_SOURCES,
};

const HTTP = /^https?:\/\/\S+$/i;

function cleanList(value: unknown, limit: number, urls = false): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.replace(/\s+/g, ' ').trim();
    if (!text || text.length > MAX_FACT_CHARS) continue;
    if (urls && !HTTP.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * A stored/uploaded profile, or null when there is nothing worth a sentence.
 * Unknown keys are dropped, so a newer worker cannot smuggle anything in.
 */
export function cleanProfile(input: unknown): SchoolProfile | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const profile: SchoolProfile = {
    programs: [],
    audiences: [],
    styles: [],
    instructors: [],
    events: [],
    hours: [],
    days: [],
    times: [],
    offers: [],
    sources: [],
    since: typeof raw.since === 'string' ? (cleanList([raw.since], 1)[0] ?? null) : null,
  };
  for (const key of PROFILE_LISTS) {
    profile[key] = cleanList(raw[key], LIMITS[key], key === 'sources');
  }
  // Days are weekday names only: a sentence that names the wrong day is worse
  // than one that names none.
  profile.days = profile.days.filter((day) =>
    /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(day),
  );
  const facts =
    profile.programs.length ||
    profile.styles.length ||
    profile.instructors.length ||
    profile.events.length ||
    profile.hours.length ||
    profile.offers.length ||
    profile.since;
  if (!facts) return null;
  return profile;
}
