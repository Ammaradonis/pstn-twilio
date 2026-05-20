import { MessageDirection, MessageStatus, WebhookProvider } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { MessagingWebhookService } from './messaging.service';
import { mapTwilioStatusToEnum } from './status.mapper';

function buildService(overrides: { prisma?: any; realtime?: any } = {}) {
  const prisma = overrides.prisma ?? {
    webhookEvent: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    phoneNumber: { findUnique: vi.fn().mockResolvedValue(null) },
    smsMessage: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
    },
  };
  const realtime = overrides.realtime ?? {
    smsReceived: vi.fn(),
    smsStatusUpdated: vi.fn(),
  };
  return new MessagingWebhookService(prisma, realtime);
}

describe('MessagingWebhookService.handleInbound', () => {
  it('dedupes when an event with the same MessageSid was already processed', async () => {
    const prisma = {
      webhookEvent: {
        findUnique: vi.fn().mockResolvedValue({ id: 'w1' }),
        create: vi.fn(),
      },
      phoneNumber: { findUnique: vi.fn() },
      smsMessage: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    };
    const realtime = { smsReceived: vi.fn(), smsStatusUpdated: vi.fn() };
    const service = buildService({ prisma, realtime });

    const result = await service.handleInbound({
      MessageSid: 'SM1',
      From: '+15551111111',
      To: '+15552222222',
      Body: 'hi',
    });

    expect(result.deduped).toBe(true);
    expect(prisma.phoneNumber.findUnique).not.toHaveBeenCalled();
    expect(realtime.smsReceived).not.toHaveBeenCalled();
  });

  it('persists the inbound SMS, stores raw payload, and emits sms.received', async () => {
    const phoneNumber = { id: 'pn1', phoneNumberE164: '+15552222222' };
    const createdMessage = {
      id: 'm1',
      phoneNumberId: 'pn1',
      twilioMessageSid: 'SM1',
      direction: MessageDirection.INBOUND,
      fromE164: '+15551111111',
      toE164: '+15552222222',
      body: 'hi there',
      status: MessageStatus.RECEIVED,
      errorCode: null,
      errorMessage: null,
      numMedia: 0,
      media: null,
      createdAt: new Date('2026-05-19T00:00:00Z'),
      updatedAt: new Date('2026-05-19T00:00:00Z'),
    };
    const prisma = {
      webhookEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      phoneNumber: { findUnique: vi.fn().mockResolvedValue(phoneNumber) },
      smsMessage: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(createdMessage),
        update: vi.fn(),
      },
    };
    const realtime = { smsReceived: vi.fn(), smsStatusUpdated: vi.fn() };
    const service = buildService({ prisma, realtime });

    const result = await service.handleInbound({
      MessageSid: 'SM1',
      From: '+15551111111',
      To: '+15552222222',
      Body: 'hi there',
      NumMedia: '0',
    });

    expect(result.deduped).toBe(false);
    expect(prisma.webhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: WebhookProvider.TWILIO,
          eventType: 'messaging.inbound',
          twilioSid: 'SM1',
          signatureValid: true,
        }),
      }),
    );
    expect(prisma.smsMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          phoneNumberId: 'pn1',
          direction: MessageDirection.INBOUND,
          status: MessageStatus.RECEIVED,
        }),
      }),
    );
    expect(realtime.smsReceived).toHaveBeenCalledTimes(1);
    expect(realtime.smsReceived).toHaveBeenCalledWith(expect.objectContaining({ numberId: 'pn1' }));
  });

  it('skips persisting when the destination number is not provisioned', async () => {
    const prisma = {
      webhookEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      phoneNumber: { findUnique: vi.fn().mockResolvedValue(null) },
      smsMessage: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    };
    const realtime = { smsReceived: vi.fn(), smsStatusUpdated: vi.fn() };
    const service = buildService({ prisma, realtime });

    const result = await service.handleInbound({
      MessageSid: 'SM2',
      From: '+15551111111',
      To: '+15559999999',
      Body: 'orphan',
    });

    expect(result.deduped).toBe(false);
    expect(prisma.smsMessage.create).not.toHaveBeenCalled();
    expect(realtime.smsReceived).not.toHaveBeenCalled();
  });
});

describe('MessagingWebhookService.handleStatus', () => {
  it('updates the message status and emits sms.status.updated', async () => {
    const existing = {
      id: 'm1',
      phoneNumberId: 'pn1',
      twilioMessageSid: 'SM1',
      errorCode: null,
      errorMessage: null,
      status: MessageStatus.SENT,
    };
    const updated = {
      ...existing,
      direction: MessageDirection.OUTBOUND,
      fromE164: '+15552222222',
      toE164: '+15551111111',
      body: 'reply',
      status: MessageStatus.DELIVERED,
      numMedia: 0,
      media: null,
      createdAt: new Date('2026-05-19T00:00:00Z'),
      updatedAt: new Date('2026-05-19T00:00:01Z'),
    };
    const prisma = {
      webhookEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      phoneNumber: { findUnique: vi.fn() },
      smsMessage: {
        findUnique: vi.fn().mockResolvedValue(existing),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue(updated),
      },
    };
    const realtime = { smsReceived: vi.fn(), smsStatusUpdated: vi.fn() };
    const service = buildService({ prisma, realtime });

    await service.handleStatus({
      MessageSid: 'SM1',
      MessageStatus: 'delivered',
    });

    expect(prisma.smsMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { twilioMessageSid: 'SM1' },
        data: expect.objectContaining({ status: MessageStatus.DELIVERED }),
      }),
    );
    expect(realtime.smsStatusUpdated).toHaveBeenCalledTimes(1);
  });
});

describe('status.mapper', () => {
  it('maps Twilio status strings to our enum', () => {
    expect(mapTwilioStatusToEnum('received')).toBe(MessageStatus.RECEIVED);
    expect(mapTwilioStatusToEnum('queued')).toBe(MessageStatus.QUEUED);
    expect(mapTwilioStatusToEnum('accepted')).toBe(MessageStatus.QUEUED);
    expect(mapTwilioStatusToEnum('sent')).toBe(MessageStatus.SENT);
    expect(mapTwilioStatusToEnum('delivered')).toBe(MessageStatus.DELIVERED);
    expect(mapTwilioStatusToEnum('undelivered')).toBe(MessageStatus.UNDELIVERED);
    expect(mapTwilioStatusToEnum('failed')).toBe(MessageStatus.FAILED);
    expect(mapTwilioStatusToEnum('canceled')).toBe(MessageStatus.FAILED);
    expect(mapTwilioStatusToEnum('unknown-status')).toBe(MessageStatus.QUEUED);
  });
});
