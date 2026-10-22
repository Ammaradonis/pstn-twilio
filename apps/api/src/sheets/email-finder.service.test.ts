import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import type { RedisService } from '../redis/redis.service';

import { ContactFormService } from './contact-form.service';
import {
  EmailFinderService,
  cleanEnrichment,
  fingerprint,
  socialColumnsFull,
} from './email-finder.service';
import { findColumns, type SheetsService } from './sheets.service';
import { normalizeHeader } from './sheets.util';

describe('email finder row identity and writes', () => {
  it('distinguishes same-name schools with no phone or website by address', () => {
    const cols = findColumns(['title', 'address']);
    expect(fingerprint(['Tiger Dojo', '1 Main Street'], cols)).not.toBe(
      fingerprint(['Tiger Dojo', '2 Main Street'], cols),
    );
    expect(fingerprint([' Tiger  Dojo ', '1 Main Street'], cols)).toBe(
      fingerprint(['tiger dojo', '1 Main Street'], cols),
    );
  });

  it('writes every duplicate row, preserves a manually added email, and uses RAW cells', async () => {
    const sheetRows = [
      ['title', 'address', 'email'],
      ['Tiger Dojo', '1 Main St'],
      ['Tiger Dojo', '1 Main St'],
      ['Tiger Dojo', '1 Main St', 'already@dojo.org'],
    ];
    const job = {
      id: 'job',
      userId: 'u',
      spreadsheetId: 'spreadsheet',
      sheetTitle: 'Schools',
      status: 'RUNNING',
    };
    const cols = findColumns(['title', 'address', 'email']);
    const result = {
      id: 'row',
      fingerprint: fingerprint(sheetRows[1]!, cols),
      email: 'owner@dojo.org',
      emailType: 'decision-maker',
      sourceUrl: 'https://dojo.org/contact',
      decisionMaker: null,
      contactFormUrl: null,
    };
    const prisma = {
      emailFinderJob: { findUnique: vi.fn().mockResolvedValue(job), updateMany: vi.fn() },
      emailFinderRow: {
        findMany: vi.fn().mockResolvedValue([result]),
        updateMany: vi.fn(),
        count: vi.fn().mockResolvedValue(0),
      },
    };
    const sheets = {
      getAccessToken: vi.fn().mockResolvedValue('test'),
      fetchTabs: vi.fn().mockResolvedValue([{ title: 'Schools', sheetId: 1, columnCount: 20 }]),
      fetchRows: vi.fn().mockResolvedValue(sheetRows),
      google: vi.fn().mockResolvedValue({}),
    };
    const service = new EmailFinderService(
      prisma as unknown as PrismaService,
      sheets as unknown as SheetsService,
      {} as RedisService,
      {} as RealtimeService,
    );
    await service.flush('job');
    const request = sheets.google.mock.calls[0]![3] as {
      body: { valueInputOption: string; data: { range: string; values: string[][] }[] };
    };
    expect(request.body.valueInputOption).toBe('RAW');
    const emails = request.body.data.filter((d) => d.values[0]?.[0] === 'owner@dojo.org');
    expect(emails.map((d) => d.range)).toEqual(["'Schools'!C2", "'Schools'!C3"]);
  });

  it('fills only empty cells with what the finder verified and follows the row identity', async () => {
    const header = [
      'title',
      'address',
      'phoneNumber',
      'websiteUrl',
      'facebookUrl',
      'instagramUrl',
      'youtubeUrl',
      'email',
    ];
    const sheetRows = [
      header,
      [
        'California School of Martial Arts',
        '2025 Gellert Blvd, Daly City, CA 94015',
        '',
        'http://www.calsma.com',
        '',
        'https://www.instagram.com/typed_by_hand/',
      ],
    ];
    const cols = findColumns(header.map(normalizeHeader));
    const result = {
      id: 'row-1',
      fingerprint: fingerprint(sheetRows[1]!, cols),
      email: null,
      emailType: null,
      sourceUrl: null,
      decisionMaker: null,
      contactFormUrl: null,
      enrichment: {
        phoneNumber: '+1 650-810-5595',
        websiteUrl: 'https://calsma.com/other',
        facebookUrl: 'https://www.facebook.com/people/Calsma/100083472663859/',
        instagramUrl: 'https://www.instagram.com/calsma_official/',
        youtubeUrl: 'javascript:alert(1)',
      },
    };
    const update = vi.fn().mockResolvedValue({});
    const prisma = {
      emailFinderJob: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'job',
          userId: 'u',
          spreadsheetId: 's',
          sheetTitle: 'California',
          status: 'RUNNING',
        }),
        updateMany: vi.fn(),
      },
      emailFinderRow: {
        findMany: vi.fn().mockResolvedValue([result]),
        updateMany: vi.fn(),
        update,
        count: vi.fn().mockResolvedValue(0),
      },
    };
    const sheets = {
      getAccessToken: vi.fn().mockResolvedValue('t'),
      fetchTabs: vi.fn().mockResolvedValue([{ title: 'California', sheetId: 1, columnCount: 30 }]),
      fetchRows: vi.fn().mockResolvedValue(sheetRows),
      google: vi.fn().mockResolvedValue({}),
    };
    const service = new EmailFinderService(
      prisma as unknown as PrismaService,
      sheets as unknown as SheetsService,
      {} as RedisService,
      {} as RealtimeService,
    );
    await service.flush('job');
    const written = Object.fromEntries(
      (
        sheets.google.mock.calls[0]![3] as {
          body: { data: { range: string; values: string[][] }[] };
        }
      ).body.data
        .filter((d) => !d.range.endsWith('1'))
        .map((d) => [d.range, d.values[0]![0]]),
    );
    expect(written).toEqual({
      "'California'!C2": '+1 650-810-5595',
      "'California'!E2": 'https://www.facebook.com/people/Calsma/100083472663859/',
    });
    const updated = [...sheetRows[1]!];
    updated[2] = '+1 650-810-5595';
    updated[4] = 'https://www.facebook.com/people/Calsma/100083472663859/';
    expect(update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: { fingerprint: fingerprint(updated, cols) },
    });
  });

  it('keeps only known, well-formed details', () => {
    expect(
      cleanEnrichment({
        facebookUrl: 'https://facebook.com/x',
        youtubeUrl: 'ftp://x',
        phoneNumber: 'call me',
        other: 'https://x.y',
      }),
    ).toEqual({ facebookUrl: 'https://facebook.com/x' });
    expect(cleanEnrichment(null)).toBeNull();
  });

  it('discards stale results instead of overwriting a newly leased row', async () => {
    const prisma = {
      emailFinderRow: { findFirst: vi.fn().mockResolvedValue(null), updateMany: vi.fn() },
    };
    const redis = { client: { set: vi.fn() } };
    const service = new EmailFinderService(
      prisma as unknown as PrismaService,
      {} as SheetsService,
      redis as unknown as RedisService,
      {} as RealtimeService,
    );
    expect(
      await service.submit([{ id: 'row', leaseToken: 'old-lease', status: 'NOT_FOUND' }]),
    ).toEqual({ saved: 0 });
    expect(prisma.emailFinderRow.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ leaseToken: 'old-lease', status: 'CLAIMED' }),
      }),
    );
    expect(prisma.emailFinderRow.updateMany).not.toHaveBeenCalled();
  });

  it('saves how an address was found and tells only its owner right away', async () => {
    const prisma = {
      emailFinderRow: {
        findFirst: vi.fn().mockResolvedValue({
          jobId: 'job',
          input: { title: 'Tiger Dojo' },
          job: { userId: 'u1', spreadsheetId: 'ss', sheetTitle: 'Texas' },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const realtime = { emailFinderFound: vi.fn() };
    const redis = { client: { set: vi.fn() } };
    const service = new EmailFinderService(
      prisma as unknown as PrismaService,
      {} as SheetsService,
      redis as unknown as RedisService,
      realtime as unknown as RealtimeService,
    );
    vi.spyOn(service as never, 'scheduleFlush').mockImplementation(() => undefined);
    const method = 'Facebook contact info via iPhone emulation (found via free Google search)';
    await service.submit([
      {
        id: 'row',
        leaseToken: 'lease',
        status: 'FOUND',
        email: 'Owner@TigerDojo.com',
        emailType: 'decision-maker',
        confidence: 88,
        sourceUrl: 'https://www.facebook.com/tigerdojo/about_contact_and_basic_info',
        method,
        researchComplete: true,
      },
      { id: 'row2', leaseToken: 'lease', status: 'NOT_FOUND', method: 'ignored' },
    ]);
    expect(prisma.emailFinderRow.updateMany.mock.calls[0]![0].data.method).toBe(method);
    expect(prisma.emailFinderRow.updateMany.mock.calls[1]![0].data.method).toBeNull();
    expect(realtime.emailFinderFound).toHaveBeenCalledTimes(1);
    expect(realtime.emailFinderFound).toHaveBeenCalledWith('u1', {
      find: expect.objectContaining({
        rowId: 'row',
        school: 'Tiger Dojo',
        sheetTitle: 'Texas',
        email: 'owner@tigerdojo.com',
        method,
      }),
    });
  });

  it('recovers pending sheet writes after an API restart', async () => {
    vi.useFakeTimers();
    try {
      const prisma = {
        emailFinderRow: { findMany: vi.fn().mockResolvedValue([{ jobId: 'job' }]) },
      };
      const service = new EmailFinderService(
        prisma as unknown as PrismaService,
        {} as SheetsService,
        {} as RedisService,
        {} as RealtimeService,
      );
      const flush = vi.spyOn(service, 'flush').mockResolvedValue();
      service.onModuleInit();
      await vi.advanceTimersByTimeAsync(150);
      expect(flush).toHaveBeenCalledWith('job');
      service.onModuleDestroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('social enrichment mode', () => {
  const header = ['title', 'address', 'email', 'facebookUrl', 'instagramUrl', 'youtubeUrl'];
  // findColumns expects normalized headers; production normalizes row 1 first.
  const cols = findColumns(header.map(normalizeHeader));

  function harness(jobMode: 'EMAIL' | 'ENRICH', sheetRows: (string | null)[][]) {
    const job = {
      id: 'job',
      userId: 'u',
      spreadsheetId: 'spreadsheet',
      sheetTitle: 'Texas',
      status: 'RUNNING',
      mode: jobMode,
    };
    const result = {
      id: 'row',
      fingerprint: fingerprint(sheetRows[1]!, cols),
      enrichment: {
        // The row already holds a (wrong) Facebook page; this is the correction.
        facebookUrl: 'https://www.facebook.com/correct-page',
        youtubeUrl: 'https://youtube.com/@dojo',
      },
      email: null,
      emailType: null,
      sourceUrl: null,
      decisionMaker: null,
      contactFormUrl: null,
    };
    const prisma = {
      emailFinderJob: { findUnique: vi.fn().mockResolvedValue(job), updateMany: vi.fn() },
      emailFinderRow: {
        findMany: vi.fn().mockResolvedValue([result]),
        updateMany: vi.fn(),
        count: vi.fn().mockResolvedValue(0),
      },
    };
    const sheets = {
      getAccessToken: vi.fn().mockResolvedValue('test'),
      fetchTabs: vi.fn().mockResolvedValue([{ title: 'Texas', sheetId: 1, columnCount: 20 }]),
      fetchRows: vi.fn().mockResolvedValue(sheetRows),
      google: vi.fn().mockResolvedValue({}),
    };
    const service = new EmailFinderService(
      prisma as unknown as PrismaService,
      sheets as unknown as SheetsService,
      {} as RedisService,
      {} as RealtimeService,
    );
    return { service, sheets };
  }

  function written(sheets: { google: ReturnType<typeof vi.fn> }) {
    const out: Record<string, string> = {};
    for (const call of sheets.google.mock.calls) {
      const body = (call[3] as { body?: { data?: { range: string; values: string[][] }[] } }).body;
      for (const d of body?.data ?? []) out[d.range] = d.values[0]?.[0] ?? '';
    }
    return out;
  }

  it('overwrites a social cell that already has a value', async () => {
    const rows = [
      header,
      ['Tiger Dojo', '1 Main St', 'kept@dojo.org', 'https://www.facebook.com/wrong-page', '', ''],
    ];
    const { service, sheets } = harness('ENRICH', rows);
    await service.flush('job');
    const cells = written(sheets);
    // facebookUrl is column D (4th), row 2 -> D2 replaced.
    expect(cells["'Texas'!D2"]).toBe('https://www.facebook.com/correct-page');
    // An empty social cell is filled too.
    expect(cells["'Texas'!F2"]).toBe('https://youtube.com/@dojo');
  });

  it('never overwrites the email of a row even in enrichment mode', async () => {
    const rows = [header, ['Tiger Dojo', '1 Main St', 'typed@dojo.org', '', '', '']];
    const { service, sheets } = harness('ENRICH', rows);
    // Even if a result were to carry an email, the typed-in one must survive.
    await service.flush('job');
    const cells = written(sheets);
    expect(Object.values(cells)).not.toContain('typed@dojo.org');
    expect(cells["'Texas'!C2"]).toBeUndefined();
  });

  it('still only fills empty cells in the normal email mode', async () => {
    const rows = [
      header,
      ['Tiger Dojo', '1 Main St', '', 'https://www.facebook.com/keep-me', '', ''],
    ];
    const { service, sheets } = harness('EMAIL', rows);
    await service.flush('job');
    const cells = written(sheets);
    // The address pass leaves an existing Facebook page alone.
    expect(cells["'Texas'!D2"]).toBeUndefined();
  });

  it('treats a row as complete only when every social column the sheet has is filled', () => {
    // The harness sheet has title, address, email, facebookUrl, instagramUrl,
    // youtubeUrl. Columns the sheet does not have are ignored, not counted.
    const full = ['Dojo', '1 Main', '', 'https://fb.com/a', 'https://ig.com/a', 'https://yt.com/a'];
    expect(socialColumnsFull(full, cols)).toBe(true);
    // Instagram missing: enrichment still has something to find.
    expect(
      socialColumnsFull(['Dojo', '1 Main', '', 'https://fb.com/a', '', 'https://yt.com/a'], cols),
    ).toBe(false);
    // A sheet with no social columns at all is never "complete".
    const narrow = findColumns(['title', 'address'].map(normalizeHeader));
    expect(socialColumnsFull(['Dojo', '1 Main'], narrow)).toBe(false);
  });
});

describe('contact form delivery lease', () => {
  it('requires a single transition from preparation before submitting', async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const service = new ContactFormService(
      { sheetsPushLog: { updateMany } } as unknown as PrismaService,
      {} as never,
    );
    expect(await service.arm('id', 'lease')).toEqual({ armed: true });
    expect(await service.arm('id', 'lease')).toEqual({ armed: false });
    expect(updateMany.mock.calls[0]![0]).toMatchObject({
      where: { id: 'id', formLeaseToken: 'lease', emailStatus: 'FORM_PREPARING' },
      data: { emailStatus: 'FORM_SENDING' },
    });
  });

  it('does not accept SENT for an unarmed or cancelled form', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const service = new ContactFormService(
      { sheetsPushLog: { updateMany } } as unknown as PrismaService,
      {} as never,
    );
    expect(await service.complete('id', 'lease', 'SENT')).toEqual({ saved: false });
    expect(updateMany.mock.calls[0]![0]).toMatchObject({
      where: { emailStatus: 'FORM_SENDING', formLeaseToken: 'lease' },
    });
  });
});
