import type { ConfigService } from '@nestjs/config';
import { TAG_EMAIL_TEMPLATE } from '@pstn-twilio/shared';
import { describe, expect, it, vi } from 'vitest';

import { FollowUpRenderer } from './follow-up-renderer.service';
import {
  DEMO_NUMBERS,
  loadSequence,
  renderSequenceEmail,
  SEQUENCE_VARIABLES,
  sequenceDueAt,
  type SequenceVars,
} from './follow-up-sequences';
import {
  buildSequenceVars,
  cityFromAddress,
  parseStatusCell,
  regionFor,
  rowRecord,
  stateFor,
  streetFromAddress,
  websiteDisplay,
  type FollowUpContext,
} from './follow-up-vars';
import { SheetsFollowUpService } from './sheets-follow-up.service';
import { SheetsConfig } from './sheets.config';
import { GoogleAuthError } from './sheets.service';

const SHEETS = { usSheetId: 'us-sheet', ukSheetId: 'uk-sheet' };

const US_ROW = rowRecord(
  ['title', 'websiteurl', 'rating', 'reviewcount', 'category', 'address', 'phonenumber', 'target'],
  [
    'Guetho Texas BJJ',
    'http://amarillobjj.com/',
    '5',
    '100',
    'Martial arts school',
    '8910 SW 34th Ave Suite 500, Amarillo, TX 79124',
    '+1 (806) 803-9393',
    'Randall County, Texas, USA',
  ],
);
const US_CTX: FollowUpContext = {
  spreadsheetId: 'us-sheet',
  sheetTitle: 'Texas',
  destinationE164: '+18068039393',
  callerE164: '+18776524532',
  cellValue: 'Rang out, A kid picked up and put the phone down, from: 8776524532, time: 3:28pm',
  customNote: null,
  schoolName: 'Guetho Texas BJJ',
  callEndedAt: new Date('2026-10-03T20:28:00Z'), // Saturday 3:28pm in Amarillo
  timeZone: 'America/Chicago',
};

const UK_ROW = rowRecord(
  ['title', 'websiteurl', 'rating', 'reviewcount', 'category', 'address', 'phonenumber', 'target'],
  [
    'Neon Martial Arts & Fitness Centre',
    'https://www.neonmartialarts.com',
    '5',
    '57',
    'Martial arts school',
    'Testlands Wellbeing Hub, Green Ln, Southampton SO16 9FQ',
    '+447448999008',
    'Cumbria, England, UK',
  ],
);
const UK_CTX: FollowUpContext = {
  spreadsheetId: 'uk-sheet',
  sheetTitle: 'Sheet1',
  destinationE164: '+447448999008',
  callerE164: '+442045726501',
  cellValue:
    "Rang out, You don't even have a recorded voice message, from: 02045726501, time: 10:28am on a Monday",
  customNote: null,
  schoolName: null,
  callEndedAt: new Date('2026-10-05T09:28:00Z'),
  timeZone: 'Europe/London',
};

describe('sequence files', () => {
  it('has 6 emails per status, only known variables, and the demo line in every email', () => {
    for (const key of Object.values(TAG_EMAIL_TEMPLATE)) {
      const emails = loadSequence(key);
      expect(
        emails.map((e) => e.step),
        key,
      ).toEqual([1, 2, 3, 4, 5, 6]);
      for (const email of emails) {
        const used = [...`${email.subject}${email.body}`.matchAll(/\{\{(\w+)\}\}/g)].map(
          (m) => m[1],
        );
        for (const name of used) expect(SEQUENCE_VARIABLES, `${key} ${email.step}`).toContain(name);
        expect(email.body, `${key} ${email.step}`).toContain('(667) 220-6726');
        expect(email.subject).not.toMatch(/^Subject:/);
      }
    }
  });

  it('keeps the copy exactly as written, typos included', () => {
    const [first, second] = loadSequence('rang-out');
    expect(first!.subject).toBe('it rang out at {{call_time}}');
    expect(first!.body.startsWith('Hey,\n\nI called {{school_name}} on {{called_number}}')).toBe(
      true,
    );
    expect(second!.body).toContain('She dosnt try the one that rang out a second time.');
  });
});

describe('Status cell', () => {
  it('splits tags, note, caller and time', () => {
    expect(parseStatusCell(UK_CTX.cellValue)).toEqual({
      tags: ['Rang out'],
      note: "You don't even have a recorded voice message",
      from: '02045726501',
      time: '10:28am',
      weekday: 'Monday',
    });
    expect(parseStatusCell('Stayed silent, from: 8776524532, time: 3:21pm')).toEqual({
      tags: ['Stayed silent'],
      note: null,
      from: '8776524532',
      time: '3:21pm',
      weekday: null,
    });
    const both = parseStatusCell(
      "Rang out but voicemail box hasn't been set up yet, Voicemail, tried twice, from: 02045726501, time: 9:05am",
    );
    expect(both.tags).toEqual(["Rang out but voicemail box hasn't been set up yet", 'Voicemail']);
    expect(both.note).toBe('tried twice');
  });
});

describe('addresses', () => {
  it('finds the street name, city and state in US addresses', () => {
    const a = '8910 SW 34th Ave Suite 500, Amarillo, TX 79124';
    expect(streetFromAddress(a, 'US')).toBe('SW 34th Ave');
    expect(cityFromAddress(a, 'US')).toBe('Amarillo');
    expect(stateFor({}, a, 'US', 'Texas')).toBe('Texas');
    expect(streetFromAddress('4354B Dacy Ln #3, Buda, TX 78610', 'US')).toBe('Dacy Ln');
    expect(streetFromAddress('1816 US-96, Lumberton, TX 77657', 'US')).toBe('US-96');
    // No state in the address: "target", then the tab name.
    expect(stateFor({ target: 'Orange County, Texas, USA' }, 'Somewhere', 'US', 'x')).toBe('Texas');
    expect(stateFor({}, 'Somewhere', 'US', 'Florida')).toBe('Florida');
  });

  it('finds the street and town in UK addresses, skipping buildings and units', () => {
    expect(streetFromAddress('Testlands Wellbeing Hub, Green Ln, Southampton SO16 9FQ', 'UK')).toBe(
      'Green Ln',
    );
    expect(streetFromAddress('Unit 7 Barfield Cl, Winchester SO23 9SQ', 'UK')).toBe('Barfield Cl');
    expect(streetFromAddress('Taro Leisure Centre, Petersfield GU31 4EX', 'UK')).toBeNull();
    expect(streetFromAddress('Unit E, The Factory, Dippenhall, Farnham GU10 5DW', 'UK')).toBeNull();
    expect(cityFromAddress('Derwent Block, Gargrave Rd, Skipton BD23 1US', 'UK')).toBe('Skipton');
    expect(cityFromAddress('Skill Centre, Limberline Spur, Hilsea, The PO3 5LF', 'UK')).toBe(
      'Hilsea',
    );
    // The UK has no states, and "target" is the search area: the town is used.
    expect(
      stateFor({ target: 'Cumbria, England, UK' }, '65 E Parade, Ilkley LS29 8JP', 'UK', 'Sheet1'),
    ).toBe('Ilkley');
  });

  it('shows websites the way people type them', () => {
    expect(websiteDisplay('https://www.teamhask.co.uk/?utm_source=gmb')).toBe('teamhask.co.uk');
    expect(websiteDisplay('http://amarillobjj.com/')).toBe('amarillobjj.com');
  });
});

describe('sequence variables', () => {
  it('maps a U.S. Conquest row and its Status cell', () => {
    expect(buildSequenceVars(US_ROW, US_CTX, 'US')).toEqual({
      school_name: 'Guetho Texas BJJ',
      website: 'amarillobjj.com',
      rating: '5',
      review_count: '100',
      category: 'martial arts school',
      street: 'SW 34th Ave',
      city: 'Amarillo',
      state: 'Texas',
      called_number: '(806) 803-9393',
      my_number: '(877) 652-4532',
      call_time: '3:28pm on Saturday',
      call_note: 'A kid picked up and put the phone down.',
    });
  });

  it('maps a The Official UK row with UK numbers written locally', () => {
    const vars = buildSequenceVars(UK_ROW, UK_CTX, 'UK');
    expect(vars).toMatchObject({
      website: 'neonmartialarts.com',
      street: 'Green Ln',
      city: 'Southampton',
      state: 'Southampton',
      called_number: '07448999008',
      my_number: '02045726501',
      call_time: '10:28am on Monday',
      call_note: "You don't even have a recorded voice message.",
    });
  });

  it('picks the region from the spreadsheet, else from the lead number', () => {
    expect(regionFor({ spreadsheetId: 'uk-sheet', destinationE164: '+1555' }, SHEETS)).toBe('UK');
    expect(regionFor({ spreadsheetId: 'us-sheet', destinationE164: '+44 20' }, SHEETS)).toBe('US');
    expect(regionFor({ spreadsheetId: 'other', destinationE164: '+447448999008' }, SHEETS)).toBe(
      'UK',
    );
    expect(regionFor({ spreadsheetId: 'other', destinationE164: '+18068039393' }, SHEETS)).toBe(
      'US',
    );
  });
});

describe('rendering', () => {
  const usVars = buildSequenceVars(US_ROW, US_CTX, 'US');
  const ukVars = buildSequenceVars(UK_ROW, UK_CTX, 'UK');

  it('fills email 1 for U.S. Conquest with the US demo line', () => {
    const email = renderSequenceEmail(loadSequence('rang-out')[0]!, usVars, 'US')!;
    expect(email.subject).toBe('it rang out at 3:28pm on Saturday');
    expect(email.body).toContain(
      'I called Guetho Texas BJJ on (806) 803-9393 at 3:28pm on Saturday and it just rang and rang.',
    );
    expect(email.body).toContain(
      'I called from (877) 652-4532 if you want to check your log.\n\nA kid picked up',
    );
    expect(email.body).toContain('Call the demo at (667) 220-6726');
    expect(email.body).not.toMatch(/\{\{/);
  });

  it('uses exactly 02045726501 for The Official UK, in subjects too', () => {
    for (const key of Object.values(TAG_EMAIL_TEMPLATE)) {
      for (const template of loadSequence(key)) {
        const email = renderSequenceEmail(template, ukVars, 'UK')!;
        expect(email.body, `${key} ${template.step}`).toContain(DEMO_NUMBERS.UK);
        expect(`${email.subject}\n${email.body}`).not.toContain('(667) 220-6726');
        expect(`${email.subject}\n${email.body}`).not.toMatch(/\{\{/);
      }
    }
  });

  it('keeps U.S. Conquest on (667) 220-6726 in every email, never the UK line', () => {
    for (const key of Object.values(TAG_EMAIL_TEMPLATE)) {
      for (const template of loadSequence(key)) {
        const email = renderSequenceEmail(template, usVars, 'US')!;
        expect(email.body, `${key} ${template.step}`).toContain(DEMO_NUMBERS.US);
        expect(`${email.subject}\n${email.body}`).not.toContain(DEMO_NUMBERS.UK);
      }
    }
  });

  it('maps the two workbooks to their own demo lines by spreadsheet ID', () => {
    const cfg = new SheetsConfig({ get: () => undefined } as unknown as ConfigService);
    const sheets = { usSheetId: cfg.conquestSheetId, ukSheetId: cfg.ukSheetId };
    expect(sheets.usSheetId).not.toBe(sheets.ukSheetId);
    // Even a number that looks like the other country follows its workbook.
    expect(regionFor({ spreadsheetId: cfg.conquestSheetId, destinationE164: '+447' }, sheets)).toBe(
      'US',
    );
    expect(regionFor({ spreadsheetId: cfg.ukSheetId, destinationE164: '+1806' }, sheets)).toBe(
      'UK',
    );
  });

  it('drops the empty note line and never repeats a UK town', () => {
    const email = renderSequenceEmail(
      loadSequence('has-ai')[5]!,
      { ...ukVars, call_note: '' },
      'UK',
    )!;
    expect(email.body).toContain('parents in Southampton ask your AI');
    expect(email.body).not.toContain('Southampton, Southampton');
    const first = renderSequenceEmail(
      loadSequence('voicemail')[0]!,
      { ...ukVars, call_note: '' },
      'UK',
    )!;
    expect(first.body).not.toMatch(/\n\n\n/);
  });

  it('says "in <town>" when the lead has no street', () => {
    const vars: SequenceVars = { ...ukVars, street: '' };
    const email = renderSequenceEmail(loadSequence('rang-out')[4]!, vars, 'UK')!;
    expect(email.body).toContain('A school in Southampton with your reviews');
    const busy = renderSequenceEmail(
      loadSequence('line-busy')[4]!,
      { ...usVars, street: '' },
      'US',
    )!;
    expect(busy.body).toContain('For a school in Texas thats alot of parents');
  });

  it('skips an email whose data is missing instead of leaving a blank', () => {
    const vars: SequenceVars = { ...usVars, rating: '' };
    expect(renderSequenceEmail(loadSequence('rang-out')[2]!, vars, 'US')).toBeNull();
    expect(renderSequenceEmail(loadSequence('rang-out')[0]!, vars, 'US')).not.toBeNull();
  });

  it('schedules emails on days 2, 4, 7, 10, 14 and 21 after the call', () => {
    const call = new Date('2026-10-01T15:00:00Z');
    const day = (n: number) => new Date(call.getTime() + n * 86400_000).toISOString();
    expect(sequenceDueAt(call, 2, call).toISOString()).toBe(day(4));
    expect(sequenceDueAt(call, 6, call).toISOString()).toBe(day(21));
    // Running late: never closer than 20 hours to the previous email.
    const late = new Date(day(10)); // email 3 went out on the day email 4 was due
    expect(sequenceDueAt(call, 4, late).toISOString()).toBe(
      new Date(late.getTime() + 20 * 3600_000).toISOString(),
    );
  });
});

function pushLog(overrides: Record<string, unknown> = {}) {
  return {
    id: 'log1',
    connectionId: 'c1',
    spreadsheetId: 'us-sheet',
    sheetTitle: 'Texas',
    rowIndex: 5,
    destinationE164: US_CTX.destinationE164,
    callerE164: US_CTX.callerE164,
    tags: ['Rang out'],
    customNote: null,
    cellValue: US_CTX.cellValue,
    timeZone: US_CTX.timeZone,
    schoolName: 'Guetho Texas BJJ',
    emailStatus: 'PENDING',
    emailTo: 'owner@school.test',
    emailTemplate: 'rang-out',
    sequenceStep: 1,
    rowData: US_ROW,
    emailDueAt: new Date(),
    emailAttempts: 0,
    emailError: null,
    emailSentAt: null,
    contactFormUrl: null,
    formLeaseToken: null,
    callEndedAt: US_CTX.callEndedAt,
    createdAt: new Date(),
    updatedAt: new Date(),
    connection: { userId: 'u1' },
    ...overrides,
  };
}

function renderer(sheetsRow: unknown = null) {
  const prisma = { sheetsPushLog: { update: vi.fn().mockResolvedValue({}) } };
  const sheets = { readLeadRow: vi.fn().mockResolvedValue(sheetsRow) };
  const cfg = { conquestSheetId: 'us-sheet', ukSheetId: 'uk-sheet' };
  return {
    renderer: new FollowUpRenderer(prisma as never, sheets as never, cfg as never),
    prisma,
    sheets,
  };
}

describe('FollowUpRenderer', () => {
  it('renders the next email from the row snapshot', async () => {
    const { renderer: r, sheets } = renderer();
    const email = await r.render(pushLog({ sequenceStep: 2 }) as never, 'u1');
    expect(email).toMatchObject({
      step: 2,
      region: 'US',
      subject: 'the mom who never calls twice',
    });
    expect(email!.body).toContain('She googles martial arts school in Amarillo');
    expect(sheets.readLeadRow).not.toHaveBeenCalled();
  });

  it('reads the row once for pushes made before snapshots, and keeps it', async () => {
    const { renderer: r, sheets, prisma } = renderer(UK_ROW);
    const email = await r.render(
      pushLog({
        rowData: null,
        spreadsheetId: 'uk-sheet',
        destinationE164: UK_CTX.destinationE164,
        cellValue: UK_CTX.cellValue,
        timeZone: UK_CTX.timeZone,
        callEndedAt: UK_CTX.callEndedAt,
      }) as never,
      'u1',
    );
    expect(sheets.readLeadRow).toHaveBeenCalledWith(
      'u1',
      'uk-sheet',
      'Texas',
      UK_CTX.destinationE164,
    );
    expect(prisma.sheetsPushLog.update).toHaveBeenCalledWith({
      where: { id: 'log1' },
      data: { rowData: UK_ROW },
    });
    expect(email!.body).toContain('02045726501');
  });

  it('skips emails the lead has no data for', async () => {
    const { renderer: r } = renderer();
    const email = await r.render(
      pushLog({ sequenceStep: 3, rowData: { ...US_ROW, rating: '' } }) as never,
      'u1',
    );
    // Email 3 needs the rating; email 4 doesn't.
    expect(email?.step).toBe(4);
  });
});

describe('SheetsFollowUpService sequence sweep', () => {
  function sweepService(...logs: ReturnType<typeof pushLog>[]) {
    const prisma = {
      sheetsPushLog: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi
          .fn()
          .mockResolvedValueOnce([]) // research
          .mockResolvedValueOnce(logs),
        update: vi.fn().mockResolvedValue({}),
      },
      emailFinderRow: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const gmail = {
      send: vi.fn().mockResolvedValue('msg-1'),
      hasReplyFrom: vi.fn().mockResolvedValue(null),
    };
    const { renderer: r } = renderer();
    return {
      service: new SheetsFollowUpService(prisma as never, gmail as never, r),
      prisma,
      gmail,
    };
  }

  it('sends email 1 and schedules email 2 for day 4', async () => {
    const log = pushLog();
    const { service, prisma, gmail } = sweepService(log);
    await service.sweep(new Date());
    expect(gmail.send).toHaveBeenCalledWith(
      'u1',
      'owner@school.test',
      'it rang out at 3:28pm on Saturday',
      expect.stringContaining('(667) 220-6726'),
    );
    const update = prisma.sheetsPushLog.update.mock.calls.at(-1)![0];
    expect(update.data).toMatchObject({
      emailStatus: 'PENDING',
      sequenceStep: 2,
      emailAttempts: 0,
    });
    expect(update.data.emailDueAt.getTime()).toBeGreaterThan(
      US_CTX.callEndedAt.getTime() + 4 * 86400_000 - 1,
    );
  });

  it('stops the sequence once the lead has replied', async () => {
    const log = pushLog({ sequenceStep: 3, emailSentAt: new Date() });
    const { service, prisma, gmail } = sweepService(log);
    gmail.hasReplyFrom.mockResolvedValue(true);
    await service.sweep(new Date());
    expect(gmail.hasReplyFrom).toHaveBeenCalledWith('u1', 'owner@school.test', US_CTX.callEndedAt);
    expect(gmail.send).not.toHaveBeenCalled();
    expect(prisma.sheetsPushLog.update.mock.calls.at(-1)![0].data).toEqual({
      emailStatus: 'REPLIED',
      emailError: null,
    });
  });

  it('keeps going when replies cannot be checked', async () => {
    const log = pushLog({ sequenceStep: 2, emailSentAt: new Date() });
    const { service, gmail } = sweepService(log);
    gmail.hasReplyFrom.mockRejectedValue(new Error('Gmail search failed: 500'));
    await service.sweep(new Date());
    expect(gmail.send).toHaveBeenCalledTimes(1);
  });

  it('holds the sequence while Google access is revoked, without using up attempts', async () => {
    const log = pushLog({ emailAttempts: 1 });
    const other = pushLog({ id: 'log2', emailTo: 'info@other.test' });
    const { service, prisma, gmail } = sweepService(log, other);
    gmail.send.mockRejectedValue(
      new GoogleAuthError('Google access was revoked or expired. Reconnect in Settings.'),
    );
    const now = new Date(US_CTX.callEndedAt.getTime() + 2 * 86400_000);
    await service.sweep(now);
    expect(prisma.sheetsPushLog.update.mock.calls.at(-1)![0].data).toEqual({
      emailStatus: 'PENDING',
      emailAttempts: 1,
      emailDueAt: new Date(now.getTime() + 3600_000),
      emailError: 'Google access was revoked or expired. Reconnect in Settings.',
    });
    // The same account's next email waits without another failing try.
    expect(gmail.send).toHaveBeenCalledTimes(1);
    expect(prisma.sheetsPushLog.updateMany).toHaveBeenCalledWith({
      where: { id: 'log2', emailStatus: 'PENDING' },
      data: { emailDueAt: new Date(now.getTime() + 3600_000) },
    });
  });

  it('gives up on an email once Google stayed disconnected 3 days past its day', async () => {
    const log = pushLog();
    const { service, prisma, gmail } = sweepService(log);
    gmail.send.mockRejectedValue(new GoogleAuthError('Google access was revoked or expired.'));
    // Email 1 was due 2 days after the call.
    await service.sweep(new Date(US_CTX.callEndedAt.getTime() + 5 * 86400_000 + 60_000));
    expect(prisma.sheetsPushLog.update.mock.calls.at(-1)![0].data).toMatchObject({
      emailStatus: 'FAILED',
      emailError: expect.stringContaining('disconnected for over 3 days'),
    });
  });

  it('finishes the sequence after email 6', async () => {
    const log = pushLog({ sequenceStep: 6, emailSentAt: new Date() });
    const { service, prisma, gmail } = sweepService(log);
    await service.sweep(new Date());
    expect(gmail.send).toHaveBeenCalledWith(
      'u1',
      'owner@school.test',
      'closing the loop on Guetho Texas BJJ',
      expect.any(String),
    );
    expect(prisma.sheetsPushLog.update.mock.calls.at(-1)![0].data).toMatchObject({
      emailStatus: 'SENT',
      sequenceStep: 6,
    });
  });
});
