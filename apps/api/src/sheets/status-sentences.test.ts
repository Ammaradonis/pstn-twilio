/**
 * The Status cell's three sentences, from the bank derived from `hustle/`.
 *
 * These tests hold the line the bank is written to: a sentence only uses facts
 * the worker found, three sentences come back when the facts allow it, the same
 * row and tag always read the same way, and a school we know nothing about gets
 * no filler.
 */

import type { CallStatusTag } from '@pstn-twilio/shared';
import { CALL_STATUS_TAGS } from '@pstn-twilio/shared';
import { describe, expect, it } from 'vitest';

import { cleanProfile, type SchoolProfile } from './school-profile';
import { buildSlots, personaliseStatus, SENTENCE_BANK, TAG_ANGLE } from './status-sentences';

const rich: SchoolProfile = {
  programs: ['kids karate', 'adults karate', 'karate'],
  audiences: ['kids', 'adults'],
  styles: ['karate'],
  instructors: ['Sensei John Smith'],
  events: ['gradings', 'competitions', 'summer camps'],
  hours: ['Tuesdays and Thursdays 5–6pm', 'Mondays 7:30–9pm'],
  days: ['Tuesday', 'Thursday', 'Monday'],
  times: ['5–6pm', '7:30–9pm'],
  offers: ['a free trial class'],
  since: '1998',
  sources: ['https://dojo.example/'],
};

const bare: SchoolProfile = {
  programs: ['karate'],
  audiences: [],
  styles: ['karate'],
  instructors: [],
  events: [],
  hours: [],
  days: [],
  times: [],
  offers: [],
  since: null,
  sources: [],
};

describe('the sentence bank', () => {
  it('has an angle and enough structures for every status tag', () => {
    for (const tag of CALL_STATUS_TAGS) {
      const angle = TAG_ANGLE[tag];
      expect(angle, tag).toBeTruthy();
      // Enough for three sentences from the sparsest profile we accept.
      expect(SENTENCE_BANK[angle].length, tag).toBeGreaterThanOrEqual(3);
      for (const structure of SENTENCE_BANK[angle]) {
        expect(structure.needs.length, structure.text).toBeGreaterThan(0);
        expect(structure.text).toMatch(/\.$/);
      }
    }
  });

  it('declares exactly the facts its sentence uses', () => {
    // A structure that lists a fact it never writes ("needs: ['instructor']" with
    // no {instructor} in the text) pads the profile count without saying
    // anything, and one that writes a fact it does not declare can leak an
    // unfilled placeholder into the cell.
    for (const [angle, structures] of Object.entries(SENTENCE_BANK)) {
      for (const structure of structures) {
        const used = [...structure.text.matchAll(/\{([a-z]+)\}/g)].map((m) => m[1]).sort();
        expect(new Set(used).size, structure.text).toBe(used.length);
        expect([...structure.needs].sort(), `${angle}: ${structure.text}`).toEqual(used);
      }
    }
  });

  it('has three sentences for every tag with a profile that names three things', () => {
    for (const tag of CALL_STATUS_TAGS) {
      const { sentences, note } = personaliseStatus({
        tags: [tag],
        profile: rich,
        seed: 'sheet:row',
      });
      expect(sentences, tag).toHaveLength(3);
      expect(note, tag).toBeNull();
      for (const sentence of sentences) {
        expect(sentence.length, sentence).toBeLessThanOrEqual(190);
        expect(sentence, sentence).not.toMatch(/\{[a-z]+\}/);
        expect(sentence, sentence).toMatch(/[.!?]$/);
      }
      expect(new Set(sentences).size).toBe(3);
    }
  });

  it('uses the facts it was given and nothing else', () => {
    const { sentences } = personaliseStatus({
      tags: ['Voicemail'],
      profile: rich,
      seed: 'sheet:row',
    });
    const joined = sentences.join(' ');
    expect(joined).toMatch(/kids karate|karate/);
    // 1998 and the instructor are facts; a sentence may use either, never both.
    expect(joined).not.toMatch(/Rang out|Voicemail/);
  });

  it('reads the same way when the same row is pushed twice', () => {
    const first = personaliseStatus({ tags: ['Voicemail'], profile: rich, seed: 'a:1' });
    const again = personaliseStatus({ tags: ['Voicemail'], profile: rich, seed: 'a:1' });
    expect(again).toEqual(first);
    const other = personaliseStatus({ tags: ['Voicemail'], profile: rich, seed: 'a:2' });
    expect(other.sentences).not.toEqual(first.sentences);
  });

  it('gives the first selected tag the angle', () => {
    const missed = personaliseStatus({
      tags: ['Voicemail', 'Booked a demo'],
      profile: rich,
      seed: 's',
    });
    const booked = personaliseStatus({
      tags: ['Booked a demo', 'Voicemail'],
      profile: rich,
      seed: 's',
    });
    expect(missed.sentences).not.toEqual(booked.sentences);
  });

  it('never pads with generic filler when the school says little', () => {
    const sparse = personaliseStatus({ tags: ['Voicemail'], profile: bare, seed: 's' });
    expect(sparse.sentences.length).toBeGreaterThan(0);
    expect(sparse.sentences.length).toBeLessThanOrEqual(3);
    for (const sentence of sparse.sentences) {
      expect(sentence).toMatch(/karate/);
    }
    // The programme alone cannot fill three different sentences honestly.
    expect(sparse.note).toBeTruthy();
  });

  it('returns no sentence at all without a profile', () => {
    const none = personaliseStatus({ tags: ['Rang out'], profile: null, seed: 's' });
    expect(none.sentences).toEqual([]);
    expect(none.note).toMatch(/Personalize/);
  });

  it('turns "20 years" into an age instead of "since 20 years"', () => {
    const slots = buildSlots({ ...rich, since: '20 years' });
    expect(slots.since).toBeUndefined();
    expect(slots.age).toBe('20 years');
    expect(buildSlots(rich).since).toBe('1998');
  });
});

describe('the profile the API accepts', () => {
  it('keeps known facts and drops everything else', () => {
    const profile = cleanProfile({
      programs: ['kids karate', 'Kids Karate', 'x'.repeat(500)],
      days: ['Tuesday', 'Caturday', 'notaday'],
      known: ['ignored'],
      since: '1998',
      sources: ['https://dojo.example/', 'javascript:alert(1)'],
    });
    expect(profile?.programs).toEqual(['kids karate']);
    expect(profile?.days).toEqual(['Tuesday']);
    expect(profile?.sources).toEqual(['https://dojo.example/']);
    expect(profile).not.toHaveProperty('known');
  });

  it('is null when there is nothing to say', () => {
    expect(cleanProfile(null)).toBeNull();
    expect(cleanProfile({ sources: ['https://dojo.example/'] })).toBeNull();
    expect(cleanProfile({ programs: [] })).toBeNull();
  });

  it('caps a long list', () => {
    const profile = cleanProfile({ programs: Array.from({ length: 50 }, (_, i) => `style ${i}`) });
    expect(profile?.programs.length).toBeLessThanOrEqual(6);
  });
});

describe('the angles', () => {
  it('maps missed-call tags together and keeps the rest apart', () => {
    const missed: CallStatusTag[] = [
      'Rang out',
      'Voicemail',
      'Line is busy',
      'Stayed silent',
      'Not available',
    ];
    expect(new Set(missed.map((tag) => TAG_ANGLE[tag]))).toEqual(new Set(['missed']));
    expect(TAG_ANGLE['Booked a demo']).toBe('booked');
    expect(TAG_ANGLE['Has an AI']).toBe('answered-by-ai');
    expect(TAG_ANGLE['Out-of-service number']).toBe('dead-line');
  });
});
