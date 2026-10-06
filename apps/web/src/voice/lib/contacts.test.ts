import type { ContactDto } from '@pstn-twilio/shared';
import { describe, expect, it } from 'vitest';

import { parseVCards, searchContacts, toVCards } from './contacts';

function contact(overrides: Partial<ContactDto>): ContactDto {
  return {
    id: 'c1',
    name: 'Jane Doe',
    company: null,
    email: null,
    notes: null,
    starred: false,
    source: 'manual',
    phones: [{ e164: '+14155550100', label: 'mobile' }],
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

describe('parseVCards', () => {
  it('reads vCard 3.0 with folded lines, types and organization', () => {
    const text = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Ana Ruiz',
      'N:Ruiz;Ana;;;',
      'TEL;TYPE=CELL,VOICE:+1 (415) 555-0100',
      'item1.TEL;type=WORK:415-555-0123',
      'EMAIL;TYPE=INTERNET:ana@',
      ' example.com',
      'ORG:Harbor Crest;Front desk',
      'END:VCARD',
    ].join('\r\n');
    expect(parseVCards(text)).toEqual([
      {
        name: 'Ana Ruiz',
        phones: [
          { number: '+1 (415) 555-0100', label: 'mobile' },
          { number: '415-555-0123', label: 'work' },
        ],
        email: 'ana@example.com',
        company: 'Harbor Crest',
      },
    ]);
  });

  it('builds the name from N and decodes quoted-printable (vCard 2.1)', () => {
    const text = [
      'BEGIN:VCARD',
      'VERSION:2.1',
      'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:M=C3=BCller;J=C3=BC=',
      'rgen;;;',
      'TEL;HOME:+49 30 1234567',
      'END:VCARD',
      'BEGIN:VCARD',
      'VERSION:4.0',
      'FN:Bob',
      'TEL;VALUE=uri;TYPE=home:tel:+14155550177',
      'END:VCARD',
    ].join('\n');
    const [first, second] = parseVCards(text);
    expect(first).toEqual({
      name: 'Jürgen Müller',
      phones: [{ number: '+49 30 1234567', label: 'home' }],
    });
    expect(second).toEqual({ name: 'Bob', phones: [{ number: '+14155550177', label: 'home' }] });
  });

  it('round-trips the app’s own export', () => {
    const exported = toVCards([
      contact({
        name: 'Jane, Q. Doe',
        email: 'jane@example.com',
        company: 'ACME; Inc',
        notes: 'Line 1\nLine 2',
      }),
    ]);
    expect(exported).toContain('FN:Jane\\, Q. Doe\r\n');
    expect(exported).toContain('TEL;TYPE=CELL:+14155550100\r\n');
    expect(parseVCards(exported)).toEqual([
      {
        name: 'Jane, Q. Doe',
        phones: [{ number: '+14155550100', label: 'mobile' }],
        email: 'jane@example.com',
        company: 'ACME; Inc',
      },
    ]);
  });
});

describe('searchContacts', () => {
  const people = [
    contact({ id: 'a', name: 'Jane Doe', phones: [{ e164: '+14155550100', label: null }] }),
    contact({ id: 'b', name: 'Mark Lane', phones: [{ e164: '+12125550199', label: null }] }),
    contact({ id: 'c', name: 'Zoë Jansen', company: 'Daily Planet', phones: [] }),
  ];

  it('matches keypad letters at the start of a name word', () => {
    // 5-2-6 spells "Jan" (Jane, Jansen) and "Lan" (Lane).
    expect(
      searchContacts(people, '526')
        .map((c) => c.id)
        .sort(),
    ).toEqual(['a', 'b', 'c']);
  });

  it('matches digits inside a phone number first', () => {
    expect(searchContacts(people, '212555').map((c) => c.id)).toEqual(['b']);
  });

  it('matches names and companies by text', () => {
    expect(searchContacts(people, 'mark').map((c) => c.id)).toEqual(['b']);
    // "Planet" contains "lane": name matches rank above company matches.
    expect(searchContacts(people, 'lane').map((c) => c.id)).toEqual(['b', 'c']);
    expect(searchContacts(people, 'planet').map((c) => c.id)).toEqual(['c']);
    expect(searchContacts(people, '')).toEqual([]);
  });
});
