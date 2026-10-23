/**
 * The three personalised sentences that go into the Status cell after a call.
 *
 * They are built from a bank of sentence structures grouped by what the call
 * actually did (nobody picked up, the front desk answered, the number is dead,
 * a demo was booked, …). Every structure names the facts it needs, and the
 * composer only uses structures whose facts the worker actually found on the
 * school's pages, so a sentence never claims something the school did not say.
 *
 * The voice of the bank is lifted from `hustle/` — the analyses of the sales
 * and hustling transcripts this project was tuned on. Their move is always the
 * same three beats, and so is every structure here:
 *
 *   1. one specific, checkable observation about *their* school ("Tuesday is
 *      your kids karate night"),
 *   2. the consequence of the outcome of the call (nobody could answer, the
 *      desk could not say, the number is dead), and
 *   3. an understated next step ("this is the short version", "I will try once
 *      more", "no pitch"), never a promise and never an adjective.
 *
 * That is why the sentences are plain, short and specific, mention no prices,
 * claim no results and never invent a detail. A wrong fact on a sentence the
 * owner reads costs more than a missing one, which is also why the composer
 * returns two sentences rather than pad a third.
 */

import type { CallStatusTag } from '@pstn-twilio/shared';

import type { SchoolProfile } from './school-profile';

/** A fact a structure can use. Only facts the worker found are ever filled. */
export type Slot =
  | 'program'
  | 'style'
  | 'audience'
  | 'instructor'
  | 'event'
  | 'day'
  | 'time'
  | 'hours'
  | 'offer'
  | 'since'
  | 'age'
  | 'school';

export interface SentenceStructure {
  /** Every fact this sentence needs; the composer skips it when one is missing. */
  needs: readonly Slot[];
  text: string;
}

export type Angle =
  | 'missed'
  | 'no-voicemail'
  | 'gatekeeper'
  | 'declined'
  | 'dead-line'
  | 'answered-by-ai'
  | 'owner-answers'
  | 'booked';

/**
 * Which angle a status belongs to. The first selected tag decides, because it
 * is the one that picks the follow-up email template too.
 */
export const TAG_ANGLE: Record<CallStatusTag, Angle> = {
  'Rang out': 'missed',
  "Rang out but voicemail box hasn't been set up yet": 'no-voicemail',
  'Line is busy': 'missed',
  Voicemail: 'missed',
  'Hung up on me': 'declined',
  'Not interested': 'declined',
  'Has an answering service': 'gatekeeper',
  'Out-of-service number': 'dead-line',
  'Not available': 'missed',
  'Has a receptionist': 'gatekeeper',
  'Has an AI': 'answered-by-ai',
  'Handles calls himself': 'owner-answers',
  'Voicemail is full': 'missed',
  'Booked a demo': 'booked',
  'Stayed silent': 'missed',
};

/** How an event reads inside a sentence ("gradings", "the summer camp"). */
const EVENT_PHRASE: Record<string, string> = {
  gradings: 'gradings',
  competitions: 'the competitions',
  seminars: 'the seminars',
  'summer camps': 'the summer camp',
  'open days': 'the open day',
  'birthday parties': 'birthday parties',
};

export const SENTENCE_BANK: Record<Angle, readonly SentenceStructure[]> = {
  missed: [
    {
      needs: ['day', 'program'],
      text: 'I rang on {day}, right around your {program} class, so this note is shorter than the voicemail.',
    },
    {
      needs: ['program', 'time'],
      text: 'I called while your {program} class was running ({time}), so nothing I left needs a callback.',
    },
    {
      needs: ['hours'],
      text: 'Your timetable has {hours} down for classes, which is exactly when the phone rings and nobody can answer it.',
    },
    {
      needs: ['instructor'],
      text: 'I asked for {instructor} and got the voicemail, so I will keep this to one question about your classes.',
    },
    {
      needs: ['event'],
      text: 'With {event} in the calendar, your phone is only going to ring more, not less.',
    },
    {
      needs: ['offer'],
      text: 'The {offer} on your site is the reason I called, and a voicemail cannot answer it.',
    },
    {
      needs: ['program'],
      text: 'This is about the calls your {program} families make at six in the evening, when the mat is full.',
    },
    {
      needs: ['style', 'since'],
      text: 'You have taught {style} since {since}; the calls that arrive mid-class are the ones that book.',
    },
    {
      needs: ['audience'],
      text: 'I rang about your {audience} classes and the box cut me off, so this is the second attempt.',
    },
    {
      needs: ['age'],
      text: 'You have been running this for {age} and the phone still rings in the middle of a class.',
    },
    {
      needs: ['school'],
      text: 'I rang about how the calls {school} misses get answered; one line back is all I need.',
    },
  ],
  'no-voicemail': [
    {
      needs: ['program'],
      text: 'I rang about {program} and there was no box to leave it in, so nothing reached you.',
    },
    {
      needs: ['hours'],
      text: 'Ring during {hours} and there is nowhere to leave a message, which is the whole reason I am writing.',
    },
    {
      needs: ['offer'],
      text: 'I only wanted to ask about the {offer}; the line rang out to nothing.',
    },
    {
      needs: ['instructor'],
      text: 'Nothing reached {instructor}, so this is the version that does not need a phone.',
    },
    {
      needs: ['day'],
      text: 'I tried on {day} and the line rang out to a box that has not been set up yet.',
    },
    {
      needs: ['program'],
      text: 'A minute of setup would have caught this call about {program}; happy to try again.',
    },
    {
      needs: ['time'],
      text: 'I called at {time}, after your classes, and still got nothing but a ring tone.',
    },
    {
      needs: ['school'],
      text: 'The line at {school} rings out to a box that has not been set up, so I am putting this here instead.',
    },
  ],
  gatekeeper: [
    {
      needs: ['program'],
      text: 'Whoever answered could not tell me your {program} times, which is exactly the question I had.',
    },
    {
      needs: ['instructor'],
      text: 'I asked for {instructor} and did not get a callback window, so I am asking in writing.',
    },
    {
      needs: ['hours'],
      text: 'I rang inside {hours}, when the desk is least likely to be staffed, and it showed.',
    },
    {
      needs: ['offer'],
      text: 'One question about the {offer} did not survive the front desk, so here it is.',
    },
    { needs: ['event'], text: 'With {event} coming up, the desk has more to do, not less.' },
    {
      needs: ['program'],
      text: 'I left one detail about {program} with the person who answered; this is the version that does not get lost.',
    },
    {
      needs: ['since'],
      text: 'A school running since {since}, and the front desk still cannot say what a beginner should bring.',
    },
    {
      needs: ['day'],
      text: 'I rang on {day} and got as far as the front desk, so a line from you would close it.',
    },
    {
      needs: ['school'],
      text: 'I rang {school} about how calls are handled when the desk is busy, and got as far as the front desk.',
    },
  ],
  declined: [
    {
      needs: ['program'],
      text: 'Fair enough; your {program} page is the only reason I rang, not a bought list.',
    },
    {
      needs: ['instructor'],
      text: 'No pitch: {instructor} was why I called, so I will leave it there.',
    },
    { needs: ['event'], text: 'Understood. With {event} on the calendar, the offer can wait.' },
    {
      needs: ['since'],
      text: 'You have been at this since {since}; you have heard the pitch I am not making.',
    },
    {
      needs: ['offer'],
      text: 'The {offer} was the only thing I wanted to check, and that is all.',
    },
    { needs: ['style'], text: 'One line about your {style} classes and I am gone.' },
    {
      needs: ['program'],
      text: 'Last word: your {program} classes are why the call happened at all.',
    },
    {
      needs: ['hours'],
      text: 'You are on the mat for {hours}; I would rather one line reach you than another call.',
    },
    {
      needs: ['school'],
      text: 'No follow-up after this; I only wanted to check one thing about how {school} answers its calls.',
    },
  ],
  'dead-line': [
    {
      needs: ['program'],
      text: 'The number on your {program} page is out of service, so I am trying the other line.',
    },
    {
      needs: ['hours'],
      text: 'Your line is dead during class hours ({hours}), exactly when a parent would call.',
    },
    {
      needs: ['event'],
      text: 'With {event} coming up, a dead number is the first thing a parent hits.',
    },
    {
      needs: ['instructor'],
      text: 'Nothing reached {instructor}; the number drops out before the second ring.',
    },
    {
      needs: ['offer'],
      text: 'I wanted to ask about the {offer} and the call did not go through.',
    },
    {
      needs: ['program'],
      text: 'One line, no pitch: the number I have for your {program} classes does not ring.',
    },
    { needs: ['day'], text: 'I tried on {day} and the line was out of service then too.' },
    {
      needs: ['school'],
      text: 'The old number for {school} is out of service; this is the only route I have left.',
    },
  ],
  'answered-by-ai': [
    {
      needs: ['program'],
      text: 'Your assistant answered, which is a good sign, but it could not say whether {program} takes absolute beginners.',
    },
    {
      needs: ['hours'],
      text: 'I called during {hours}; the assistant handled it, so this is about the one thing it could not answer.',
    },
    {
      needs: ['offer'],
      text: 'I asked the assistant about the {offer} and it looped, so a line from you closes it.',
    },
    {
      needs: ['event'],
      text: 'With {event} coming up, an assistant that cannot book is the bottleneck, not the phone.',
    },
    {
      needs: ['since'],
      text: 'You have taught since {since}; the assistant cannot yet tell a nervous beginner from a member.',
    },
    {
      needs: ['program'],
      text: 'The assistant could not book a {program} trial, so I am asking the person behind it.',
    },
    {
      needs: ['instructor'],
      text: 'I asked for {instructor} and the assistant kept me in the menu.',
    },
    {
      needs: ['school'],
      text: 'The assistant at {school} answered cleanly; the only gap was a human answer about classes.',
    },
  ],
  'owner-answers': [
    {
      needs: ['program'],
      text: 'You answered yourself, so I will keep this to one line about {program}.',
    },
    {
      needs: ['hours'],
      text: 'You picked up during {hours}, which is exactly the problem I am ringing about.',
    },
    {
      needs: ['instructor'],
      text: '{instructor} is the name on the staff page, so one message to the right person beats another cold call.',
    },
    {
      needs: ['offer'],
      text: 'One question about the {offer}, then I will leave you to the class.',
    },
    { needs: ['event'], text: 'With {event} coming up, your phone will ring more, not less.' },
    {
      needs: ['since'],
      text: 'You have answered your own calls since {since}; one of them was mine.',
    },
    {
      needs: ['style'],
      text: 'Your {style} classes are the reason for the call; the phone is the reason it was short.',
    },
    {
      needs: ['day'],
      text: 'I caught you on {day} between classes, so this is the longer version.',
    },
    {
      needs: ['school'],
      text: 'One line about how {school} answers its calls, and then I will leave you alone.',
    },
  ],
  booked: [
    {
      needs: ['day', 'program'],
      text: 'Booked for the {program} class on {day}; I will watch quietly and stay out of the way.',
    },
    { needs: ['hours'], text: 'See you during {hours}; I will come a few minutes early.' },
    {
      needs: ['instructor'],
      text: 'Looking forward to meeting {instructor}; I will bring three questions and no more.',
    },
    { needs: ['offer'], text: 'We booked after the {offer}; that was the line that decided it.' },
    { needs: ['since'], text: 'A school running since {since} is the right first demo for me.' },
    {
      needs: ['program'],
      text: 'Booked; I want to see how a {program} class is actually run before I say anything.',
    },
    { needs: ['event'], text: 'I will be there before {event} so we can talk while it is quiet.' },
  ],
};

/** Sentences are a line in a spreadsheet cell, not a paragraph. */
const MAX_SENTENCE_CHARS = 190;

function hash(seed: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    value ^= seed.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

/**
 * A seeded shuffle (Fisher–Yates with an xorshift), so two rows of the same tab
 * do not all open with the same sentence while a re-push stays identical.
 */
function shuffle<T>(items: readonly T[], seed: string): T[] {
  const out = [...items];
  let state = hash(seed) || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const YEAR = /^(19|20)\d{2}$/;

/** The values a sentence may use, from facts the worker actually found. */
export function buildSlots(profile: SchoolProfile): Partial<Record<Slot, string>> {
  const slots: Partial<Record<Slot, string>> = {};
  const program = profile.programs[0];
  const style = profile.styles[0] ?? program;
  if (program) slots.program = program;
  if (style) slots.style = style;
  if (profile.audiences[0]) slots.audience = profile.audiences[0];
  if (profile.instructors[0]) slots.instructor = profile.instructors[0];
  if (profile.events[0]) slots.event = EVENT_PHRASE[profile.events[0]] ?? profile.events[0];
  if (profile.days[0]) slots.day = profile.days[0];
  if (profile.times[0]) slots.time = profile.times[0];
  if (profile.hours[0]) slots.hours = profile.hours[0];
  if (profile.offers[0]) slots.offer = profile.offers[0];
  if (profile.since) {
    if (YEAR.test(profile.since)) slots.since = profile.since;
    else slots.age = profile.since.replace(/\byears?\b/i, 'years');
  }
  return slots;
}

function fill(structure: SentenceStructure, slots: Partial<Record<Slot, string>>): string | null {
  let text = structure.text;
  for (const slot of structure.needs) {
    const value = slots[slot];
    if (!value) return null;
    text = text.split(`{${slot}}`).join(value);
  }
  if (/\{[a-z]+\}/.test(text) || text.length > MAX_SENTENCE_CHARS) return null;
  return text.endsWith('.') ? text : `${text}.`;
}

export interface PersonalisationInput {
  /** Tags in selection order: the first one picks the angle. */
  tags: readonly CallStatusTag[];
  profile: SchoolProfile | null;
  /** The school's name, for the fallbacks that need a subject. */
  school?: string | null;
  /** Usually spreadsheetId:sheetTitle:rowIndex:tags — keeps re-pushes identical. */
  seed: string;
}

export interface Personalisation {
  sentences: string[];
  /** Why the cell has fewer than three sentences (shown on the Dial page). */
  note: string | null;
}

/**
 * Up to three sentences for the chosen status, using only facts the worker
 * found. Specific structures win (days, hours and instructors before a bare
 * programme name), one per topic where possible, and the seed keeps a re-push
 * of the same row byte-for-byte stable.
 */
export function personaliseStatus({
  tags,
  profile,
  school,
  seed,
}: PersonalisationInput): Personalisation {
  if (!profile) {
    return {
      sentences: [],
      note: 'No profile for this row yet. Run Personalize for this tab, then push again.',
    };
  }
  const angle = TAG_ANGLE[tags[0] ?? 'Rang out'] ?? 'missed';
  const slots = buildSlots(profile);
  if (school) slots.school = school;
  const usable = SENTENCE_BANK[angle].filter((s) => s.needs.every((slot) => slots[slot]));
  if (usable.length === 0) {
    return { sentences: [], note: 'The pages we read had nothing specific enough to personalise.' };
  }

  // Most specific first; within one specificity the seed decides, so different
  // rows and different tags do not all read the same.
  const groups = new Map<number, SentenceStructure[]>();
  for (const structure of usable) {
    const key = structure.needs.length;
    groups.set(key, [...(groups.get(key) ?? []), structure]);
  }
  const ordered = [...groups.keys()]
    .sort((a, b) => b - a)
    .flatMap((key) => shuffle(groups.get(key)!, `${seed}:${angle}:${key}`));

  const sentences: string[] = [];
  const usedSlots = new Set<Slot>();
  const picked: SentenceStructure[] = [];
  const take = (onePerTopic: boolean) => {
    for (const structure of ordered) {
      if (sentences.length >= 3) return;
      const text = fill(structure, slots);
      if (!text || sentences.includes(text)) continue;
      // Two sentences built from exactly the same facts say the same thing twice.
      if (
        picked.some(
          (other) =>
            other.needs.every((slot) => structure.needs.includes(slot)) &&
            structure.needs.every((slot) => other.needs.includes(slot)),
        )
      )
        continue;
      if (onePerTopic && usedSlots.has(structure.needs[0]!)) continue;
      for (const slot of structure.needs) usedSlots.add(slot);
      picked.push(structure);
      sentences.push(text);
    }
  };
  take(true); // one sentence per leading fact where the bank allows it
  take(false); // then the best remaining ones

  return {
    sentences,
    note:
      sentences.length === 3
        ? null
        : `Only ${sentences.length} of 3 sentences had facts behind them for this school.`,
  };
}
