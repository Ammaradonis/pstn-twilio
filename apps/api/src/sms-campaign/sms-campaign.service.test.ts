import { BadRequestException } from '@nestjs/common';
import { MessageStatus, Prisma } from '@prisma/client';
import { DEFAULT_SMS_CAMPAIGN_BODY } from '@pstn-twilio/shared';
import { describe, expect, it, vi } from 'vitest';

import { SmsCampaignService, inSendingHours, localHour } from './sms-campaign.service';

// 10:00 in Chicago (CST, UTC-6).
const NOW = new Date('2026-11-18T16:00:00Z');
const FROM = {
  id: 'pn-877',
  phoneNumberE164: '+18776524532',
  active: true,
  capabilitiesSms: true,
};
const LEAD = {
  pushLogId: 'push-1',
  toE164: '+15125550101',
  schoolName: 'Seeds 13 Jiu-Jitsu Academy - Abilene, TX',
  timeZone: 'America/Chicago',
  callEndedAt: new Date('2026-11-18T14:00:00Z'),
};
const CAMPAIGN = {
  userId: 'u1',
  enabled: true,
  body: DEFAULT_SMS_CAMPAIGN_BODY,
  dailyCap: 100,
  startedAt: new Date('2026-11-18T09:00:00Z'),
  lastSendAt: null as Date | null,
  lastError: null as string | null,
};

function twilioError(code: number | undefined, message: string) {
  return Object.assign(new Error(message), code === undefined ? {} : { code });
}

function build(
  opts: {
    campaign?: Partial<typeof CAMPAIGN> | null;
    leads?: (typeof LEAD)[];
    sentLast24h?: number;
    claim?: number;
    send?: Error;
    duplicate?: boolean;
    from?: Partial<typeof FROM> | null;
    results?: Array<{ errorCode: string | null }>;
  } = {},
) {
  const campaign = opts.campaign === null ? null : { ...CAMPAIGN, ...opts.campaign };
  const create = vi.fn(() =>
    opts.send ? Promise.reject(opts.send) : Promise.resolve({ sid: 'SM123' }),
  );
  const prisma = {
    smsCampaign: {
      findUnique: vi.fn().mockResolvedValue(campaign),
      findMany: vi.fn().mockResolvedValue(campaign ? [campaign] : []),
      updateMany: vi.fn().mockResolvedValue({ count: opts.claim ?? 1 }),
      update: vi.fn().mockResolvedValue({}),
      upsert: vi.fn().mockResolvedValue({}),
    },
    smsCampaignSend: {
      create: vi.fn(() =>
        opts.duplicate
          ? Promise.reject(
              new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
                code: 'P2002',
                clientVersion: 'test',
              }),
            )
          : Promise.resolve({ id: 'send-1' }),
      ),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      count: vi.fn().mockResolvedValue(opts.sentLast24h ?? 0),
      groupBy: vi.fn().mockResolvedValue([]),
      findMany: vi.fn().mockResolvedValue([]),
    },
    smsMessage: {
      create: vi.fn().mockResolvedValue({ id: 'msg-1' }),
      findUnique: vi.fn().mockResolvedValue({ id: 'msg-1', status: MessageStatus.QUEUED }),
      update: vi.fn().mockImplementation(({ data }) =>
        Promise.resolve({
          id: 'msg-1',
          phoneNumberId: FROM.id,
          twilioMessageSid: data.twilioMessageSid,
          direction: 'OUTBOUND',
          fromE164: FROM.phoneNumberE164,
          toE164: LEAD.toE164,
          body: 'x',
          numMedia: 0,
          media: null,
          status: data.status ?? MessageStatus.QUEUED,
          errorCode: null,
          errorMessage: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ),
      delete: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue(opts.results ?? []),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    phoneNumber: {
      findUnique: vi.fn().mockResolvedValue(opts.from === null ? null : { ...FROM, ...opts.from }),
    },
    $queryRaw: vi.fn().mockResolvedValue(opts.leads ?? [LEAD]),
  };
  const twilio = {
    accountSid: 'AC1',
    messagingStatusCallbackUrl: 'https://api.example.test/webhooks/twilio/messaging/status',
    client: { api: { v2010: { accounts: () => ({ messages: { create } }) } } },
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const realtime = { smsSent: vi.fn() };
  const service = new SmsCampaignService(
    prisma as never,
    twilio as never,
    audit as never,
    realtime as never,
  );
  return { service, prisma, create, audit, realtime };
}

describe('SmsCampaignService.sweep', () => {
  it('texts the newest lead from the toll-free line, with the school name tidied', async () => {
    const { service, prisma, create, realtime } = build();

    await service.sweep(NOW);

    expect(create).toHaveBeenCalledTimes(1);
    const args = (create.mock.calls[0] as unknown as [Record<string, string>])[0];
    expect(args.from).toBe('+18776524532');
    expect(args.to).toBe(LEAD.toE164);
    expect(args.body.startsWith('Hey Seeds 13 Jiu-Jitsu Academy, Ammar here.')).toBe(true);
    expect(args.body).toContain('https://www.loom.com/share/a3614b444000454daebb01634bc47711');
    expect(args.body).toContain('(667) 220-6726');
    expect(args.statusCallback).toBe(
      'https://api.example.test/webhooks/twilio/messaging/status?messageId=msg-1',
    );
    expect(prisma.smsCampaignSend.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'u1', toE164: LEAD.toE164, status: 'SENDING' }),
    });
    expect(prisma.smsCampaignSend.update).toHaveBeenCalledWith({
      where: { id: 'send-1' },
      data: { status: 'SENT', smsMessageId: 'msg-1' },
    });
    expect(prisma.smsMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ phoneNumberId: 'pn-877', direction: 'OUTBOUND' }),
    });
    expect(realtime.smsSent).toHaveBeenCalledWith(expect.objectContaining({ numberId: 'pn-877' }));
  });

  it('claims the send slot so only one machine texts per gap', async () => {
    const { service, prisma } = build();
    await service.sweep(NOW);
    expect(prisma.smsCampaign.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 'u1',
        enabled: true,
        OR: [{ lastSendAt: null }, { lastSendAt: { lte: new Date(NOW.getTime() - 5 * 60_000) } }],
      },
      data: { lastSendAt: NOW },
    });
  });

  it('sends nothing when another machine took the slot', async () => {
    const { service, create } = build({ claim: 0 });
    await service.sweep(NOW);
    expect(create).not.toHaveBeenCalled();
  });

  it('waits five minutes between texts', async () => {
    const { service, create } = build({
      campaign: { lastSendAt: new Date(NOW.getTime() - 4 * 60_000) },
    });
    await service.sweep(NOW);
    expect(create).not.toHaveBeenCalled();
  });

  it('stops at the daily cap', async () => {
    const { service, prisma, create } = build({ sentLast24h: 100 });
    await service.sweep(NOW);
    expect(create).not.toHaveBeenCalled();
    expect(prisma.smsCampaignSend.count).toHaveBeenCalledWith({
      where: {
        userId: 'u1',
        status: { in: ['SENT', 'SENDING'] },
        createdAt: { gte: new Date(NOW.getTime() - 24 * 60 * 60_000) },
      },
    });
  });

  it('only texts between 9am and 8pm in the lead’s time zone', async () => {
    // 07:00 in Chicago.
    const early = new Date('2026-11-18T13:00:00Z');
    const { service, create } = build();
    await service.sweep(early);
    expect(create).not.toHaveBeenCalled();
  });

  it('skips a lead whose evening is over for one that is in hours', async () => {
    const tokyo = { ...LEAD, toE164: '+15125550199', timeZone: 'Asia/Tokyo' }; // 01:00 there
    const { service, create } = build({ leads: [tokyo, LEAD] });
    await service.sweep(NOW);
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0] as unknown as [{ to: string }])[0].to).toBe(LEAD.toE164);
  });

  it('never texts a number twice, even when two sends race', async () => {
    const { service, create } = build({ duplicate: true });
    await service.sweep(NOW);
    expect(create).not.toHaveBeenCalled();
  });

  it('marks numbers that texted STOP as opted out', async () => {
    const { service, prisma } = build({
      send: twilioError(21610, 'Attempt to send to unsubscribed recipient'),
    });
    await service.sweep(NOW);
    expect(prisma.smsCampaignSend.update).toHaveBeenCalledWith({
      where: { id: 'send-1' },
      data: { status: 'OPTED_OUT', error: 'Attempt to send to unsubscribed recipient' },
    });
    expect(prisma.smsMessage.delete).toHaveBeenCalledWith({ where: { id: 'msg-1' } });
  });

  it('gives up on a number Twilio says cannot get texts', async () => {
    const { service, prisma } = build({ send: twilioError(21614, 'Not a valid mobile number') });
    await service.sweep(NOW);
    expect(prisma.smsCampaignSend.update).toHaveBeenCalledWith({
      where: { id: 'send-1' },
      data: { status: 'FAILED', error: 'Not a valid mobile number' },
    });
    expect(prisma.smsCampaignSend.delete).not.toHaveBeenCalled();
  });

  it('does not retry when it cannot tell whether the text went out', async () => {
    const { service, prisma } = build({ send: twilioError(undefined, 'socket hang up') });
    await service.sweep(NOW);
    expect(prisma.smsCampaignSend.update).toHaveBeenCalledWith({
      where: { id: 'send-1' },
      data: { status: 'FAILED', error: 'socket hang up' },
    });
  });

  it('keeps the lead in line and shows the error when the line itself is refused', async () => {
    const { service, prisma } = build({ send: twilioError(20003, 'Authenticate') });
    await service.sweep(NOW);
    expect(prisma.smsCampaignSend.delete).toHaveBeenCalledWith({ where: { id: 'send-1' } });
    expect(prisma.smsCampaign.update).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      data: { lastError: 'Twilio error 20003: Authenticate' },
    });
  });

  it('pauses itself when carriers start blocking the texts', async () => {
    const results = [
      ...Array.from({ length: 5 }, () => ({ errorCode: '30007' })),
      ...Array.from({ length: 10 }, () => ({ errorCode: null })),
    ];
    const { service, prisma, create } = build({ results });
    await service.sweep(NOW);
    expect(create).not.toHaveBeenCalled();
    expect(prisma.smsCampaign.update).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      data: expect.objectContaining({ enabled: false }),
    });
    const data = prisma.smsCampaign.update.mock.calls[0]![0].data;
    expect(data.lastError).toContain('carriers blocked 5 of the last 15 texts (error 30007)');
  });

  it('keeps going when only a few texts were blocked', async () => {
    const results = [{ errorCode: '30007' }, { errorCode: '30006' }, { errorCode: null }];
    const { service, create } = build({ results });
    await service.sweep(NOW);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('notes the problem when the toll-free line is missing', async () => {
    const { service, prisma, create } = build({ from: null });
    await service.sweep(NOW);
    expect(create).not.toHaveBeenCalled();
    expect(prisma.smsCampaign.update).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      data: { lastError: expect.stringContaining('+18776524532') },
    });
  });

  it('does nothing while paused', async () => {
    const { service, prisma, create } = build({ campaign: null });
    await service.sweep(NOW);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('SmsCampaignService.update', () => {
  const actor = { userId: 'u1' };

  it('starts with the default text and records when it started', async () => {
    const { service, prisma, audit } = build({ campaign: null });
    await service.update(actor, { enabled: true });
    const args = prisma.smsCampaign.upsert.mock.calls[0]![0];
    expect(args.create).toEqual(
      expect.objectContaining({ enabled: true, body: DEFAULT_SMS_CAMPAIGN_BODY }),
    );
    expect(args.create.startedAt).toBeInstanceOf(Date);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sms_campaign.updated', metadata: { enabled: true } }),
    );
  });

  it('clears the old error when started again', async () => {
    const { service, prisma } = build({ campaign: { enabled: false, lastError: 'Paused itself' } });
    await service.update(actor, { enabled: true });
    const args = prisma.smsCampaign.upsert.mock.calls[0]![0];
    expect(args.update).toEqual(
      expect.objectContaining({ enabled: true, lastError: null, startedAt: expect.any(Date) }),
    );
  });

  it('changes the text without touching the switch', async () => {
    const { service, prisma } = build();
    await service.update(actor, { body: 'Hi {{school_name}}. Reply STOP to opt out' });
    expect(prisma.smsCampaign.upsert.mock.calls[0]![0].update).toEqual({
      body: 'Hi {{school_name}}. Reply STOP to opt out',
    });
  });

  it('refuses to start without the toll-free line', async () => {
    const { service, prisma } = build({ from: { capabilitiesSms: false } });
    await expect(service.update(actor, { enabled: true })).rejects.toThrow(BadRequestException);
    expect(prisma.smsCampaign.upsert).not.toHaveBeenCalled();
  });
});

describe('SmsCampaignService.sendTest', () => {
  it('texts the rendered message without touching the campaign', async () => {
    const { service, prisma, create } = build();
    const result = await service.sendTest({ userId: 'u1' }, '+15125550123');
    expect(result.body.startsWith('Hey Lone Star Karate, Ammar here.')).toBe(true);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ to: '+15125550123' }));
    expect(prisma.smsCampaignSend.create).not.toHaveBeenCalled();
  });

  it('reports a refused test text', async () => {
    const { service } = build({ send: twilioError(21608, 'Unverified number') });
    await expect(service.sendTest({ userId: 'u1' }, '+15125550123')).rejects.toThrow(
      /Unverified number/,
    );
  });
});

describe('SmsCampaignService.get', () => {
  it('adds up the results', async () => {
    const { service, prisma } = build({ sentLast24h: 12 });
    prisma.smsCampaignSend.groupBy.mockResolvedValue([
      { status: 'SENT', _count: { _all: 40 } },
      { status: 'FAILED', _count: { _all: 2 } },
      { status: 'OPTED_OUT', _count: { _all: 1 } },
    ]);
    prisma.smsMessage.groupBy.mockResolvedValue([
      { status: MessageStatus.DELIVERED, _count: { _all: 30 } },
      { status: MessageStatus.UNDELIVERED, _count: { _all: 6 } },
      { status: MessageStatus.FAILED, _count: { _all: 1 } },
      { status: MessageStatus.SENT, _count: { _all: 3 } },
    ]);
    prisma.smsCampaignSend.findMany.mockResolvedValue([
      {
        id: 's1',
        toE164: LEAD.toE164,
        schoolName: 'Kicks',
        status: 'SENT',
        error: null,
        createdAt: NOW,
        smsMessage: {
          status: MessageStatus.UNDELIVERED,
          errorCode: '30006',
          errorMessage: 'Landline',
        },
      },
    ]);

    const dto = await service.get('u1', NOW);

    expect(dto).toEqual(
      expect.objectContaining({
        enabled: true,
        dailyCap: 100,
        from: '+18776524532',
        sentLast24h: 12,
        waiting: 1,
        totals: { sent: 40, delivered: 30, undelivered: 7, failed: 2, optedOut: 1 },
      }),
    );
    expect(dto.recent[0]).toEqual(
      expect.objectContaining({ delivery: 'UNDELIVERED', error: '30006: Landline' }),
    );
  });

  it('shows the default text before the campaign is saved', async () => {
    const { service } = build({ campaign: null });
    const dto = await service.get('u1', NOW);
    expect(dto.enabled).toBe(false);
    expect(dto.body).toBe(DEFAULT_SMS_CAMPAIGN_BODY);
  });
});

describe('sending hours', () => {
  it('reads the hour in the lead’s zone', () => {
    expect(localHour(NOW, 'America/Chicago')).toBe(10);
    expect(localHour(NOW, 'Not/AZone')).toBeNull();
  });

  it('runs from 9am up to 8pm, weekends included', () => {
    const saturday = (iso: string) => new Date(iso);
    expect(inSendingHours(saturday('2026-11-21T15:00:00Z'), 'America/Chicago')).toBe(true); // 09:00
    expect(inSendingHours(saturday('2026-11-21T14:59:00Z'), 'America/Chicago')).toBe(false); // 08:59
    expect(inSendingHours(saturday('2026-11-22T01:59:00Z'), 'America/Chicago')).toBe(true); // 19:59
    expect(inSendingHours(saturday('2026-11-22T02:00:00Z'), 'America/Chicago')).toBe(false); // 20:00
  });
});
