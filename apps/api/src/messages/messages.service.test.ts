import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { MessageDirection, MessageStatus, UserRole } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { decodeCursor, encodeCursor } from './messages.mapper';
import { MessagesService } from './messages.service';

function buildService(overrides: { prisma?: any; twilio?: any; audit?: any; realtime?: any } = {}) {
  const prisma = overrides.prisma ?? {
    phoneNumber: { findUnique: vi.fn(), findMany: vi.fn() },
    smsMessage: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  };
  const twilio = overrides.twilio ?? {
    webhookBaseUrl: 'https://example.com',
    client: { messages: { create: vi.fn() } },
  };
  const audit = overrides.audit ?? { log: vi.fn() };
  const realtime = overrides.realtime ?? {
    smsSent: vi.fn(),
    smsStatusUpdated: vi.fn(),
  };
  return new MessagesService(prisma, twilio, audit, realtime);
}

describe('MessagesService.send', () => {
  const phoneNumber = {
    id: 'pn1',
    userId: 'u1',
    phoneNumberE164: '+15552222222',
    capabilitiesSms: true,
    active: true,
  };

  it('rejects when the user does not own the number', async () => {
    const prisma = {
      phoneNumber: {
        findUnique: vi.fn().mockResolvedValue({ ...phoneNumber, userId: 'someone-else' }),
      },
      smsMessage: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    };
    const service = buildService({ prisma });
    await expect(
      service.send({ userId: 'u1', role: UserRole.OPERATOR }, 'pn1', {
        to: '+15551111111',
        body: 'hi',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects when the number lacks SMS capability', async () => {
    const prisma = {
      phoneNumber: {
        findUnique: vi.fn().mockResolvedValue({ ...phoneNumber, capabilitiesSms: false }),
      },
      smsMessage: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    };
    const service = buildService({ prisma });
    await expect(
      service.send({ userId: 'u1', role: UserRole.OWNER }, 'pn1', {
        to: '+15551111111',
        body: 'hi',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates pending row, calls Twilio, stores sid, emits sms.sent, writes audit log', async () => {
    const pending = {
      id: 'm1',
      phoneNumberId: 'pn1',
      twilioMessageSid: null,
      direction: MessageDirection.OUTBOUND,
      fromE164: '+15552222222',
      toE164: '+15551111111',
      body: 'hello',
      status: MessageStatus.QUEUED,
      errorCode: null,
      errorMessage: null,
      numMedia: 0,
      media: null,
      createdAt: new Date('2026-05-19T00:00:00Z'),
      updatedAt: new Date('2026-05-19T00:00:00Z'),
    };
    const sent = { ...pending, twilioMessageSid: 'SM999', status: MessageStatus.SENT };

    const prisma = {
      phoneNumber: { findUnique: vi.fn().mockResolvedValue(phoneNumber) },
      smsMessage: {
        create: vi.fn().mockResolvedValue(pending),
        update: vi.fn().mockResolvedValue(sent),
        findUnique: vi.fn(),
      },
    };
    const createTwilio = vi.fn().mockResolvedValue({ sid: 'SM999' });
    const twilio = {
      webhookBaseUrl: 'https://example.com',
      client: { messages: { create: createTwilio } },
    };
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    const realtime = { smsSent: vi.fn(), smsStatusUpdated: vi.fn() };
    const service = buildService({ prisma, twilio, audit, realtime });

    const result = await service.send(
      { userId: 'u1', role: UserRole.OWNER, ipAddress: '1.2.3.4' },
      'pn1',
      { to: '+15551111111', body: 'hello' },
    );

    expect(createTwilio).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '+15552222222',
        to: '+15551111111',
        body: 'hello',
        statusCallback: 'https://example.com/webhooks/twilio/messaging/status',
      }),
    );
    expect(prisma.smsMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'm1' },
        data: expect.objectContaining({ twilioMessageSid: 'SM999', status: MessageStatus.SENT }),
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'message.sent', entityId: 'm1' }),
    );
    expect(realtime.smsSent).toHaveBeenCalledTimes(1);
    expect(result.twilioMessageSid).toBe('SM999');
  });

  it('marks message FAILED and surfaces a 400 when Twilio rejects the send', async () => {
    const pending = {
      id: 'm1',
      phoneNumberId: 'pn1',
      twilioMessageSid: null,
      direction: MessageDirection.OUTBOUND,
      fromE164: '+15552222222',
      toE164: '+15551111111',
      body: 'hello',
      status: MessageStatus.QUEUED,
      errorCode: null,
      errorMessage: null,
      numMedia: 0,
      media: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const failed = { ...pending, status: MessageStatus.FAILED, errorMessage: 'bad number' };
    const prisma = {
      phoneNumber: { findUnique: vi.fn().mockResolvedValue(phoneNumber) },
      smsMessage: {
        create: vi.fn().mockResolvedValue(pending),
        update: vi.fn().mockResolvedValue(failed),
        findUnique: vi.fn(),
      },
    };
    const twilio = {
      webhookBaseUrl: 'https://example.com',
      client: { messages: { create: vi.fn().mockRejectedValue(new Error('bad number')) } },
    };
    const audit = { log: vi.fn() };
    const realtime = { smsSent: vi.fn(), smsStatusUpdated: vi.fn() };
    const service = buildService({ prisma, twilio, audit, realtime });

    await expect(
      service.send({ userId: 'u1', role: UserRole.OWNER }, 'pn1', {
        to: '+15551111111',
        body: 'hello',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.smsMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: MessageStatus.FAILED }),
      }),
    );
    expect(realtime.smsStatusUpdated).toHaveBeenCalledTimes(1);
  });
});

describe('MessagesService.retry', () => {
  it('refuses to retry a message that is not FAILED/UNDELIVERED', async () => {
    const prisma = {
      phoneNumber: { findUnique: vi.fn().mockResolvedValue({ id: 'pn1', userId: 'u1' }) },
      smsMessage: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'm1',
          phoneNumberId: 'pn1',
          direction: MessageDirection.OUTBOUND,
          status: MessageStatus.SENT,
        }),
        create: vi.fn(),
        update: vi.fn(),
      },
    };
    const service = buildService({ prisma });
    await expect(
      service.retry({ userId: 'u1', role: UserRole.OWNER }, 'pn1', 'm1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('messages.mapper cursor codec', () => {
  it('encodes and decodes round-trip', () => {
    const ts = new Date('2026-05-19T12:34:56.789Z');
    const cursor = encodeCursor(ts, 'abc-id');
    expect(decodeCursor(cursor)).toEqual({ t: ts.toISOString(), id: 'abc-id' });
  });

  it('returns null for malformed cursors', () => {
    expect(decodeCursor('!!!not-base64!!!')).toBeNull();
  });
});
