/**
 * Follow-up email sequences: 6 emails per call status, one set per region,
 * in apps/api/templates/sequences/<us|uk>/<status key>.txt (typos and plain
 * punctuation are on purpose).
 *
 *   us/  U.S. Conquest, as the copywriter delivered it: demo line (667) 220-6726.
 *   uk/  The Official UK: the same emails in British wording (mum, autumn,
 *        engaged tone, programme…) with the demo line written 02045726501.
 *
 * File format: "STATUS: …", then blocks separated by a line of "=" signs,
 * each "EMAIL <n>", "Subject: …", a blank line and the body.
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
export const REGIONS: readonly Region[] = ['US', 'UK'];

export const DEMO_NUMBERS: Record<Region, string> = {
  US: '(667) 220-6726',
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

/** The folder holding a region's sequences ("…/sequences/uk"). */
export function sequenceDir(region: Region): string | null {
  const sub = region.toLowerCase();
  const base = SEQUENCE_DIRS.find((dir) => existsSync(join(dir, sub, 'rang-out.txt')));
  return base ? join(base, sub) : null;
}

export function hasSequence(key: string, region: Region): boolean {
  const dir = sequenceDir(region);
  return Boolean(dir && /^[a-z-]+$/.test(key) && existsSync(join(dir, `${key}.txt`)));
}

/**
 * The 6 emails a region sends for a status key such as "rang-out". Each
 * email must push that region's demo line and never the other one, so a
 * copy edit can't send UK schools to the US line or the reverse.
 */
export function loadSequence(key: string, region: Region): SequenceEmail[] {
  const name = `${region.toLowerCase()}/${key}`;
  const cached = cache.get(name);
  if (cached) return cached;
  if (!sequenceDir(region)) throw new Error('Follow-up sequences are missing from the API build.');
  if (!hasSequence(key, region)) throw new Error(`No follow-up sequence for "${name}".`);
  const emails = parseSequence(readFileSync(join(sequenceDir(region)!, `${key}.txt`), 'utf8'));
  if (emails.length !== SEQUENCE_LENGTH) {
    throw new Error(`Sequence "${name}" has ${emails.length} emails, expected ${SEQUENCE_LENGTH}.`);
  }
  for (const email of emails) {
    const text = `${email.subject}\n${email.body}`;
    if (!email.body.includes(DEMO_NUMBERS[region])) {
      throw new Error(`Sequence "${name}" email ${email.step} lacks ${DEMO_NUMBERS[region]}.`);
    }
    for (const other of REGIONS.filter((r) => r !== region)) {
      if (text.includes(DEMO_NUMBERS[other])) {
        throw new Error(
          `Sequence "${name}" email ${email.step} pushes ${DEMO_NUMBERS[other]}, the ${other} demo line.`,
        );
      }
    }
  }
  cache.set(name, emails);
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
    text.replace(/\{\{(\w+)\}\}/g, (_, name: SequenceVariable) => vars[name]?.trim() ?? '');
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
