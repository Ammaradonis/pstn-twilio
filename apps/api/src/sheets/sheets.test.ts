import type { ConfigService } from '@nestjs/config';
import {
  pickFollowUpTemplate,
  pushCallResultSchema,
  TAG_EMAIL_TEMPLATE,
  type CallStatusTag,
} from '@pstn-twilio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { encryptSecret } from '../common/secret-box';

import { hasSequence, loadSequence } from './follow-up-sequences';
import { encodeMessage } from './gmail.service';
import { parseUsAddress, resolveTimeZone } from './sheets-timezone.service';
import { SheetsConfig } from './sheets.config';
import { buildCellValue, GoogleAuthError, SheetsService } from './sheets.service';
import {
  a1,
  cellHasPhone,
  columnLetter,
  extractEmail,
  formatLocalTime,
  formatStatusTime,
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

  it('formats status time with weekday', () => {
    // 2026-10-25 is a Sunday (17:40 UTC is 5:40pm London GMT after DST ends)
    expect(formatStatusTime(new Date('2026-10-25T17:40:00Z'), 'Europe/London')).toBe(
      '5:40pm on a Sunday',
    );
    // 2026-10-03 02:29 UTC is 2026-10-02 21:29 CDT (Friday 9:29pm Chicago)
    expect(formatStatusTime(new Date('2026-10-03T02:29:00Z'), 'America/Chicago')).toBe(
      '9:29pm on a Friday',
    );
  });
});

describe('status cell', () => {
  const base = {
    spreadsheetId: 's',
    sheetTitle: 'Texas',
    destinationE164: '+12055551234',
    callEndedAt: '2026-09-30T14:45:00Z',
  };

  it('matches the requested format without country codes and with weekday', () => {
    expect(
      buildCellValue(
        { ...base, orderedTags: ['Voicemail', 'Not interested'], callerE164: '+442045726501' },
        '5:40pm on a Sunday',
      ),
    ).toBe('Voicemail, Not interested, from: 02045726501, time: 5:40pm on a Sunday');
    expect(
      buildCellValue(
        {
          ...base,
          orderedTags: ['Has a receptionist'],
          customNote: '  owner is Coach Mike,\n call after 4  ',
          callerE164: '+16672206726',
        },
        '9:29pm on a Friday',
      ),
    ).toBe(
      'Has a receptionist, owner is Coach Mike, call after 4, from: 6672206726, time: 9:29pm on a Friday',
    );
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
  it('has a 6-email sequence for every emailing status', () => {
    for (const name of Object.values(TAG_EMAIL_TEMPLATE)) {
      for (const region of ['US', 'UK'] as const) {
        expect(hasSequence(name, region), `${region} ${name}`).toBe(true);
        expect(loadSequence(name, region), `${region} ${name}`).toHaveLength(6);
      }
    }
  });

  it('encodes a UTF-8 subject', () => {
    const raw = Buffer.from(encodeMessage('a@b.co', 'Hi — there', 'Body'), 'base64url').toString();
    expect(raw).toContain('Subject: =?UTF-8?B?');
    expect(() => encodeMessage('a@b.co\r\nBcc: x@y.z', 's', 'b')).toThrow();
  });
});

describe('Sheets OAuth client', () => {
  const configWith = (env: Record<string, string>) =>
    new SheetsConfig({ get: (key: string) => env[key] } as unknown as ConfigService);

  it('uses GOOGLE_CLOUD_CLIENT_*, never the retired GOOGLE_CLIENT_* pair', () => {
    const cfg = configWith({
      GOOGLE_CLIENT_ID: 'calendar-client',
      GOOGLE_CLIENT_SECRET: 'calendar-secret',
      TOKEN_ENCRYPTION_KEY: 'k',
      JWT_SECRET: 'j',
    });
    expect(cfg.googleClientId).toBeUndefined();
    expect(cfg.missing()).toEqual(['GOOGLE_CLOUD_CLIENT_ID', 'GOOGLE_CLOUD_CLIENT_SECRET']);
    expect(cfg.isConfigured()).toBe(false);
  });

  it('is ready once its own client is set', () => {
    const cfg = configWith({
      GOOGLE_CLOUD_CLIENT_ID: 'sheets-client',
      GOOGLE_CLOUD_CLIENT_SECRET: 'sheets-secret',
      TOKEN_ENCRYPTION_KEY: 'k',
      JWT_SECRET: 'j',
      TWILIO_WEBHOOK_BASE_URL: 'https://api.bestsoftphone.site/',
    });
    expect(cfg.isConfigured()).toBe(true);
    expect(cfg.googleClientId).toBe('sheets-client');
    expect(cfg.oauthRedirectUri).toBe(
      'https://api.bestsoftphone.site/webhooks/google-sheets/oauth/callback',
    );
  });
});

describe('Google connection status', () => {
  const KEY = Buffer.alloc(32, 7).toString('base64');
  const cfg = new SheetsConfig({
    get: (key: string) =>
      ({
        GOOGLE_CLOUD_CLIENT_ID: 'client',
        GOOGLE_CLOUD_CLIENT_SECRET: 'secret',
        TOKEN_ENCRYPTION_KEY: KEY,
        JWT_SECRET: 'j',
      })[key],
  } as unknown as ConfigService);
  const service = (refreshTokenEncrypted = encryptSecret('refresh-1', KEY)) =>
    new SheetsService(
      {
        googleSheetsConnection: {
          findUnique: vi.fn().mockResolvedValue({
            googleEmail: 'ammar.webalchemist@gmail.com',
            refreshTokenEncrypted,
          }),
        },
      } as never,
      cfg,
      {} as never,
    );
  const tokenReply = (status: number, body: object) =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));

  afterEach(() => vi.restoreAllMocks());

  it('is healthy when Google refreshes the saved access', async () => {
    const fetch = tokenReply(200, { access_token: 'at', expires_in: 3600 });
    await expect(service().status('u1')).resolves.toMatchObject({
      connected: true,
      email: 'ammar.webalchemist@gmail.com',
      needsReconnect: false,
      problem: null,
    });
    const body = fetch.mock.calls[0]![1]!.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-1');
  });

  it('asks for a reconnect when Google revoked or expired the access', async () => {
    tokenReply(400, {
      error: 'invalid_grant',
      error_description: 'Token has been expired or revoked.',
    });
    const status = await service().status('u1');
    expect(status).toMatchObject({ connected: true, needsReconnect: true });
    expect(status.problem).toMatch(/revoked or expired\. Reconnect/);
  });

  it('asks for a reconnect when the saved access cannot be decrypted', async () => {
    const other = encryptSecret('refresh-1', Buffer.alloc(32, 9).toString('base64'));
    await expect(service(other).getAccessToken('u1')).rejects.toBeInstanceOf(GoogleAuthError);
  });

  it('checks each sequence is tied to the workbook with the right name', async () => {
    const names: Record<string, string> = {
      [cfg.conquestSheetId]: 'U.S. Conquest ',
      [cfg.ukSheetId]: 'Old UK leads',
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      const json = (body: object) => new Response(JSON.stringify(body), { status: 200 });
      if (url.hostname === 'oauth2.googleapis.com') return json({ access_token: 'at' });
      if (url.pathname === '/drive/v3/files') {
        expect(url.searchParams.get('q')).toContain("name = 'The Official UK'");
        return json({ files: [{ id: 'real-uk-id' }] });
      }
      const id = decodeURIComponent(url.pathname.split('/').pop()!);
      return json({ name: names[id] });
    });
    const [us, uk] = await service().sequenceWorkbooks('u1');
    expect(us).toMatchObject({
      region: 'US',
      expectedName: 'U.S. Conquest',
      matches: true,
      suggestedId: null,
      demoNumber: '(667) 220-6726',
    });
    expect(uk).toMatchObject({
      region: 'UK',
      googleName: 'Old UK leads',
      matches: false,
      suggestedId: 'real-uk-id',
      demoNumber: '02045726501',
    });
  });

  it('reports a Google outage without asking for a reconnect', async () => {
    tokenReply(503, { error: 'backend_error' });
    await expect(service().status('u1')).resolves.toMatchObject({
      needsReconnect: false,
      problem: 'Google token request failed: backend_error',
    });
  });
});

describe('voicemail not set up status', () => {
  it('writes the full label and sends its own template', () => {
    const tag = "Rang out but voicemail box hasn't been set up yet";
    expect(pickFollowUpTemplate([tag])).toMatchObject({ template: 'voicemail-not-set-up' });
    // Picked before plain "Rang out", it decides the email.
    expect(pickFollowUpTemplate([tag, 'Rang out'])).toMatchObject({
      template: 'voicemail-not-set-up',
    });
    const [first] = loadSequence('voicemail-not-set-up', 'US');
    expect(first!.subject).toBe('your voicemail box isnt set up yet');
    expect(first!.body).toContain('the voicemail box hasnt been set up yet');
  });
});
