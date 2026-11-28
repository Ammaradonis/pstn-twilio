/**
 * The Meta-ad email sequence: 6 emails for a school seen advertising on
 * Facebook/Instagram, written in apps/api/templates/meta-ads/sequence.txt.
 *
 * It runs next to the call-status sequences, not instead of them: a school
 * gets it whether or not it was called or emailed before. What makes it
 * personal is the school's own ad (what it says, its button, its landing
 * domain, when it ran) plus the sheet row (owner's first name, city, rating)
 * and what the finder's profile pass read on the school's site (programmes,
 * instructors, class times, offers).
 *
 * A line that needs a detail this school doesn't have is dropped, and a
 * subject can offer fallbacks ("A || B"), so a sparse row still gets a whole
 * email instead of "Hey ,".
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import {
  DEMO_NUMBERS,
  MIN_GAP_MS,
  parseSequence,
  type Region,
  type SequenceEmail,
} from './follow-up-sequences';
import { cityFromAddress, stateFor, type RowData } from './follow-up-vars';
import type { SchoolProfile } from './school-profile';

export const META_SEQUENCE_LENGTH = 6;
/** Days after the ad was found that email 1…6 goes out: email 1 as soon as the send window opens. */
export const META_SEQUENCE_DAYS = [0, 2, 4, 7, 10, 14] as const;
/** An "Active" ad seen longer ago than this is not called running now (as in the filter). */
export const RUNNING_DAYS = 30;
/** Local send window for the school: 8:00 to 19:00. */
export const SEND_HOURS = [8, 19] as const;

/** The ad the emails talk about: the school's newest running ad, else its newest ended one. */
export interface AdFacts {
  adId: string;
  advertiserName: string;
  status: 'ACTIVE' | 'INACTIVE';
  startedAt: string | null;
  endedAt: string | null;
  observedAt: string;
  adText: string | null;
  adCta: string | null;
  adLink: string | null;
  /** Ads seen for this school in all. */
  adCount: number;
}

// Always filled (with a neutral fallback), so they never drop a line.
const ALWAYS = [
  'hey',
  'school_name',
  'ad_seen',
  'ad_seen_short',
  'when_it_runs',
  'category',
  'city_or_area',
  'demo',
] as const;
// May be empty without dropping their line: a clause inside a sentence.
const INLINE = ['program_clause', 'teaching_clause'] as const;
// A line that uses one of these while it is empty is left out.
const OPTIONAL = [
  'first_name',
  'ad_quote',
  'ad_cta',
  'ad_link',
  'program',
  'offer_line',
  'instructor_line',
  'hours_line',
  'rating',
  'review_count',
] as const;

export const META_VARIABLES = [...ALWAYS, ...INLINE, ...OPTIONAL] as const;
export type MetaVariable = (typeof META_VARIABLES)[number];
export type MetaVars = Record<MetaVariable, string>;

const KNOWN = new Set<string>(META_VARIABLES);
const MAY_BE_EMPTY = new Set<string>(INLINE);

const DIRS = [
  join(process.cwd(), 'templates', 'meta-ads'),
  join(process.cwd(), 'apps', 'api', 'templates', 'meta-ads'),
  join(__dirname, '..', '..', 'templates', 'meta-ads'),
];

let cached: SequenceEmail[] | null = null;

export function loadMetaSequence(): SequenceEmail[] {
  if (cached) return cached;
  const dir = DIRS.find((d) => existsSync(join(d, 'sequence.txt')));
  if (!dir) throw new Error('The Meta-ad sequence is missing from the API build.');
  const emails = parseSequence(readFileSync(join(dir, 'sequence.txt'), 'utf8'));
  if (emails.length !== META_SEQUENCE_LENGTH) {
    throw new Error(
      `The Meta-ad sequence has ${emails.length} emails, expected ${META_SEQUENCE_LENGTH}.`,
    );
  }
  cached = emails;
  return emails;
}

// ── Variables ───────────────────────────────────────────────────────────────

const NOT_A_PERSON =
  /\d|martial|academy|karate|studio|school|team|staff|office|front desk|manager|llc|inc\b|info|admin|owner|unknown|n\/a/i;

/** "Kathy Snyder (owner)" → "Kathy"; "" when the cell doesn't name a person. */
export function firstName(decisionMaker: string | undefined): string {
  const name = (decisionMaker ?? '')
    .split(/[;\n|]/)[0]!
    .replace(/\(.*?\)/g, '')
    .trim();
  if (!name || NOT_A_PERSON.test(name)) return '';
  // "Master Kim", "Coach Dave": skip the title, keep the name.
  const words = name
    .split(/[\s,/&]+/)
    .map((w) => w.replace(/[.'’]/g, ''))
    .filter((w) => w && !TITLES.test(w));
  const first = words[0] ?? '';
  return /^[A-Za-zÀ-ÿ-]{2,20}$/.test(first) ? capitalise(first) : '';
}

const TITLES =
  /^(mr|mrs|ms|miss|dr|sensei|master|grandmaster|coach|professor|shihan|kyoshi|sifu|sabumnim)$/i;

function capitalise(word: string): string {
  return word === word.toUpperCase() || word === word.toLowerCase()
    ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    : word;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Aug 27" this year, "Aug 27, 2024" before it. */
export function shortDay(iso: string | null, now: Date): string {
  if (!iso) return '';
  const date = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(date.getTime())) return '';
  const day = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
  return date.getUTCFullYear() === now.getUTCFullYear() ? day : `${day}, ${date.getUTCFullYear()}`;
}

export function isRunning(ad: Pick<AdFacts, 'status' | 'observedAt'>, now: Date): boolean {
  return (
    ad.status === 'ACTIVE' &&
    now.getTime() - new Date(ad.observedAt).getTime() <= RUNNING_DAYS * 24 * 60 * 60 * 1000
  );
}

/** The ad's opening line, fit to quote: one sentence, no emoji, at most 90 characters. */
export function adQuote(adText: string | null): string {
  const clean = (adText ?? '')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/gu, '')
    // Variation selectors and joiners the emoji above leave behind.
    .replace(/️|‍/g, '')
    .replace(/["“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  let sentence = /^(.+?[.!?])(\s|$)/.exec(clean)?.[1] ?? clean;
  if (sentence.length > 90) {
    sentence =
      sentence
        .slice(0, 90)
        .replace(/\s+\S*$/, '')
        .replace(/[,;:\-–—]+$/, '') + '…';
  }
  // A quote needs a few real words; "🥋🥋" or "Kids!" is not one.
  return sentence.split(/\s+/).filter((w) => /[a-z]/i.test(w)).length >= 3 ? sentence : '';
}

// Messenger/WhatsApp ads print these instead of the school's own site.
const NOT_A_LANDING =
  /(^|\.)(facebook\.com|fb\.me|fb\.com|instagram\.com|m\.me|wa\.me|whatsapp\.com)$/i;

function landing(adLink: string | null): string {
  const link = (adLink ?? '').toLowerCase().replace(/^www\./, '');
  return link && !NOT_A_LANDING.test(link) ? link : '';
}

function firstFact(list: readonly string[] | undefined): string {
  return (list ?? []).map((s) => s.trim()).find(Boolean) ?? '';
}

export interface MetaVarsInput {
  row: RowData;
  schoolTitle: string;
  sheetTitle: string;
  ad: AdFacts;
  profile: SchoolProfile | null;
  region: Region;
  now: Date;
}

export function buildMetaVars({
  row,
  schoolTitle,
  sheetTitle,
  ad,
  profile,
  region,
  now,
}: MetaVarsInput): MetaVars {
  const first = firstName(row.decisionmaker ?? row.owner ?? row.contactname);
  const address = row.address ?? row.fulladdress ?? row.streetaddress ?? '';
  const city =
    (address && cityFromAddress(address, region)) ||
    row.city ||
    stateFor(row, address, region, sheetTitle) ||
    '';
  const running = isRunning(ad, now);
  const since = shortDay(ad.startedAt, now);
  const until = shortDay(ad.endedAt, now);
  let seen: string;
  if (running) {
    seen = since
      ? `your Facebook ad thats been running since ${since}`
      : 'your Facebook ad thats running right now';
  } else if (since && until) {
    seen = `the Facebook ad you ran from ${since} to ${until}`;
  } else {
    seen = until ? `the Facebook ad you ran until ${until}` : 'the Facebook ad you ran';
  }
  const program = firstFact(profile?.programs).toLowerCase();
  const offer = firstFact(profile?.offers);
  const instructor = firstFact(profile?.instructors);
  const hours = firstFact(profile?.hours);
  const rating = (row.rating ?? '').trim();
  const reviews = (row.reviewcount ?? row.reviews ?? '').replace(/[^\d]/g, '');
  return {
    hey: first ? `Hey ${first},` : 'Hey,',
    school_name: (row.title ?? row.schoolname ?? row.name ?? schoolTitle).trim() || 'your school',
    ad_seen: seen,
    ad_seen_short: 'your Facebook ad',
    when_it_runs: running ? 'while the ad is running' : 'while an ad is running',
    category: (row.category ?? '').trim().toLowerCase() || 'martial arts school',
    city_or_area: city.trim() || 'your area',
    demo: DEMO_NUMBERS[region],
    program_clause: program ? `, your ${program} included` : '',
    teaching_clause: program ? ` teaching ${program}` : '',
    first_name: first,
    ad_quote: adQuote(ad.adText),
    ad_cta: ad.adCta ? `"${ad.adCta}"` : '',
    ad_link: landing(ad.adLink),
    program,
    offer_line: offer
      ? `And with "${offer}" on the table, those callers are the easiest trials youll ever book.`
      : '',
    instructor_line: instructor
      ? `Sounds like ${instructor} has built something people want to be part of.`
      : '',
    hours_line: hours
      ? `Your site says classes run ${hours}. Thats exactly when the phone gets ignored.`
      : '',
    // A rating needs its review count and the other way round ("12 reviews at  stars").
    rating: rating && reviews && Number(reviews) >= 5 ? rating : '',
    review_count: rating && reviews && Number(reviews) >= 5 ? reviews : '',
  };
}

// ── Rendering ───────────────────────────────────────────────────────────────

function used(text: string): string[] {
  return [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!);
}

function filled(text: string, vars: MetaVars): boolean {
  return used(text).every((name) => MAY_BE_EMPTY.has(name) || vars[name as MetaVariable]?.trim());
}

function fill(text: string, vars: MetaVars): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, name: MetaVariable) => vars[name] ?? '');
}

/** One email for one school. Unknown variables are a bug in the template, not missing data. */
export function renderMetaEmail(
  email: SequenceEmail,
  vars: MetaVars,
): { subject: string; body: string } {
  for (const name of used(`${email.subject}\n${email.body}`)) {
    if (!KNOWN.has(name)) {
      throw new Error(`Unknown variable {{${name}}} in Meta-ad email ${email.step}.`);
    }
  }
  const subjects = email.subject.split('||').map((s) => s.trim());
  const subject = subjects.find((s) => filled(s, vars)) ?? subjects[subjects.length - 1]!;
  const body = email.body
    .split('\n')
    .filter((line) => filled(line, vars))
    .map((line) => fill(line, vars).replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    subject: fill(subject, vars)
      .replace(/\{\{\w+\}\}/g, '')
      .trim(),
    body,
  };
}

// ── Schedule ────────────────────────────────────────────────────────────────

function localHour(date: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone })
    .formatToParts(date)
    .find((p) => p.type === 'hour')?.value;
  return Number(hour ?? '12');
}

/** `at`, or the next moment inside the school's 8:00–19:00 (checked hour by hour). */
export function inSendWindow(at: Date, timeZone: string): Date {
  let t = new Date(at.getTime());
  for (let i = 0; i < 48; i++) {
    const hour = localHour(t, timeZone);
    if (hour >= SEND_HOURS[0] && hour < SEND_HOURS[1]) return t;
    // Top of the next hour.
    t = new Date(Math.floor(t.getTime() / 3_600_000) * 3_600_000 + 3_600_000);
  }
  return at;
}

/** When email `step` is due: its day after the first email, never within 20 h of the last one, in the window. */
export function metaDueAt(
  firstSentAt: Date | null,
  step: number,
  now: Date,
  timeZone: string,
): Date {
  if (step <= 1 || !firstSentAt) return inSendWindow(now, timeZone);
  const days = META_SEQUENCE_DAYS[Math.min(step, META_SEQUENCE_LENGTH) - 1]!;
  const planned = firstSentAt.getTime() + days * 24 * 60 * 60 * 1000;
  return inSendWindow(new Date(Math.max(planned, now.getTime() + MIN_GAP_MS)), timeZone);
}
