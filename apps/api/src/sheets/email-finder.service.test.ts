import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import type { RedisService } from '../redis/redis.service';

import { ContactFormService } from './contact-form.service';
import { EmailFinderService, fingerprint } from './email-finder.service';
import { findColumns, type SheetsService } from './sheets.service';

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

describe('contact form delivery lease', () => {
  it('requires a single transition from preparation before submitting', async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const service = new ContactFormService({
      sheetsPushLog: { updateMany },
    } as unknown as PrismaService);
    expect(await service.arm('id', 'lease')).toEqual({ armed: true });
    expect(await service.arm('id', 'lease')).toEqual({ armed: false });
    expect(updateMany.mock.calls[0]![0]).toMatchObject({
      where: { id: 'id', formLeaseToken: 'lease', emailStatus: 'FORM_PREPARING' },
      data: { emailStatus: 'FORM_SENDING' },
    });
  });

  it('does not accept SENT for an unarmed or cancelled form', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const service = new ContactFormService({
      sheetsPushLog: { updateMany },
    } as unknown as PrismaService);
    expect(await service.complete('id', 'lease', 'SENT')).toEqual({ saved: false });
    expect(updateMany.mock.calls[0]![0]).toMatchObject({
      where: { emailStatus: 'FORM_SENDING', formLeaseToken: 'lease' },
    });
  });
});
