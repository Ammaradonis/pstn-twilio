import { CallDirection, CallStatus, RecordingStatus, WebhookProvider } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { VoiceWebhookService } from './voice.service';

function buildService(overrides: { prisma?: any; twilio?: any; realtime?: any; redis?: any } = {}) {
  const prisma = overrides.prisma ?? {
    webhookEvent: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    phoneNumber: { findUnique: vi.fn().mockResolvedValue(null) },
    call: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
    },
    callRecording: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
    },
    outboundCallIntent: {
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const twilio = overrides.twilio ?? {
    webhookBaseUrl: 'https://example.com',
    voiceIdentity: (userId: string) => `user_${userId}`,
  };
  const realtime = overrides.realtime ?? {
    callInboundRinging: vi.fn(),
    callStatusUpdated: vi.fn(),
  };
  // Mock Redis: SET NX returns 'OK' (new key → not a duplicate) by default.
  const redis = overrides.redis ?? {
    client: {
      set: vi.fn().mockResolvedValue('OK'),
    },
  };
  return {
    service: new VoiceWebhookService(prisma, twilio, realtime, redis),
    prisma,
    twilio,
    realtime,
    redis,
  };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function makeOutboundIntent(
  phoneNumber: {
    id: string;
    userId: string | null;
    phoneNumberE164: string;
    active: boolean;
    capabilitiesVoice: boolean;
  },
  overrides: Record<string, unknown> = {},
) {
  return {
    id: 'intent1',
    userId: phoneNumber.userId ?? 'u1',
    phoneNumberId: phoneNumber.id,
    identity: phoneNumber.userId ? `user_${phoneNumber.userId}` : '',
    destinationE164: '+15551111111',
    selectedCallerId: phoneNumber.phoneNumberE164,
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    consumedByCallSid: null,
    recordCall: true,
    createdAt: new Date('2026-05-19T00:00:00Z'),
    updatedAt: new Date('2026-05-19T00:00:00Z'),
    phoneNumber,
    ...overrides,
  };
}

describe('VoiceWebhookService.handleInbound', () => {
  it('rejects without answering when CallSid or To is missing', async () => {
    const { service } = buildService();
    const xml = await service.handleInbound({});
    expect(xml).toContain('<Response>');
    expect(xml).toContain('<Response><Reject reason="busy"/></Response>');
  });

  it('returns hangup TwiML for unknown destination number', async () => {
    const prisma = {
      webhookEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      phoneNumber: { findUnique: vi.fn().mockResolvedValue(null) },
      call: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    };
    const { service, realtime } = buildService({ prisma });
    const xml = await service.handleInbound({
      CallSid: 'CA1',
      From: '+15551111111',
      To: '+15559999999',
    });
    expect(xml).toContain('<Response><Reject reason="busy"/></Response>');
    expect(realtime.callInboundRinging).not.toHaveBeenCalled();
  });

  it('persists call, emits ringing, and returns <Dial><Client/></Dial> for known number', async () => {
    const phoneNumber = {
      id: 'pn1',
      phoneNumberE164: '+15552222222',
      userId: 'u1',
      active: true,
      capabilitiesVoice: true,
    };
    const created = {
      id: 'c1',
      phoneNumberId: 'pn1',
      twilioCallSid: 'CA1',
      direction: CallDirection.INBOUND,
      fromE164: '+15551111111',
      toE164: '+15552222222',
      selectedCallerId: null,
      destinationE164: null,
      status: CallStatus.RINGING,
      durationSeconds: null,
      startedAt: new Date('2026-05-19T00:00:00Z'),
      answeredAt: null,
      endedAt: null,
      createdAt: new Date('2026-05-19T00:00:00Z'),
    };
    const prisma = {
      webhookEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      phoneNumber: { findUnique: vi.fn().mockResolvedValue(phoneNumber) },
      call: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(created),
        update: vi.fn(),
      },
      outboundCallIntent: {
        findUnique: vi.fn().mockResolvedValue(makeOutboundIntent(phoneNumber)),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const { service, realtime } = buildService({ prisma });

    const xml = await service.handleInbound({
      CallSid: 'CA1',
      From: '+15551111111',
      To: '+15552222222',
      CallStatus: 'ringing',
    });

    expect(prisma.webhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: WebhookProvider.TWILIO,
          eventType: 'voice.inbound',
          twilioSid: 'CA1',
        }),
      }),
    );
    expect(prisma.call.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          twilioCallSid: 'CA1',
          phoneNumberId: 'pn1',
          direction: CallDirection.INBOUND,
        }),
      }),
    );
    expect(realtime.callInboundRinging).toHaveBeenCalledWith(
      expect.objectContaining({ numberId: 'pn1' }),
    );
    expect(xml).toContain('<Dial');
    expect(xml).toContain('<Response><Dial answerOnBridge="true"');
    expect(xml).toContain('action="https://example.com/webhooks/twilio/voice/dial-complete"');
    expect(xml).toContain('record="do-not-record"');
    expect(xml).not.toContain('recordingStatusCallback');
    expect(xml).not.toMatch(/<(Say|Record|Play|Pause)/);
    expect(xml).toContain('<Client');
    // Every number rings the owner's one browser identity, tagged with the
    // number that was called.
    expect(xml).toContain('<Identity>user_u1</Identity>');
    expect(xml).toContain('<Parameter name="calledNumber" value="+15552222222"/>');
    // The answering browser files its recording under the inbound call.
    expect(xml).toContain('<Parameter name="parentCallSid" value="CA1"/>');
    expect(xml).toContain('statusCallback="https://example.com/webhooks/twilio/voice/status"');

    // The browser records unless the number opts out; Twilio never does here,
    // whatever the old Twilio-recording tag says.
    for (const [tags, record] of [
      [{}, 'true'],
      [{ recordInboundInBrowser: true }, 'true'],
      [{ recordInboundCalls: false }, 'true'],
      [{ recordInboundInBrowser: false, recordInboundCalls: true }, 'false'],
    ] as const) {
      prisma.phoneNumber.findUnique.mockResolvedValue({
        ...phoneNumber,
        tags,
      } as typeof phoneNumber);
      const next = await service.handleInbound({
        CallSid: 'CA2',
        From: '+15551111111',
        To: phoneNumber.phoneNumberE164,
      });
      expect(next).toContain(`<Parameter name="recordCall" value="${record}"/>`);
      expect(next).toContain('record="do-not-record"');
    }
  });

  it.each([
    { active: false, userId: 'u1' },
    { active: true, userId: null },
  ])('rejects unavailable numbers without answering: %o', async (number) => {
    const { service, prisma } = buildService();
    prisma.phoneNumber.findUnique.mockResolvedValue(number);
    expect(await service.handleInbound({ CallSid: 'CA1', To: '+15552222222' })).toContain(
      '<Response><Reject reason="busy"/></Response>',
    );
  });
});

describe('VoiceWebhookService.handleVoicemail', () => {
  it.each(['no-answer', 'busy', 'failed', 'canceled', 'unknown'])(
    'rejects %s calls without voicemail or answering',
    async (status) => {
      const { service } = buildService();
      const xml = await service.handleVoicemail({
        CallSid: 'CA1',
        From: '+15551111111',
        To: '+15552222222',
        DialCallStatus: status,
      });

      expect(xml).toContain('<Response><Reject reason="busy"/></Response>');
    },
  );

  it('hangs up instead of recording when the browser call completed', async () => {
    const { service } = buildService();
    const xml = await service.handleVoicemail({
      CallSid: 'CA1',
      DialCallStatus: 'completed',
    });

    expect(xml).toContain('<Hangup');
    expect(xml).not.toContain('<Record');
  });
});

describe('agent fallback on the AI caller line', () => {
  const phoneNumber = {
    id: 'pn667',
    phoneNumberE164: '+16672206726',
    userId: 'u1',
    active: true,
    capabilitiesVoice: true,
  };

  function buildForInbound() {
    const prisma = {
      webhookEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      phoneNumber: { findUnique: vi.fn().mockResolvedValue(phoneNumber) },
      call: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: 'c1',
          phoneNumberId: 'pn667',
          twilioCallSid: 'CA1',
          direction: CallDirection.INBOUND,
          fromE164: '+15551111111',
          toE164: '+16672206726',
          status: CallStatus.RINGING,
          createdAt: new Date('2026-10-04T00:00:00Z'),
        }),
        update: vi.fn(),
      },
    };
    return buildService({ prisma });
  }

  it('rings the browser first and comes back to ask for the agent when unanswered', async () => {
    const { service } = buildForInbound();
    const inbound = { CallSid: 'CA1', From: '+15551111111', To: '+16672206726' };

    const withAgent = await service.handleInbound(inbound, { agentFallback: true });
    expect(withAgent).toContain('<Identity>user_u1</Identity>');
    expect(withAgent).toContain(
      'action="https://example.com/webhooks/twilio/voice/dial-complete?fallback=agent"',
    );

    const browserOnly = await service.handleInbound(inbound);
    expect(browserOnly).toContain(
      'action="https://example.com/webhooks/twilio/voice/dial-complete"',
    );
  });

  it.each(['no-answer', 'busy', 'failed'])(
    'hands a %s call to the Vapi agent',
    async (DialCallStatus) => {
      const { service } = buildService();
      const xml = await service.handleVoicemail(
        { CallSid: 'CA1', DialCallStatus },
        { agentFallback: true },
      );
      expect(xml).toBe(
        '<?xml version="1.0" encoding="UTF-8"?><Response>' +
          '<Redirect method="POST">https://api.vapi.ai/twilio/inbound_call</Redirect></Response>',
      );
    },
  );

  it('never hands an answered or abandoned call to the agent', async () => {
    const { service } = buildService();
    const answered = await service.handleVoicemail(
      { CallSid: 'CA1', DialCallStatus: 'completed' },
      { agentFallback: true },
    );
    expect(answered).toContain('<Hangup');

    // The caller hung up while it was ringing.
    const abandoned = await service.handleVoicemail(
      { CallSid: 'CA1', DialCallStatus: 'canceled' },
      { agentFallback: true },
    );
    expect(abandoned).not.toContain('vapi');
  });
});

describe('VoiceWebhookService.handleOutbound', () => {
  it('hangups when selectedNumberId or destination is missing', async () => {
    const { service } = buildService();
    const xml = await service.handleOutbound({ CallSid: 'CA1' }, 'user_u1');
    expect(xml).toContain('Missing call parameters');
  });

  it('rejects outbound requests without a browser client identity', async () => {
    const { service, prisma } = buildService();
    const xml = await service.handleOutbound(
      {
        CallSid: 'CA1',
        selectedNumberId: 'pn1',
        destinationNumber: '+15551111111',
        outboundIntentId: 'intent1',
      },
      undefined,
    );

    expect(xml).toContain('Missing browser identity');
    expect(prisma.outboundCallIntent.findUnique).not.toHaveBeenCalled();
  });

  it('rejects invalid destination E.164', async () => {
    const { service } = buildService();
    const xml = await service.handleOutbound(
      {
        CallSid: 'CA1',
        selectedNumberId: 'pn1',
        destinationNumber: 'not-a-number',
        outboundIntentId: 'intent1',
      },
      'user_u1',
    );
    expect(xml).toContain('valid phone number');
  });

  it('rejects when caller identity does not match the prepared intent', async () => {
    const phoneNumber = {
      id: 'pn1',
      userId: 'u1',
      phoneNumberE164: '+15552222222',
      active: true,
      capabilitiesVoice: true,
    };
    const prisma = {
      webhookEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      phoneNumber: { findUnique: vi.fn().mockResolvedValue(phoneNumber) },
      call: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
      outboundCallIntent: {
        findUnique: vi.fn().mockResolvedValue(makeOutboundIntent(phoneNumber)),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const { service } = buildService({ prisma });
    const xml = await service.handleOutbound(
      {
        CallSid: 'CA1',
        selectedNumberId: 'pn1',
        destinationNumber: '+15551111111',
        outboundIntentId: 'intent1',
      },
      'user_attacker',
    );
    expect(xml).toContain('Call authorization expired');
    expect(prisma.outboundCallIntent.updateMany).not.toHaveBeenCalled();
  });

  it('returns <Dial callerId><Number/></Dial> for an authorized request', async () => {
    const phoneNumber = {
      id: 'pn1',
      userId: 'u1',
      phoneNumberE164: '+15552222222',
      active: true,
      capabilitiesVoice: true,
    };
    const created = {
      id: 'c1',
      phoneNumberId: 'pn1',
      twilioCallSid: 'CA1',
      direction: CallDirection.OUTBOUND,
      fromE164: 'user_u1',
      toE164: '+15551111111',
      selectedCallerId: '+15552222222',
      destinationE164: '+15551111111',
      status: CallStatus.INITIATED,
      durationSeconds: null,
      startedAt: new Date('2026-05-19T00:00:00Z'),
      answeredAt: null,
      endedAt: null,
      createdAt: new Date('2026-05-19T00:00:00Z'),
    };
    const prisma = {
      webhookEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      phoneNumber: { findUnique: vi.fn().mockResolvedValue(phoneNumber) },
      call: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(created),
        update: vi.fn(),
      },
      outboundCallIntent: {
        findUnique: vi.fn().mockResolvedValue(makeOutboundIntent(phoneNumber)),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const { service, realtime } = buildService({ prisma });

    const xml = await service.handleOutbound(
      {
        CallSid: 'CA1',
        selectedNumberId: 'pn1',
        destinationNumber: '+15551111111',
        outboundIntentId: 'intent1',
      },
      'user_u1',
    );
    expect(xml).toContain('callerId="+15552222222"');
    expect(xml).toContain('record="record-from-answer-dual"');
    expect(xml).toContain(
      'recordingStatusCallback="https://example.com/webhooks/twilio/voice/recording"',
    );
    expect(xml).toContain('statusCallback="https://example.com/webhooks/twilio/voice/status"');
    expect(xml).toContain('>+15551111111</Number>');
    expect(prisma.outboundCallIntent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'intent1',
          consumedAt: null,
        }),
        data: expect.objectContaining({
          consumedAt: expect.any(Date),
          consumedByCallSid: 'CA1',
        }),
      }),
    );
    await flushAsyncWork();
    expect(realtime.callStatusUpdated).toHaveBeenCalled();
  });

  it('dials without recording when the outbound intent opted out of recording', async () => {
    const phoneNumber = {
      id: 'pn1',
      userId: 'u1',
      phoneNumberE164: '+15552222222',
      active: true,
      capabilitiesVoice: true,
    };
    const prisma = {
      webhookEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      call: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: 'c1',
          phoneNumberId: 'pn1',
          twilioCallSid: 'CA1',
          direction: CallDirection.OUTBOUND,
          fromE164: 'user_u1',
          toE164: '+15551111111',
          selectedCallerId: '+15552222222',
          destinationE164: '+15551111111',
          status: CallStatus.INITIATED,
          durationSeconds: null,
          startedAt: new Date('2026-05-19T00:00:00Z'),
          answeredAt: null,
          endedAt: null,
          createdAt: new Date('2026-05-19T00:00:00Z'),
        }),
        update: vi.fn(),
      },
      outboundCallIntent: {
        findUnique: vi
          .fn()
          .mockResolvedValue(makeOutboundIntent(phoneNumber, { recordCall: false })),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const { service } = buildService({ prisma });

    const xml = await service.handleOutbound(
      {
        CallSid: 'CA1',
        selectedNumberId: 'pn1',
        destinationNumber: '+15551111111',
        outboundIntentId: 'intent1',
      },
      'user_u1',
    );
    await flushAsyncWork();

    expect(xml).toContain('callerId="+15552222222"');
    expect(xml).toContain('>+15551111111</Number>');
    expect(xml).not.toContain('record=');
    expect(xml).not.toContain('recordingStatusCallback');
  });

  it('allows a Twilio retry for the same consumed outbound intent and CallSid', async () => {
    const phoneNumber = {
      id: 'pn1',
      userId: 'u1',
      phoneNumberE164: '+15552222222',
      active: true,
      capabilitiesVoice: true,
    };
    const consumedAt = new Date('2026-05-19T00:00:05Z');
    const prisma = {
      webhookEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      phoneNumber: { findUnique: vi.fn().mockResolvedValue(phoneNumber) },
      call: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: 'c1',
          phoneNumberId: 'pn1',
          twilioCallSid: 'CA1',
          direction: CallDirection.OUTBOUND,
          fromE164: 'user_u1',
          toE164: '+15551111111',
          selectedCallerId: '+15552222222',
          destinationE164: '+15551111111',
          status: CallStatus.INITIATED,
          durationSeconds: null,
          startedAt: new Date('2026-05-19T00:00:00Z'),
          answeredAt: null,
          endedAt: null,
          createdAt: new Date('2026-05-19T00:00:00Z'),
        }),
        update: vi.fn(),
      },
      outboundCallIntent: {
        findUnique: vi.fn().mockResolvedValue(
          makeOutboundIntent(phoneNumber, {
            consumedAt,
            consumedByCallSid: 'CA1',
          }),
        ),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const { service } = buildService({ prisma });

    const xml = await service.handleOutbound(
      {
        CallSid: 'CA1',
        selectedNumberId: 'pn1',
        destinationNumber: '+15551111111',
        outboundIntentId: 'intent1',
      },
      'user_u1',
    );

    expect(xml).toContain('callerId="+15552222222"');
    expect(xml).toContain('>+15551111111</Number>');
    expect(prisma.outboundCallIntent.updateMany).not.toHaveBeenCalled();
  });

  it('normalizes formatted U.S. destinations before dialing Twilio', async () => {
    const phoneNumber = {
      id: 'pn1',
      userId: 'u1',
      phoneNumberE164: '+15552222222',
      active: true,
      capabilitiesVoice: true,
    };
    const created = {
      id: 'c1',
      phoneNumberId: 'pn1',
      twilioCallSid: 'CA1',
      direction: CallDirection.OUTBOUND,
      fromE164: 'user_u1',
      toE164: '+15304419961',
      selectedCallerId: '+15552222222',
      destinationE164: '+15304419961',
      status: CallStatus.INITIATED,
      durationSeconds: null,
      startedAt: new Date('2026-05-19T00:00:00Z'),
      answeredAt: null,
      endedAt: null,
      createdAt: new Date('2026-05-19T00:00:00Z'),
    };
    const prisma = {
      webhookEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      phoneNumber: { findUnique: vi.fn().mockResolvedValue(phoneNumber) },
      call: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(created),
        update: vi.fn(),
      },
      outboundCallIntent: {
        findUnique: vi
          .fn()
          .mockResolvedValue(makeOutboundIntent(phoneNumber, { destinationE164: '+15304419961' })),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const { service } = buildService({ prisma });

    const xml = await service.handleOutbound(
      {
        CallSid: 'CA1',
        selectedNumberId: 'pn1',
        destinationNumber: '+1 530-441-9961',
        outboundIntentId: 'intent1',
      },
      'user_u1',
    );

    await flushAsyncWork();
    expect(prisma.call.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          toE164: '+15304419961',
          destinationE164: '+15304419961',
        }),
      }),
    );
    expect(xml).toContain('>+15304419961</Number>');
  });

  it('returns outbound TwiML before call persistence completes', async () => {
    const phoneNumber = {
      id: 'pn1',
      userId: 'u1',
      phoneNumberE164: '+15552222222',
      active: true,
      capabilitiesVoice: true,
    };
    const prisma = {
      webhookEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      phoneNumber: { findUnique: vi.fn().mockResolvedValue(phoneNumber) },
      call: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockReturnValue(new Promise(() => {})),
        update: vi.fn(),
      },
      outboundCallIntent: {
        findUnique: vi.fn().mockResolvedValue(makeOutboundIntent(phoneNumber)),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const { service, realtime } = buildService({ prisma });

    const xml = await service.handleOutbound(
      {
        CallSid: 'CA1',
        selectedNumberId: 'pn1',
        destinationNumber: '+15551111111',
        outboundIntentId: 'intent1',
      },
      'user_u1',
    );

    expect(xml).toContain('<Dial');
    expect(xml).toContain('>+15551111111</Number>');
    expect(realtime.callStatusUpdated).not.toHaveBeenCalled();
  });

  it('does not downgrade an existing later call status when async start persistence wins late', async () => {
    const phoneNumber = {
      id: 'pn1',
      userId: 'u1',
      phoneNumberE164: '+15552222222',
      active: true,
      capabilitiesVoice: true,
    };
    const existing = {
      id: 'c1',
      phoneNumberId: null,
      twilioCallSid: 'CA1',
      parentCallSid: null,
      direction: CallDirection.OUTBOUND,
      fromE164: '',
      toE164: '',
      browserIdentity: null,
      selectedCallerId: null,
      destinationE164: null,
      status: CallStatus.IN_PROGRESS,
      durationSeconds: null,
      price: null,
      priceUnit: null,
      rawPayload: null,
      startedAt: null,
      answeredAt: null,
      endedAt: null,
      createdAt: new Date('2026-05-19T00:00:00Z'),
      updatedAt: new Date('2026-05-19T00:00:00Z'),
    };
    const prisma = {
      webhookEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      phoneNumber: { findUnique: vi.fn().mockResolvedValue(phoneNumber) },
      call: {
        findUnique: vi.fn().mockResolvedValue(existing),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue({
          ...existing,
          phoneNumberId: 'pn1',
          fromE164: 'user_u1',
          toE164: '+15551111111',
          selectedCallerId: '+15552222222',
          destinationE164: '+15551111111',
        }),
      },
      outboundCallIntent: {
        findUnique: vi.fn().mockResolvedValue(makeOutboundIntent(phoneNumber)),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const { service } = buildService({ prisma });

    await service.handleOutbound(
      {
        CallSid: 'CA1',
        selectedNumberId: 'pn1',
        destinationNumber: '+15551111111',
        outboundIntentId: 'intent1',
      },
      'user_u1',
    );
    await flushAsyncWork();

    expect(prisma.call.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          phoneNumberId: 'pn1',
          selectedCallerId: '+15552222222',
          destinationE164: '+15551111111',
        }),
      }),
    );
    expect(prisma.call.update.mock.calls[0][0].data).not.toHaveProperty('status');
  });
});

describe('VoiceWebhookService.handleStatus', () => {
  it('skips when CallSid or CallStatus missing', async () => {
    const { service, prisma } = buildService();
    await service.handleStatus({});
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
  });

  it('dedupes when the same (sid, status) pair was already processed', async () => {
    const prisma = {
      webhookEvent: {
        findUnique: vi.fn().mockResolvedValue({ id: 'w1' }),
        create: vi.fn(),
      },
      phoneNumber: { findUnique: vi.fn() },
      call: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    };
    // Redis SET NX returns null when the key already exists → already processed.
    const redis = { client: { set: vi.fn().mockResolvedValue(null) } };
    const { service, realtime } = buildService({ prisma, redis });
    await service.handleStatus({ CallSid: 'CA1', CallStatus: 'completed' });
    expect(prisma.call.update).not.toHaveBeenCalled();
    expect(prisma.call.create).not.toHaveBeenCalled();
    expect(realtime.callStatusUpdated).not.toHaveBeenCalled();
  });

  it('updates an existing call, sets endedAt on terminal states, emits status event', async () => {
    const existing = {
      id: 'c1',
      phoneNumberId: 'pn1',
      twilioCallSid: 'CA1',
      direction: CallDirection.OUTBOUND,
      fromE164: '+15552222222',
      toE164: '+15551111111',
      selectedCallerId: '+15552222222',
      destinationE164: '+15551111111',
      status: CallStatus.IN_PROGRESS,
      durationSeconds: null,
      startedAt: new Date('2026-05-19T00:00:00Z'),
      answeredAt: new Date('2026-05-19T00:00:01Z'),
      endedAt: null,
      createdAt: new Date('2026-05-19T00:00:00Z'),
    };
    const updated = {
      ...existing,
      status: CallStatus.COMPLETED,
      durationSeconds: 42,
      endedAt: new Date('2026-05-19T00:00:42Z'),
    };
    const prisma = {
      webhookEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      phoneNumber: { findUnique: vi.fn() },
      call: {
        findUnique: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockResolvedValue(updated),
        create: vi.fn(),
      },
    };
    const { service, realtime } = buildService({ prisma });

    await service.handleStatus({
      CallSid: 'CA1',
      CallStatus: 'completed',
      CallDuration: '42',
      Price: '-0.0085',
      PriceUnit: 'USD',
    });

    expect(prisma.call.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { twilioCallSid: 'CA1' },
        data: expect.objectContaining({
          status: CallStatus.COMPLETED,
          durationSeconds: 42,
          price: '-0.0085',
          priceUnit: 'USD',
        }),
      }),
    );
    const updateData = prisma.call.update.mock.calls[0][0].data;
    expect(updateData.endedAt).toBeInstanceOf(Date);
    expect(realtime.callStatusUpdated).toHaveBeenCalledTimes(1);
  });

  it('updates the parent outbound call when Twilio sends a child Number leg status', async () => {
    const parent = {
      id: 'c1',
      phoneNumberId: 'pn1',
      twilioCallSid: 'CA-parent',
      parentCallSid: null,
      direction: CallDirection.OUTBOUND,
      fromE164: 'user_u1',
      toE164: '+15551111111',
      selectedCallerId: '+15552222222',
      destinationE164: '+15551111111',
      status: CallStatus.RINGING,
      durationSeconds: null,
      price: null,
      priceUnit: null,
      rawPayload: null,
      startedAt: new Date('2026-05-19T00:00:00Z'),
      answeredAt: null,
      endedAt: null,
      createdAt: new Date('2026-05-19T00:00:00Z'),
    };
    const updated = {
      ...parent,
      status: CallStatus.IN_PROGRESS,
      answeredAt: new Date('2026-05-19T00:00:01Z'),
    };
    const prisma = {
      webhookEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      phoneNumber: { findUnique: vi.fn() },
      call: {
        findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(parent),
        update: vi.fn().mockResolvedValue(updated),
        create: vi.fn(),
      },
    };
    const { service, realtime } = buildService({ prisma });

    await service.handleStatus({
      CallSid: 'CA-child',
      ParentCallSid: 'CA-parent',
      CallStatus: 'in-progress',
      Direction: 'outbound-dial',
    });

    expect(prisma.call.create).not.toHaveBeenCalled();
    expect(prisma.call.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { twilioCallSid: 'CA-parent' },
        data: expect.objectContaining({
          status: CallStatus.IN_PROGRESS,
          rawPayload: expect.objectContaining({ CallSid: 'CA-child' }),
        }),
      }),
    );
    expect(prisma.call.update.mock.calls[0][0].data).not.toHaveProperty('parentCallSid');
    expect(realtime.callStatusUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ numberId: 'pn1' }),
    );
  });
});

describe('VoiceWebhookService.handleRecording', () => {
  it('skips when CallSid, RecordingSid, or RecordingStatus is missing', async () => {
    const { service, prisma } = buildService();
    await service.handleRecording({});
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
    expect(prisma.callRecording.upsert).not.toHaveBeenCalled();
  });

  it('upserts recording metadata, links it to the call, and emits an updated call', async () => {
    const existingCall = {
      id: 'c1',
      phoneNumberId: 'pn1',
      twilioCallSid: 'CA1',
      direction: CallDirection.OUTBOUND,
      fromE164: '+15552222222',
      toE164: '+15551111111',
      selectedCallerId: '+15552222222',
      destinationE164: '+15551111111',
      status: CallStatus.COMPLETED,
      durationSeconds: 42,
      startedAt: new Date('2026-05-19T00:00:00Z'),
      answeredAt: new Date('2026-05-19T00:00:01Z'),
      endedAt: new Date('2026-05-19T00:00:42Z'),
      createdAt: new Date('2026-05-19T00:00:00Z'),
    };
    const recording = {
      id: 'rec-db-1',
      callId: 'c1',
      twilioCallSid: 'CA1',
      twilioRecordingSid: 'RE1',
      recordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1',
      status: RecordingStatus.COMPLETED,
      durationSeconds: 42,
      channels: 2,
      source: 'DialVerb',
      track: 'both',
      rawPayload: null,
      startedAt: null,
      createdAt: new Date('2026-05-19T00:00:43Z'),
      updatedAt: new Date('2026-05-19T00:00:43Z'),
    };
    const updatedCall = { ...existingCall, recordings: [recording] };
    const prisma = {
      webhookEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      phoneNumber: { findUnique: vi.fn() },
      call: {
        findUnique: vi.fn().mockResolvedValueOnce(existingCall).mockResolvedValueOnce(updatedCall),
        create: vi.fn(),
        update: vi.fn(),
      },
      callRecording: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue(recording),
      },
    };
    const { service, realtime } = buildService({ prisma });

    await service.handleRecording({
      CallSid: 'CA1',
      RecordingSid: 'RE1',
      RecordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1',
      RecordingStatus: 'completed',
      RecordingDuration: '42',
      RecordingChannels: '2',
      RecordingSource: 'DialVerb',
      RecordingTrack: 'both',
    });

    expect(prisma.webhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: WebhookProvider.TWILIO,
          eventType: 'voice.recording',
          twilioSid: 'RE1',
        }),
      }),
    );
    expect(prisma.callRecording.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { twilioRecordingSid: 'RE1' },
        create: expect.objectContaining({
          callId: 'c1',
          twilioCallSid: 'CA1',
          twilioRecordingSid: 'RE1',
          recordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1',
          status: RecordingStatus.COMPLETED,
          durationSeconds: 42,
          channels: 2,
          source: 'DialVerb',
          track: 'both',
        }),
      }),
    );
    expect(realtime.callStatusUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        numberId: 'pn1',
        call: expect.objectContaining({
          id: 'c1',
          recordings: expect.arrayContaining([
            expect.objectContaining({
              twilioRecordingSid: 'RE1',
              status: RecordingStatus.COMPLETED,
              durationSeconds: 42,
            }),
          ]),
        }),
      }),
    );
  });

  it('tags voicemail recordings for the dashboard inbox', async () => {
    const existingCall = {
      id: 'c1',
      phoneNumberId: 'pn1',
      twilioCallSid: 'CA1',
      direction: CallDirection.INBOUND,
      fromE164: '+15551111111',
      toE164: '+15552222222',
      selectedCallerId: null,
      destinationE164: null,
      status: CallStatus.NO_ANSWER,
      durationSeconds: null,
      startedAt: new Date('2026-05-19T00:00:00Z'),
      answeredAt: null,
      endedAt: null,
      createdAt: new Date('2026-05-19T00:00:00Z'),
    };
    const recording = {
      id: 'rec-db-1',
      callId: 'c1',
      twilioCallSid: 'CA1',
      twilioRecordingSid: 'RE1',
      recordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1',
      status: RecordingStatus.COMPLETED,
      durationSeconds: 18,
      channels: 1,
      source: 'voicemail',
      track: null,
      rawPayload: null,
      startedAt: null,
      createdAt: new Date('2026-05-19T00:00:43Z'),
      updatedAt: new Date('2026-05-19T00:00:43Z'),
    };
    const updatedCall = { ...existingCall, recordings: [recording] };
    const prisma = {
      webhookEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      phoneNumber: { findUnique: vi.fn() },
      call: {
        findUnique: vi.fn().mockResolvedValueOnce(existingCall).mockResolvedValueOnce(updatedCall),
        create: vi.fn(),
        update: vi.fn(),
      },
      callRecording: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue(recording),
      },
    };
    const { service } = buildService({ prisma });

    await service.handleRecording(
      {
        CallSid: 'CA1',
        RecordingSid: 'RE1',
        RecordingStatus: 'completed',
        RecordingDuration: '18',
        RecordingChannels: '1',
        RecordingSource: 'RecordVerb',
      },
      { kind: 'voicemail' },
    );

    expect(prisma.webhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'voice.voicemail',
        }),
      }),
    );
    expect(prisma.callRecording.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          source: 'voicemail',
        }),
        update: expect.objectContaining({
          source: 'voicemail',
        }),
      }),
    );
  });

  it('stores recording metadata even when the matching call has not arrived yet', async () => {
    const recording = {
      id: 'rec-db-1',
      callId: null,
      twilioCallSid: 'CA-child',
      twilioRecordingSid: 'RE1',
      recordingUrl: null,
      status: RecordingStatus.IN_PROGRESS,
      durationSeconds: null,
      channels: null,
      source: null,
      track: null,
      rawPayload: null,
      startedAt: new Date('2026-05-19T00:00:01Z'),
      createdAt: new Date('2026-05-19T00:00:01Z'),
      updatedAt: new Date('2026-05-19T00:00:01Z'),
    };
    const prisma = {
      webhookEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      phoneNumber: { findUnique: vi.fn() },
      call: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
        update: vi.fn(),
      },
      callRecording: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue(recording),
      },
    };
    const { service, realtime } = buildService({ prisma });

    await service.handleRecording({
      CallSid: 'CA-child',
      RecordingSid: 'RE1',
      RecordingStatus: 'in-progress',
    });

    expect(prisma.callRecording.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          callId: null,
          twilioCallSid: 'CA-child',
          twilioRecordingSid: 'RE1',
          status: RecordingStatus.IN_PROGRESS,
        }),
      }),
    );
    expect(prisma.callRecording.upsert.mock.calls[0][0].create.startedAt).toBeInstanceOf(Date);
    expect(realtime.callStatusUpdated).not.toHaveBeenCalled();
  });
});

describe('VoiceWebhookService.handleFallback', () => {
  it('rejects fallback calls without answering', () => {
    const { service } = buildService();
    const xml = service.handleFallback();
    expect(xml).toContain('<Response>');
    expect(xml).toContain('<Response><Reject reason="busy"/></Response>');
  });

  it('returns valid voicemail completion TwiML', () => {
    const { service } = buildService();
    const xml = service.handleVoicemailComplete();
    expect(xml).toContain('<Response>');
    expect(xml).toContain('<Response><Reject reason="busy"/></Response>');
  });
});

describe('VoiceWebhookService.handleInbound for voice app users', () => {
  function setup(isVoiceUser: boolean) {
    const phoneNumber = {
      id: 'pn1',
      phoneNumberE164: '+18776524532',
      userId: 'u1',
      active: true,
      capabilitiesVoice: true,
      tags: null,
    };
    const call = {
      id: 'c1',
      phoneNumberId: 'pn1',
      twilioCallSid: 'CA1',
      direction: CallDirection.INBOUND,
      fromE164: '+14155550100',
      toE164: '+18776524532',
      status: CallStatus.RINGING,
      createdAt: new Date(),
      startedAt: new Date(),
    };
    const prisma = {
      webhookEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      phoneNumber: { findUnique: vi.fn().mockResolvedValue(phoneNumber) },
      call: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(call),
        update: vi.fn(),
      },
    };
    const voiceApp = {
      isVoiceUser: vi.fn().mockResolvedValue(isVoiceUser),
      inboundTwiml: vi.fn().mockResolvedValue('<Response>voice app</Response>'),
      voicemailTwiml: vi.fn().mockResolvedValue('<Response>voicemail</Response>'),
    };
    const realtime = { callInboundRinging: vi.fn(), callStatusUpdated: vi.fn() };
    const service = new VoiceWebhookService(
      prisma as never,
      {
        webhookBaseUrl: 'https://example.com',
        voiceIdentity: (id: string) => `user_${id}`,
      } as never,
      realtime as never,
      { client: { set: vi.fn() } } as never,
      voiceApp as never,
    );
    return { service, voiceApp, realtime };
  }
  const params = { CallSid: 'CA1', From: '+14155550100', To: '+18776524532' };

  it('hands calls to voice app users to the voice app routing', async () => {
    const { service, voiceApp, realtime } = setup(true);
    await expect(service.handleInbound(params)).resolves.toBe('<Response>voice app</Response>');
    expect(voiceApp.inboundTwiml).toHaveBeenCalledWith(
      params,
      expect.objectContaining({ id: 'pn1' }),
      'c1',
    );
    expect(realtime.callInboundRinging).toHaveBeenCalled();
  });

  it('keeps the browser-only routing for console users', async () => {
    const { service, voiceApp } = setup(false);
    const xml = await service.handleInbound(params);
    expect(voiceApp.inboundTwiml).not.toHaveBeenCalled();
    expect(xml).toContain('<Client');
    expect(xml).toContain('<Identity>user_u1</Identity>');
  });

  it('takes a voicemail if the voice app routing fails', async () => {
    const { service, voiceApp } = setup(true);
    voiceApp.inboundTwiml.mockRejectedValue(new Error('db down'));
    await expect(service.handleInbound(params)).resolves.toBe('<Response>voicemail</Response>');
  });
});
