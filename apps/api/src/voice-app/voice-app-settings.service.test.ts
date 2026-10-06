import { describe, expect, it, vi } from 'vitest';

import { VoiceAppSettingsService } from './voice-app-settings.service';

const actor = { userId: 'u1', email: 'test@example.com', role: 'OPERATOR' as const };

function build(opts: { count?: number; forwarding?: Record<string, unknown> | null } = {}) {
  let forwarding = opts.forwarding ?? null;
  const prisma = {
    forwardingNumber: {
      count: vi.fn().mockResolvedValue(opts.count ?? 0),
      create: vi.fn().mockImplementation(({ data }) =>
        Promise.resolve({
          id: 'f1',
          verifiedAt: null,
          verifyStatus: null,
          createdAt: new Date(),
          ...data,
        }),
      ),
      findUnique: vi.fn().mockImplementation(() => Promise.resolve(forwarding)),
      update: vi.fn().mockImplementation(({ data }) => {
        forwarding = { ...forwarding, ...data };
        return Promise.resolve(forwarding);
      }),
    },
  };
  const calls = { create: vi.fn().mockResolvedValue({ sid: 'CAverify' }) };
  const twilio = {
    webhookBaseUrl: 'https://api.example.com',
    accountSid: 'AC1',
    client: { api: { v2010: { accounts: () => ({ calls }) } } },
  };
  const realtime = { voiceAppSync: vi.fn() };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const ctx = {
    numbers: vi.fn().mockResolvedValue([{ phoneNumberE164: '+18776524532' }]),
    primaryNumber: vi.fn().mockResolvedValue({ phoneNumberE164: '+18776524532' }),
  };
  const service = new VoiceAppSettingsService(
    prisma as never,
    twilio as never,
    realtime as never,
    audit as never,
    ctx as never,
  );
  return { service, prisma, calls, realtime, current: () => forwarding };
}

describe('VoiceAppSettingsService linked phones', () => {
  it('adds a phone switched off until it is verified', async () => {
    const { service, prisma } = build();
    const result = await service.addForwarding(actor, { number: '+14155550199', label: 'Cell' });
    expect(prisma.forwardingNumber.create).toHaveBeenCalledWith({
      data: { userId: 'u1', e164: '+14155550199', label: 'Cell', enabled: false },
    });
    expect(result.verified).toBe(false);
  });

  it('allows at most six linked phones', async () => {
    const { service } = build({ count: 6 });
    await expect(
      service.addForwarding(actor, { number: '+14155550199', label: 'Cell' }),
    ).rejects.toThrow('up to 6 phones');
  });

  it("won't link the Voice number itself", async () => {
    const { service } = build();
    await expect(
      service.addForwarding(actor, { number: '+18776524532', label: 'Loop' }),
    ).rejects.toThrow('different phone');
  });

  it("won't switch on an unverified phone", async () => {
    const { service } = build({
      forwarding: { id: 'f1', userId: 'u1', e164: '+14155550199', verifiedAt: null },
    });
    await expect(service.updateForwarding(actor, 'f1', { enabled: true })).rejects.toThrow(
      'Verify this phone',
    );
  });

  it('verifies a phone that enters the code from the screen', async () => {
    const { service, calls, current } = build({
      forwarding: {
        id: 'f1',
        userId: 'u1',
        e164: '+14155550199',
        label: 'Cell',
        enabled: false,
        verifiedAt: null,
        verifyStatus: null,
        createdAt: new Date(),
      },
    });
    const { code } = await service.startVerification(actor, 'f1');
    expect(code).toMatch(/^\d{2}$/);
    expect(calls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '+14155550199',
        from: '+18776524532',
        url: 'https://api.example.com/webhooks/twilio/voice-app/verify?fid=f1&attempt=1',
      }),
    );
    expect(current()).toMatchObject({ verifyStatus: 'calling', verifyCallSid: 'CAverify' });

    const prompt = await service.verifyPromptTwiml('f1', 1);
    expect(prompt).toContain('numDigits="2"');

    const wrong = String((Number(code) % 89) + 10);
    const retry = await service.verifyCheckTwiml('f1', 1, wrong === code ? '00' : wrong);
    expect(retry).toContain('<Redirect method="POST">');

    const ok = await service.verifyCheckTwiml('f1', 2, code);
    expect(ok).toContain('now linked');
    expect(current()).toMatchObject({ enabled: true, verifyStatus: null, verifyCodeHash: null });
    expect(current()?.verifiedAt).toBeInstanceOf(Date);
  });

  it('gives up after three wrong codes', async () => {
    const { service, current } = build({
      forwarding: {
        id: 'f1',
        userId: 'u1',
        verifyCodeHash: 'x',
        verifyExpiresAt: new Date(Date.now() + 60_000),
        verifyStatus: 'calling',
      },
    });
    const xml = await service.verifyCheckTwiml('f1', 3, '12');
    expect(xml).toContain('start again in the app');
    expect(current()).toMatchObject({ verifyStatus: 'wrong-code', verifyCodeHash: null });
  });

  it('marks an unanswered verification call as failed', async () => {
    const { service, current } = build({
      forwarding: {
        id: 'f1',
        userId: 'u1',
        verifiedAt: null,
        verifyStatus: 'calling',
        verifyCallSid: 'CAv',
      },
    });
    await service.verifyCallEnded('f1', 'CAv');
    expect(current()).toMatchObject({ verifyStatus: 'failed' });
  });
});
