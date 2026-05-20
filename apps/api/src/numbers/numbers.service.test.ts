import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { NumberType, UserRole, WhatsAppCompatibilityStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { inferAreaCode, inferNumberType, mapAvailableNumber } from './numbers.mapper';
import { NumbersService } from './numbers.service';

function buildService(overrides: { prisma?: any; twilio?: any; audit?: any } = {}) {
  const prisma = overrides.prisma ?? {
    phoneNumber: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    twilioAccount: { upsert: vi.fn() },
    numberSearch: { create: vi.fn() },
  };
  const twilio = overrides.twilio ?? {
    accountSid: 'AC123',
    webhookBaseUrl: 'https://example.com',
    defaultWebhookUrls: () => ({
      voiceUrl: 'https://example.com/webhooks/twilio/voice/inbound',
      voiceFallbackUrl: 'https://example.com/webhooks/twilio/voice/fallback',
      statusCallback: 'https://example.com/webhooks/twilio/voice/status',
      smsUrl: 'https://example.com/webhooks/twilio/messaging/inbound',
      smsFallbackUrl: 'https://example.com/webhooks/twilio/messaging/inbound',
    }),
    client: {} as any,
  };
  const audit = overrides.audit ?? { log: vi.fn().mockResolvedValue(undefined) };
  return new NumbersService(prisma, twilio, audit);
}

describe('NumbersService.findOwned', () => {
  it('throws NotFoundException when the number does not exist', async () => {
    const prisma = {
      phoneNumber: {
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
      },
    };
    const service = buildService({ prisma });
    await expect(
      service.getById({ userId: 'u1', role: UserRole.OWNER }, 'missing'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws ForbiddenException when a non-owner accesses someone else's number", async () => {
    const prisma = {
      phoneNumber: {
        findUnique: vi.fn().mockResolvedValue({ id: 'n1', userId: 'u2' }),
        update: vi.fn(),
      },
    };
    const service = buildService({ prisma });
    await expect(
      service.getById({ userId: 'u1', role: UserRole.OPERATOR }, 'n1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('NumbersService.purchase', () => {
  it('rejects when the number is already provisioned locally', async () => {
    const prisma = {
      phoneNumber: {
        findUnique: vi.fn().mockResolvedValue({ id: 'existing' }),
      },
    };
    const service = buildService({ prisma });
    await expect(
      service.purchase({ userId: 'u1', role: UserRole.OWNER }, { phoneNumber: '+14155552671' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('purchases via Twilio and stores webhooks + audit log', async () => {
    const created = {
      sid: 'PN1',
      accountSid: 'AC123',
      phoneNumber: '+14155552671',
      friendlyName: '+1 (415) 555-2671',
      isoCountry: 'US',
      capabilities: { voice: true, SMS: true, MMS: false },
    };
    const stored = {
      id: 'n1',
      userId: 'u1',
      twilioAccountSid: 'AC123',
      twilioIncomingPhoneNumberSid: 'PN1',
      phoneNumberE164: '+14155552671',
      friendlyName: 'My Number',
      country: 'US',
      region: null,
      locality: null,
      postalCode: null,
      areaCode: '415',
      numberType: NumberType.UNKNOWN,
      capabilitiesVoice: true,
      capabilitiesSms: true,
      capabilitiesMms: false,
      whatsappCompatibilityStatus: WhatsAppCompatibilityStatus.NOT_GUARANTEED,
      voiceWebhookUrl: 'https://example.com/webhooks/twilio/voice/inbound',
      smsWebhookUrl: 'https://example.com/webhooks/twilio/messaging/inbound',
      statusCallbackUrl: 'https://example.com/webhooks/twilio/voice/status',
      active: true,
      purchasedAt: new Date('2026-05-19T00:00:00Z'),
      updatedAt: new Date('2026-05-19T00:00:00Z'),
      releasedAt: null,
      tags: null,
    };
    const prisma = {
      phoneNumber: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(stored),
      },
      twilioAccount: { upsert: vi.fn().mockResolvedValue({}) },
    };
    const createTwilio = vi.fn().mockResolvedValue(created);
    const twilio = {
      accountSid: 'AC123',
      webhookBaseUrl: 'https://example.com',
      defaultWebhookUrls: () => ({
        voiceUrl: 'https://example.com/webhooks/twilio/voice/inbound',
        voiceFallbackUrl: 'https://example.com/webhooks/twilio/voice/fallback',
        statusCallback: 'https://example.com/webhooks/twilio/voice/status',
        smsUrl: 'https://example.com/webhooks/twilio/messaging/inbound',
        smsFallbackUrl: 'https://example.com/webhooks/twilio/messaging/inbound',
      }),
      client: { incomingPhoneNumbers: { create: createTwilio } } as any,
    };
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    const service = buildService({ prisma, twilio, audit });

    const result = await service.purchase(
      { userId: 'u1', role: UserRole.OWNER, ipAddress: '1.2.3.4', userAgent: 'jest' },
      { phoneNumber: '+14155552671', friendlyName: 'My Number' },
    );

    expect(result.phoneNumberE164).toBe('+14155552671');
    expect(createTwilio).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumber: '+14155552671',
        voiceUrl: 'https://example.com/webhooks/twilio/voice/inbound',
        smsUrl: 'https://example.com/webhooks/twilio/messaging/inbound',
        statusCallback: 'https://example.com/webhooks/twilio/voice/status',
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'number.purchased', entityId: 'n1' }),
    );
  });
});

describe('numbers.mapper', () => {
  it('infers area code from NANP numbers', () => {
    expect(inferAreaCode('+14155552671')).toBe('415');
    expect(inferAreaCode('+442071838750')).toBeNull();
  });

  it('maps search type strings to NumberType enum', () => {
    expect(inferNumberType('local')).toBe(NumberType.LOCAL);
    expect(inferNumberType('mobile')).toBe(NumberType.MOBILE);
    expect(inferNumberType('toll_free')).toBe(NumberType.TOLL_FREE);
    expect(inferNumberType(undefined)).toBe(NumberType.UNKNOWN);
  });

  it('normalizes Twilio capability shapes (SMS/MMS uppercase)', () => {
    const dto = mapAvailableNumber({
      phoneNumber: '+14155552671',
      isoCountry: 'US',
      capabilities: { voice: true, SMS: true, MMS: false },
      addressRequirements: 'none',
    });
    expect(dto.capabilities).toEqual({ voice: true, sms: true, mms: false });
    expect(dto.addressRequirements).toBe('none');
  });
});
