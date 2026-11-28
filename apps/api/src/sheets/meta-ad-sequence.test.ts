import { describe, expect, it } from 'vitest';

import { pickAds } from './meta-ad-outreach.service';
import {
  adQuote,
  buildMetaVars,
  firstName,
  inSendWindow,
  loadMetaSequence,
  META_SEQUENCE_LENGTH,
  metaDueAt,
  renderMetaEmail,
  type AdFacts,
} from './meta-ad-sequence';
import type { SchoolProfile } from './school-profile';

const NOW = new Date('2026-11-28T15:00:00Z');

const RUNNING: AdFacts = {
  adId: '1189707452341804',
  advertiserName: 'Seven Star Martial Arts Kids',
  status: 'ACTIVE',
  startedAt: '2026-08-27',
  endedAt: null,
  observedAt: '2026-11-27T10:00:00Z',
  adText: 'Give your child an edge in martial arts! 🥋 Classes for ages 4 and up.',
  adCta: 'Sign Up',
  adLink: 'sevenstarma.com',
  adCount: 3,
};

const ROW = {
  title: 'Seven Star Martial Arts',
  decisionmaker: 'Kathy Snyder (owner)',
  address: '1200 Main St, Austin, TX 78701',
  rating: '4.9',
  reviewcount: '212',
  category: 'Martial arts school',
  email: 'info@sevenstarma.com',
};

const PROFILE: SchoolProfile = {
  programs: ['Kids Karate'],
  audiences: [],
  styles: ['karate'],
  instructors: ['Sensei Mike'],
  events: [],
  hours: ['Tuesdays and Thursdays 5–6pm'],
  days: [],
  times: [],
  offers: ['free trial week'],
  since: null,
  sources: [],
};

const full = buildMetaVars({
  row: ROW,
  schoolTitle: ROW.title,
  sheetTitle: 'Texas',
  ad: RUNNING,
  profile: PROFILE,
  region: 'US',
  now: NOW,
});

const sparse = buildMetaVars({
  row: { title: 'Lone Dojo' },
  schoolTitle: 'Lone Dojo',
  sheetTitle: 'Texas',
  ad: {
    ...RUNNING,
    status: 'INACTIVE',
    startedAt: null,
    endedAt: null,
    adText: null,
    adCta: null,
    adLink: null,
    adCount: 1,
  },
  profile: null,
  region: 'UK',
  now: NOW,
});

describe('Meta-ad sequence copy', () => {
  const emails = loadMetaSequence();

  it('has six emails that render for a well-known school without leftovers', () => {
    expect(emails).toHaveLength(META_SEQUENCE_LENGTH);
    for (const email of emails) {
      const out = renderMetaEmail(email, full);
      expect(out.subject).not.toMatch(/\{\{|\}\}/);
      expect(out.body).not.toMatch(/\{\{|\}\}/);
      expect(out.body).toMatch(/^Hey Kathy,/);
      expect(out.body).toContain('(667) 220-6726');
      expect(out.body).toMatch(/\nAmmar(\n|$)/);
    }
  });

  it('quotes the ad, its button, its dates and the school’s own facts', () => {
    const all = emails.map((e) => renderMetaEmail(e, full).body).join('\n');
    expect(all).toContain('your Facebook ad thats been running since Aug 27');
    expect(all).toContain('"Give your child an edge in martial arts!"');
    expect(all).toContain('"Sign Up"');
    expect(all).toContain('sevenstarma.com');
    expect(all).toContain('212 reviews at 4.9 stars');
    expect(all).toContain('teaching kids karate');
    expect(all).toContain('Sensei Mike');
    expect(all).toContain('free trial week');
    expect(all).toContain('Tuesdays and Thursdays 5–6pm');
    expect(all).toContain('Austin');
    expect(renderMetaEmail(emails[0]!, full).subject).toBe('saw your ad, Kathy');
  });

  it('still sends whole emails when the school has almost no data', () => {
    for (const email of emails) {
      const out = renderMetaEmail(email, sparse);
      expect(out.body).not.toMatch(/\{\{|\}\}| {2}|" "|\(\)/);
      expect(out.body).toMatch(/^Hey,/);
      // The UK sheet's demo line.
      expect(out.body).toContain('02045726501');
      expect(out.body.split('\n\n').length).toBeGreaterThanOrEqual(4);
    }
    const first = renderMetaEmail(emails[0]!, sparse);
    expect(first.subject).toBe('saw the Lone Dojo ad');
    expect(first.body).toContain('I saw the Facebook ad you ran.');
    expect(first.body).not.toContain('good hook');
    expect(first.body).toContain('while your on the mat, it rings out');
    expect(renderMetaEmail(emails[2]!, sparse).body).not.toContain('reviews at');
  });

  it('keeps the Loom PS in email 1 and an opt-out in emails 1 to 5', () => {
    expect(renderMetaEmail(emails[0]!, full).body).toContain(
      'https://www.loom.com/share/a3614b444000454daebb01634bc47711',
    );
    for (const email of emails.slice(0, 5)) {
      expect(renderMetaEmail(email, full).body).toMatch(/no thanks/);
    }
  });

  it('refuses a template variable it does not know', () => {
    expect(() => renderMetaEmail({ step: 1, subject: 'x', body: '{{nope}}' }, full)).toThrow(
      /Unknown variable/,
    );
  });
});

describe('Meta-ad sequence details', () => {
  it('reads a first name only when the cell names a person', () => {
    expect(firstName('Kathy Snyder (owner)')).toBe('Kathy');
    expect(firstName('Master Kim')).toBe('Kim');
    expect(firstName('JOHN SMITH')).toBe('John');
    expect(firstName('Front desk')).toBe('');
    expect(firstName('Tiger Karate Academy')).toBe('');
    expect(firstName('')).toBe('');
  });

  it('quotes one clean sentence of the ad, or nothing', () => {
    expect(adQuote(RUNNING.adText)).toBe('Give your child an edge in martial arts!');
    expect(adQuote('🥋🥋 Kids!')).toBe('');
    expect(adQuote(`${'Train with us '.repeat(10)}today.`).length).toBeLessThanOrEqual(91);
    expect(adQuote(null)).toBe('');
  });

  it('sends in the school’s 8:00 to 19:00 and spaces the six emails out', () => {
    // 15:00 UTC is 9:00 in Chicago: inside the window.
    expect(inSendWindow(NOW, 'America/Chicago')).toEqual(NOW);
    // 15:00 UTC is 7:00 in Los Angeles: the next 8:00.
    expect(inSendWindow(NOW, 'America/Los_Angeles').toISOString()).toBe('2026-11-28T16:00:00.000Z');
    const first = new Date('2026-11-28T15:00:00Z');
    expect(metaDueAt(first, 2, first, 'America/Chicago').toISOString()).toBe(
      '2026-11-30T15:00:00.000Z',
    );
    expect(metaDueAt(first, 6, first, 'America/Chicago').toISOString()).toBe(
      '2026-12-12T15:00:00.000Z',
    );
    // A late email 2 still waits 20 h before email 3.
    const late = new Date('2026-12-02T14:00:00Z');
    expect(metaDueAt(first, 3, late, 'America/Chicago').getTime()).toBeGreaterThanOrEqual(
      late.getTime() + 20 * 3_600_000,
    );
  });

  it('talks about the running ad when a school has running and ended ones', () => {
    const base = {
      spreadsheetId: 's',
      sheetId: 1,
      sheetTitle: 'Texas',
      schoolTitle: 'Dojo',
      facebookUrl: '',
      advertiserName: 'Dojo',
      adText: null,
      adCta: null,
      adLink: null,
    };
    const picked = pickAds(
      [
        {
          ...base,
          adId: '1',
          status: 'INACTIVE',
          startedAt: new Date('2026-01-01'),
          endedAt: new Date('2026-03-01'),
          observedAt: NOW,
        },
        {
          ...base,
          adId: '2',
          status: 'ACTIVE',
          startedAt: new Date('2026-10-01'),
          endedAt: null,
          observedAt: NOW,
        },
      ],
      NOW,
    );
    expect(picked.size).toBe(1);
    const [school] = [...picked.values()];
    expect(school!.ad.adId).toBe('2');
    expect(school!.ad.adCount).toBe(2);
  });
});
