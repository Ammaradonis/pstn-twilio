import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { VoiceService } from './voice.service';

function buildService(overrides: { prisma?: any; twilio?: any; audit?: any } = {}) {
  const prisma = overrides.prisma ?? {
    phoneNumber: { findUnique: vi.fn() },
    voiceIdentity: { upsert: vi.fn().mockResolvedValue({}) },
  };
  const twilio = overrides.twilio ?? {
    accountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    apiKeySid: 'SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    apiKeySecret: 'a-very-long-secret-value-for-test-only',
    twimlAppSid: 'APxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    voiceIdentity: (userId: string, numberId?: string | null) =>
      numberId ? `user_${userId}_number_${numberId}` : `user_${userId}`,
  };
  const audit = overrides.audit ?? { log: vi.fn().mockResolvedValue(undefined) };
  return { service: new VoiceService(prisma, twilio, audit), prisma, twilio, audit };
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

  it('returns selected caller ID + identity for an authorized E.164 destination', async () => {
    const prisma = {
      phoneNumber: { findUnique: vi.fn().mockResolvedValue(phoneNumber) },
      voiceIdentity: { upsert: vi.fn() },
    };
    const { service } = buildService({ prisma });
    const result = await service.prepareOutbound(
      { userId: 'u1', role: UserRole.OWNER },
      { selectedNumberId: 'pn1', destinationNumber: '+15551111111' },
    );
    expect(result).toEqual({
      selectedNumberId: 'pn1',
      selectedCallerId: '+15552222222',
      destinationNumber: '+15551111111',
      identity: 'user_u1_number_pn1',
    });
  });

  it('normalizes formatted U.S. destinations before returning call params', async () => {
    const prisma = {
      phoneNumber: { findUnique: vi.fn().mockResolvedValue(phoneNumber) },
      voiceIdentity: { upsert: vi.fn() },
    };
    const { service } = buildService({ prisma });
    const result = await service.prepareOutbound(
      { userId: 'u1', role: UserRole.OWNER },
      { selectedNumberId: 'pn1', destinationNumber: '+1 530-441-9961' },
    );

    expect(result.destinationNumber).toBe('+15304419961');
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
    expect(config.closeProtection).toBe(true);
  });
});
