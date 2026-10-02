import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
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
