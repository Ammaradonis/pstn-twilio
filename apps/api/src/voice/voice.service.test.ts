import { createHmac } from 'node:crypto';

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { VoiceService } from './voice.service';

function buildService(overrides: { prisma?: any; twilio?: any; audit?: any } = {}) {
  const incomingNumberFetch = vi.fn().mockResolvedValue({
    phoneNumber: '+15552222222',
    capabilities: { voice: true },
  });
  const prisma = overrides.prisma ?? {
    phoneNumber: { findUnique: vi.fn(), update: vi.fn() },
    voiceIdentity: { upsert: vi.fn().mockResolvedValue({}) },
    outboundCallIntent: {
      create: vi.fn().mockResolvedValue({
        id: 'intent1',
        expiresAt: new Date(Date.now() + 120_000),
      }),
    },
  };
  const twilio = overrides.twilio ?? {
    accountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    apiKeySid: 'SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    apiKeySecret: 'a-very-long-secret-value-for-test-only',
    twimlAppSid: 'APxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    voiceIdentity: (userId: string, numberId?: string | null) =>
      numberId ? `user_${userId}_number_${numberId}` : `user_${userId}`,
    client: {
      api: {
        v2010: {
          accounts: vi.fn(() => ({
            incomingPhoneNumbers: vi.fn(() => ({
              fetch: incomingNumberFetch,
            })),
          })),
        },
      },
    },
  };
  const audit = overrides.audit ?? { log: vi.fn().mockResolvedValue(undefined) };
  return { service: new VoiceService(prisma, twilio, audit), prisma, twilio, audit };
}

function decodeJwtPart<T>(token: string, index: number): T {
  const part = token.split('.')[index];
  if (!part) throw new Error(`Missing JWT part ${index}`);
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
}

describe('VoiceService.issueToken', () => {
  it('issues a JWT with VoiceGrant for a user without a numberId', async () => {
    const { service, prisma, audit } = buildService();
    const result = await service.issueToken({ userId: 'u1', role: UserRole.OWNER });

    expect(result.identity).toBe('user_u1');
    expect(result.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(prisma.voiceIdentity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { identity: 'user_u1' } }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'voice.token_issued', entityId: 'user_u1' }),
    );
  });

  it('uses Twilio AccessToken with VoiceGrant and backdated nbf for clock skew', async () => {
    const now = new Date('2026-06-06T21:05:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const { service, twilio } = buildService();
      const result = await service.issueToken({ userId: 'u1', role: UserRole.OWNER });
      const header = decodeJwtPart<{
        alg: string;
        typ: string;
        cty: string;
      }>(result.token, 0);
      const payload = decodeJwtPart<{
        jti: string;
        iss: string;
        sub: string;
        nbf: number;
        iat: number;
        exp: number;
        grants: {
          identity: string;
          voice: {
            incoming: { allow: boolean };
            outgoing: { application_sid: string };
          };
        };
      }>(result.token, 1);
      const [encodedHeader, encodedPayload, signature] = result.token.split('.');

      expect(header).toEqual({
        alg: 'HS256',
        typ: 'JWT',
        cty: 'twilio-fpa;v=1',
      });
      expect(payload.iss).toBe(twilio.apiKeySid);
      expect(payload.sub).toBe(twilio.accountSid);
      expect(payload.jti).toBe(`${twilio.apiKeySid}-${Math.floor(now.getTime() / 1000)}`);
      expect(payload.nbf).toBe(Math.floor(now.getTime() / 1000) - 300);
      expect(payload.iat).toBe(Math.floor(now.getTime() / 1000));
      expect(payload.exp).toBe(payload.iat + 3600);
      expect(result.expiresAt).toBe(new Date(payload.exp * 1000).toISOString());
      expect(payload.grants).toEqual({
        identity: 'user_u1',
        voice: {
          incoming: { allow: true },
          outgoing: { application_sid: twilio.twimlAppSid },
        },
      });
      expect(signature).toBe(
        createHmac('sha256', twilio.apiKeySecret)
          .update(`${encodedHeader}.${encodedPayload}`)
          .digest('base64url'),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('asserts ownership when a numberId is supplied', async () => {
    const prisma = {
      phoneNumber: {
        findUnique: vi.fn().mockResolvedValue({ id: 'pn1', userId: 'someone-else' }),
      },
      voiceIdentity: { upsert: vi.fn() },
    };
    const { service } = buildService({ prisma });
    await expect(
      service.issueToken({ userId: 'u1', role: UserRole.OPERATOR }, 'pn1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws NotFound for missing numbers', async () => {
    const prisma = {
      phoneNumber: { findUnique: vi.fn().mockResolvedValue(null) },
      voiceIdentity: { upsert: vi.fn() },
    };
    const { service } = buildService({ prisma });
    await expect(
      service.issueToken({ userId: 'u1', role: UserRole.OWNER }, 'pn-missing'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('VoiceService.prepareOutbound', () => {
  const phoneNumber = {
    id: 'pn1',
    userId: 'u1',
    twilioIncomingPhoneNumberSid: 'PNxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    phoneNumberE164: '+15552222222',
    capabilitiesVoice: true,
    active: true,
  };

  it('rejects numbers without voice capability', async () => {
    const prisma = {
      phoneNumber: {
        findUnique: vi.fn().mockResolvedValue({ ...phoneNumber, capabilitiesVoice: false }),
      },
      voiceIdentity: { upsert: vi.fn() },
    };
    const { service } = buildService({ prisma });
    await expect(
      service.prepareOutbound(
        { userId: 'u1', role: UserRole.OWNER },
        { selectedNumberId: 'pn1', destinationNumber: '+15551111111' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects inactive numbers', async () => {
    const prisma = {
      phoneNumber: { findUnique: vi.fn().mockResolvedValue({ ...phoneNumber, active: false }) },
      voiceIdentity: { upsert: vi.fn() },
    };
    const { service } = buildService({ prisma });
    await expect(
      service.prepareOutbound(
        { userId: 'u1', role: UserRole.OWNER },
        { selectedNumberId: 'pn1', destinationNumber: '+15551111111' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects non-E.164 destinations', async () => {
    const prisma = {
      phoneNumber: { findUnique: vi.fn().mockResolvedValue(phoneNumber) },
      voiceIdentity: { upsert: vi.fn() },
    };
    const { service } = buildService({ prisma });
    await expect(
      service.prepareOutbound(
        { userId: 'u1', role: UserRole.OWNER },
        { selectedNumberId: 'pn1', destinationNumber: '5551111111' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('deactivates and rejects a selected caller ID no longer present in Twilio', async () => {
    const prisma = {
      phoneNumber: {
        findUnique: vi.fn().mockResolvedValue(phoneNumber),
        update: vi.fn().mockResolvedValue({ ...phoneNumber, active: false }),
      },
      voiceIdentity: { upsert: vi.fn() },
      outboundCallIntent: { create: vi.fn() },
    };
    const twilio = {
      accountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      apiKeySid: 'SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      apiKeySecret: 'a-very-long-secret-value-for-test-only',
      twimlAppSid: 'APxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      voiceIdentity: (userId: string, numberId?: string | null) =>
        numberId ? `user_${userId}_number_${numberId}` : `user_${userId}`,
      client: {
        api: {
          v2010: {
            accounts: vi.fn(() => ({
              incomingPhoneNumbers: vi.fn(() => ({
                fetch: vi.fn().mockRejectedValue({ status: 404, code: 20404 }),
              })),
            })),
          },
        },
      },
    };
    const { service, audit } = buildService({ prisma, twilio });

    await expect(
      service.prepareOutbound(
        { userId: 'u1', role: UserRole.OWNER },
        { selectedNumberId: 'pn1', destinationNumber: '+15551111111' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.phoneNumber.update).toHaveBeenCalledWith({
      where: { id: 'pn1' },
      data: { active: false },
    });
    expect(prisma.outboundCallIntent.create).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'number.twilio_missing',
        entityId: 'pn1',
      }),
    );
  });

  it('returns selected caller ID + identity for an authorized E.164 destination', async () => {
    const prisma = {
      phoneNumber: { findUnique: vi.fn().mockResolvedValue(phoneNumber) },
      voiceIdentity: { upsert: vi.fn() },
      outboundCallIntent: {
        create: vi.fn().mockResolvedValue({
          id: 'intent1',
          expiresAt: new Date(Date.now() + 120_000),
        }),
      },
    };
    const { service, audit } = buildService({ prisma });
    const result = await service.prepareOutbound(
      { userId: 'u1', role: UserRole.OWNER },
      { selectedNumberId: 'pn1', destinationNumber: '+15551111111' },
    );
    expect(result).toEqual({
      outboundIntentId: 'intent1',
      selectedNumberId: 'pn1',
      selectedCallerId: '+15552222222',
      destinationNumber: '+15551111111',
      identity: 'user_u1_number_pn1',
      expiresAt: expect.any(String),
    });
    expect(prisma.outboundCallIntent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'u1',
          phoneNumberId: 'pn1',
          identity: 'user_u1_number_pn1',
          destinationE164: '+15551111111',
          selectedCallerId: '+15552222222',
          expiresAt: expect.any(Date),
        }),
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'voice.outbound_prepared',
        entityType: 'OutboundCallIntent',
        entityId: 'intent1',
      }),
    );
  });

  it('normalizes formatted U.S. destinations before returning call params', async () => {
    const prisma = {
      phoneNumber: { findUnique: vi.fn().mockResolvedValue(phoneNumber) },
      voiceIdentity: { upsert: vi.fn() },
      outboundCallIntent: {
        create: vi.fn().mockResolvedValue({
          id: 'intent1',
          expiresAt: new Date(Date.now() + 120_000),
        }),
      },
    };
    const { service } = buildService({ prisma });
    const result = await service.prepareOutbound(
      { userId: 'u1', role: UserRole.OWNER },
      { selectedNumberId: 'pn1', destinationNumber: '+1 530-441-9961' },
    );

    expect(result.destinationNumber).toBe('+15304419961');
    expect(prisma.outboundCallIntent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          destinationE164: '+15304419961',
        }),
      }),
    );
  });

  it('forbids non-OWNER actor that does not own the number', async () => {
    const prisma = {
      phoneNumber: {
        findUnique: vi.fn().mockResolvedValue({ ...phoneNumber, userId: 'another' }),
      },
      voiceIdentity: { upsert: vi.fn() },
    };
    const { service } = buildService({ prisma });
    await expect(
      service.prepareOutbound(
        { userId: 'u1', role: UserRole.OPERATOR },
        { selectedNumberId: 'pn1', destinationNumber: '+15551111111' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('VoiceService.getDeviceConfig', () => {
  it('returns codec preferences and protective defaults', () => {
    const { service } = buildService();
    const config = service.getDeviceConfig();
    expect(config.codecPreferences).toContain('opus');
    expect(config.edge[0]).toBe('frankfurt');
    expect(config.edge).toContain('dublin');
    expect(config.closeProtection).toBe(true);
    expect(config.enableImprovedSignalingErrorPrecision).toBe(true);
    expect(config.tokenRefreshMs).toBe(60_000);
  });
});
