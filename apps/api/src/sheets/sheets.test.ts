import { existsSync } from 'fs';
import { join } from 'path';

import {
  pickFollowUpTemplate,
  pushCallResultSchema,
  TAG_EMAIL_TEMPLATE,
  type CallStatusTag,
} from '@pstn-twilio/shared';
import { describe, expect, it } from 'vitest';

import { encodeMessage, loadTemplate, renderTemplate, templateDir } from './gmail.service';
import { parseUsAddress, resolveTimeZone } from './sheets-timezone.service';
import { buildCellValue } from './sheets.service';
import {
  a1,
  cellHasPhone,
  columnLetter,
  extractEmail,
  formatLocalTime,
  nationalDigits,
  stripCountryCode,
} from './sheets.util';

describe('phone numbers', () => {
  it('drops country codes the way locals write numbers', () => {
    expect(stripCountryCode('+442045726501')).toBe('02045726501');
    expect(stripCountryCode('+16672206726')).toBe('6672206726');
  });

  it('matches sheet cells in any common format', () => {
    const us = nationalDigits('+12055551234')!;
    for (const cell of [
      '(205) 555-1234',
      '205.555.1234',
      '+1 205-555-1234',
      '1-205-555-1234',
      '2055551234',
    ]) {
      expect(cellHasPhone(cell, us)).toBe(true);
    }
    expect(cellHasPhone('205-555-9999 / 205-555-1234', us)).toBe(true);
    expect(cellHasPhone('205-555-9999', us)).toBe(false);
    expect(cellHasPhone('', us)).toBe(false);

    const uk = nationalDigits('+442045726501')!;
    for (const cell of ['020 4572 6501', '+44 20 4572 6501', '+44 (0)20 4572 6501', '2045726501']) {
      expect(cellHasPhone(cell, uk)).toBe(true);
    }
  });
});

describe('addresses and time zones', () => {
  it('parses common one-line formats', () => {
    expect(parseUsAddress('123 Main St, Springfield, IL 62701')).toEqual({
      city: 'Springfield',
      stateCode: 'IL',
      zip: '62701',
    });
    expect(parseUsAddress('55 Gulf Breeze Pkwy, Pensacola, Florida 32501, USA')).toEqual({
      city: 'Pensacola',
      stateCode: 'FL',
      zip: '32501',
    });
    expect(parseUsAddress('Nashville, TN')).toEqual({
      city: 'Nashville',
      stateCode: 'TN',
      zip: null,
    });
    expect(parseUsAddress('10 Oak Ct, El Paso, TX, 79901-1234')).toMatchObject({
      stateCode: 'TX',
      zip: '79901',
    });
    expect(parseUsAddress('Springfield IL 62701')).toMatchObject({
      city: 'Springfield',
      stateCode: 'IL',
    });
  });

  it('resolves split states by ZIP', () => {
    const cases: [string, string][] = [
      ['1 Main St, Pensacola, FL 32501', 'America/Chicago'],
      ['1 Main St, Tallahassee, FL 32301', 'America/New_York'],
      ['1 Main St, Port St. Joe, FL 32456', 'America/New_York'],
      ['1 Main St, El Paso, TX 79901', 'America/Denver'],
      ['1 Main St, Hammond, IN 46320', 'America/Chicago'],
      ['1 Main St, Knoxville, TN 37902', 'America/New_York'],
      ['1 Main St, Nashville, TN 37201', 'America/Chicago'],
      ['1 Main St, Paducah, KY 42001', 'America/Chicago'],
      ['1 Main St, Ontario, OR 97914', 'America/Boise'],
      ['1 Main St, Window Rock, AZ 86515', 'America/Denver'],
      ['1 Main St, Phoenix, AZ 85001', 'America/Phoenix'],
    ];
    for (const [address, zone] of cases) {
      expect(resolveTimeZone(address, '+15555550100')).toEqual({ timeZone: zone, source: 'zip' });
    }
  });

  it('falls back to learned cities, known cities, then the state', () => {
    expect(resolveTimeZone('Pensacola, FL', '+1')).toEqual({
      timeZone: 'America/Chicago',
      source: 'city',
    });
    expect(resolveTimeZone('Destin, FL', '+1', { 'destin,fl': 'America/Chicago' }).source).toBe(
      'city',
    );
    expect(resolveTimeZone('Dallas, TX', '+1').source).toBe('guess');
    expect(resolveTimeZone('Denver, CO', '+1')).toEqual({
      timeZone: 'America/Denver',
      source: 'state',
    });
    expect(resolveTimeZone(null, '+442045726501')).toEqual({
      timeZone: 'Europe/London',
      source: 'uk',
    });
  });

  it('formats their local time across the clock changes', () => {
    // UK clocks go back 2026-10-25, US clocks 2026-11-01.
    expect(formatLocalTime(new Date('2026-10-24T16:45:00Z'), 'Europe/London')).toBe('5:45pm');
    expect(formatLocalTime(new Date('2026-10-26T17:45:00Z'), 'Europe/London')).toBe('5:45pm');
    expect(formatLocalTime(new Date('2026-10-31T14:45:00Z'), 'America/Chicago')).toBe('9:45am');
    expect(formatLocalTime(new Date('2026-11-02T15:45:00Z'), 'America/Chicago')).toBe('9:45am');
    expect(formatLocalTime(new Date('2026-07-01T16:45:00Z'), 'America/Phoenix')).toBe('9:45am');
    expect(formatLocalTime(new Date('2026-07-01T00:05:00Z'), 'America/New_York')).toBe('8:05pm');
  });
});

describe('status cell', () => {
  const base = {
    spreadsheetId: 's',
    sheetTitle: 'Texas',
    destinationE164: '+12055551234',
    callEndedAt: '2026-09-30T14:45:00Z',
  };

  it('matches the requested format without country codes', () => {
    expect(
      buildCellValue(
        { ...base, orderedTags: ['Voicemail', 'Not interested'], callerE164: '+442045726501' },
        '5:45pm',
      ),
    ).toBe('Voicemail, Not interested, from: 02045726501, time: 5:45pm');
    expect(
      buildCellValue(
        {
          ...base,
          orderedTags: ['Has a receptionist'],
          customNote: '  owner is Coach Mike,\n call after 4  ',
          callerE164: '+16672206726',
        },
        '9:45am',
      ),
    ).toBe('Has a receptionist, owner is Coach Mike, call after 4, from: 6672206726, time: 9:45am');
  });

  it('builds quoted A1 ranges', () => {
    expect(a1('New York', 'AB12')).toBe("'New York'!AB12");
    expect(a1("O'Fallon")).toBe("'O''Fallon'");
    expect(columnLetter(1)).toBe('A');
    expect(columnLetter(28)).toBe('AB');
  });

  it('finds an email in a cell', () => {
    expect(extractEmail('mailto: Info@TigerDojo.com ')).toBe('Info@TigerDojo.com');
    expect(extractEmail('n/a')).toBeNull();
  });
});

describe('follow-up email choice', () => {
  it('uses the first selected tag that sends email', () => {
    expect(pickFollowUpTemplate(['Voicemail', 'Not interested'])).toMatchObject({
      template: 'voicemail',
    });
    expect(pickFollowUpTemplate(['Not interested', 'Voicemail'])).toMatchObject({
      template: 'not-interested',
    });
    expect(pickFollowUpTemplate(['Not available', 'Has a receptionist'])).toMatchObject({
      template: 'has-receptionist',
    });
  });

  it('sends nothing for demos or non-email statuses', () => {
    expect(pickFollowUpTemplate(['Voicemail', 'Booked a demo']).template).toBeNull();
    expect(pickFollowUpTemplate(['Handles calls himself', 'Not available']).template).toBeNull();
  });

  it('keeps selection order and drops repeats', () => {
    const parsed = pushCallResultSchema.parse({
      spreadsheetId: 's',
      sheetTitle: 'Texas',
      orderedTags: ['Rang out', 'Voicemail', 'Rang out'],
      destinationE164: '+12055551234',
      callerE164: '+16672206726',
      callEndedAt: '2026-09-30T14:45:00.000Z',
    });
    expect(parsed.orderedTags).toEqual(['Rang out', 'Voicemail']);
    expect(() =>
      pushCallResultSchema.parse({
        ...parsed,
        orderedTags: ['Made up'] as unknown as CallStatusTag[],
      }),
    ).toThrow();
  });
});

describe('email templates', () => {
  it('has a template file for every emailing status', () => {
    const dir = templateDir();
    expect(dir).not.toBeNull();
    for (const name of Object.values(TAG_EMAIL_TEMPLATE)) {
      expect(existsSync(join(dir!, `${name}.txt`)), name).toBe(true);
    }
  });

  it('fills placeholders and closes the gap an empty note leaves', () => {
    const { subject, body } = renderTemplate(loadTemplate('voicemail'), {
      callerNumber: '6672206726',
      callDay: 'Monday',
    });
    expect(subject).toContain('voicemail');
    expect(body).toContain('on Monday');
    expect(body).toContain('6672206726');
    expect(body).not.toMatch(/\{\{|\n\n\n/);
  });

  it('encodes a UTF-8 subject', () => {
    const raw = Buffer.from(encodeMessage('a@b.co', 'Hi — there', 'Body'), 'base64url').toString();
    expect(raw).toContain('Subject: =?UTF-8?B?');
    expect(() => encodeMessage('a@b.co\r\nBcc: x@y.z', 's', 'b')).toThrow();
  });
});
