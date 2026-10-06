/**
 * Follow-up email sequences: 6 emails per call status, written in
 * apps/api/templates/sequences/<status key>.txt exactly as the copywriter
 * delivered them (typos and plain punctuation are on purpose).
 *
 * File format: "STATUS: …", then blocks separated by a line of "=" signs,
 * each "EMAIL <n>", "Subject: …", a blank line and the body.
 *
 * The text is written for U.S. Conquest, whose demo line is (667) 220-6726.
 * The Official UK sends the same emails with its own demo line, written
 * exactly as 02045726501.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export const SEQUENCE_LENGTH = 6;
// Days after the call that email 1…6 goes out. Email 1 keeps the 48 hours
// the single follow-up always had.
export const SEQUENCE_DAYS = [2, 4, 7, 10, 14, 21] as const;
// A late or retried email never lands less than this before the next one.
export const MIN_GAP_MS = 20 * 60 * 60 * 1000;

export type Region = 'US' | 'UK';

const US_DEMO_NUMBER = '(667) 220-6726';
export const DEMO_NUMBERS: Record<Region, string> = {
  US: US_DEMO_NUMBER,
  UK: '02045726501',
};

export const SEQUENCE_VARIABLES = [
  'school_name',
  'website',
  'rating',
  'review_count',
  'category',
  'street',
  'city',
  'state',
  'called_number',
  'my_number',
  'call_time',
  'call_note',
] as const;
export type SequenceVariable = (typeof SEQUENCE_VARIABLES)[number];
export type SequenceVars = Record<SequenceVariable, string>;

// The only variable that may be empty: its own line is dropped.
const OPTIONAL_VARIABLES = new Set<SequenceVariable>(['call_note']);

export interface SequenceEmail {
  step: number;
  subject: string;
  body: string;
}

// dist/main.js runs from /app in the image (templates copied to /app/templates)
// and from apps/api in development.
const SEQUENCE_DIRS = [
  join(process.cwd(), 'templates', 'sequences'),
  join(process.cwd(), 'apps', 'api', 'templates', 'sequences'),
  join(__dirname, '..', '..', 'templates', 'sequences'),
];

const cache = new Map<string, SequenceEmail[]>();

export function sequenceDir(): string | null {
  return SEQUENCE_DIRS.find((dir) => existsSync(join(dir, 'rang-out.txt'))) ?? null;
}

export function hasSequence(key: string): boolean {
  const dir = sequenceDir();
  return Boolean(dir && /^[a-z-]+$/.test(key) && existsSync(join(dir, `${key}.txt`)));
}

/** The 6 emails for a status key such as "rang-out". */
export function loadSequence(key: string): SequenceEmail[] {
  const cached = cache.get(key);
  if (cached) return cached;
  const dir = sequenceDir();
  if (!dir) throw new Error('Follow-up sequences are missing from the API build.');
  if (!hasSequence(key)) throw new Error(`No follow-up sequence for "${key}".`);
  const emails = parseSequence(readFileSync(join(dir, `${key}.txt`), 'utf8'));
  if (emails.length !== SEQUENCE_LENGTH) {
    throw new Error(`Sequence "${key}" has ${emails.length} emails, expected ${SEQUENCE_LENGTH}.`);
  }
  cache.set(key, emails);
  return emails;
}

export function parseSequence(raw: string): SequenceEmail[] {
  const blocks = raw.replace(/\r\n/g, '\n').split(/\n={5,}\n/);
  const emails: SequenceEmail[] = [];
  for (const block of blocks) {
    const match = /^\s*EMAIL\s+(\d+)\s*\nSubject:[ \t]*(.*)\n([\s\S]*)$/i.exec(block);
    if (!match) continue;
    emails.push({
      step: Number(match[1]),
      subject: match[2]!.trim(),
      body: match[3]!.trim(),
    });
  }
  return emails.sort((a, b) => a.step - b.step);
}

/**
 * Fills one email. Returns null when it needs a variable this school has no
 * value for (e.g. no Google rating), so the caller can skip that email rather
 * than send "at  stars".
 */
export function renderSequenceEmail(
  email: SequenceEmail,
  vars: SequenceVars,
  region: Region,
): { subject: string; body: string } | null {
  email = adaptToVars(email, vars);
  const used = new Set(
    [...`${email.subject}\n${email.body}`.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!),
  );
  for (const name of used) {
    const known = (SEQUENCE_VARIABLES as readonly string[]).includes(name);
    if (!known) throw new Error(`Unknown variable {{${name}}} in sequence email ${email.step}.`);
    if (
      !vars[name as SequenceVariable]?.trim() &&
      !OPTIONAL_VARIABLES.has(name as SequenceVariable)
    ) {
      return null;
    }
  }
  const fill = (text: string) =>
    text
      .replace(/\{\{(\w+)\}\}/g, (_, name: SequenceVariable) => vars[name]?.trim() ?? '')
      .split(US_DEMO_NUMBER)
      .join(DEMO_NUMBERS[region]);
  const body = fill(email.body)
    // An empty {{call_note}} on its own line leaves a gap; close it.
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  return { subject: fill(email.subject).trim(), body };
}

/**
 * Small rewrites so missing or repeated places still read naturally:
 * no street name → "in {{city}}" instead of "on {{street}}"; a UK town used
 * for both {{city}} and {{state}} isn't written twice.
 */
function adaptToVars(email: SequenceEmail, vars: SequenceVars): SequenceEmail {
  const adapt = (text: string) => {
    let out = text;
    if (!vars.street.trim()) {
      out = out
        .replace(/\bon \{\{street\}\} in \{\{(city|state)\}\}/g, 'in {{$1}}')
        .replace(/\bon \{\{street\}\}/g, 'in {{city}}');
    }
    if (vars.city.trim() && vars.city.trim().toLowerCase() === vars.state.trim().toLowerCase()) {
      out = out.replace(/\{\{city\}\}(?:,| and) \{\{state\}\}/g, '{{city}}');
    }
    return out;
  };
  return { ...email, subject: adapt(email.subject), body: adapt(email.body) };
}

/** When email `step` (1-based) is due: its day after the call, never too soon after the last one. */
export function sequenceDueAt(callEndedAt: Date, step: number, now: Date): Date {
  const days = SEQUENCE_DAYS[Math.min(step, SEQUENCE_LENGTH) - 1]!;
  const planned = callEndedAt.getTime() + days * 24 * 60 * 60 * 1000;
  return new Date(Math.max(planned, now.getTime() + MIN_GAP_MS));
}
