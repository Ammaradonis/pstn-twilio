import { CallDirection, CallStatus, RecordingStatus, WebhookProvider } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { VoiceWebhookService } from './voice.service';

function buildService(overrides: { prisma?: any; twilio?: any; realtime?: any } = {}) {
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
  };
  const twilio = overrides.twilio ?? {
    webhookBaseUrl: 'https://example.com',
    voiceIdentity: (userId: string, numberId?: string) =>
      numberId ? `user_${userId}_number_${numberId}` : `user_${userId}`,
  };
  const realtime = overrides.realtime ?? {
    callInboundRinging: vi.fn(),
    callStatusUpdated: vi.fn(),
  };
  return { service: new VoiceWebhookService(prisma, twilio, realtime), prisma, twilio, realtime };
}

describe('VoiceWebhookService.handleInbound', () => {
  it('returns hangup TwiML when CallSid or To missing', async () => {
    const { service } = buildService();
    const xml = await service.handleInbound({});
    expect(xml).toContain('<Response>');
    expect(xml).toContain('<Hangup');
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
    expect(xml).toContain('not configured');
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
    expect(xml).toContain('record="record-from-answer-dual"');
    expect(xml).toContain(
      'recordingStatusCallback="https://example.com/webhooks/twilio/voice/recording"',
    );
    expect(xml).toContain('recordingStatusCallbackEvent="in-progress completed absent"');
    expect(xml).toContain('<Client');
    expect(xml).toContain('user_u1_number_pn1');
    expect(xml).toContain('statusCallback="https://example.com/webhooks/twilio/voice/status"');
  });
});

describe('VoiceWebhookService.handleOutbound', () => {
  it('hangups when selectedNumberId or destination is missing', async () => {
    const { service } = buildService();
    const xml = await service.handleOutbound({ CallSid: 'CA1' }, 'user_u1_number_pn1');
    expect(xml).toContain('Missing call parameters');
  });

  it('rejects invalid destination E.164', async () => {
    const { service } = buildService();
    const xml = await service.handleOutbound(
      { CallSid: 'CA1', selectedNumberId: 'pn1', destinationNumber: 'not-a-number' },
      'user_u1_number_pn1',
    );
    expect(xml).toContain('valid phone number');
  });

  it('rejects when caller identity does not match number ownership', async () => {
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
    };
    const { service } = buildService({ prisma });
    const xml = await service.handleOutbound(
      {
        CallSid: 'CA1',
        selectedNumberId: 'pn1',
        destinationNumber: '+15551111111',
      },
      'user_attacker_number_pn1',
    );
    expect(xml).toContain('not authorized');
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
      fromE164: 'user_u1_number_pn1',
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
    };
    const { service, realtime } = buildService({ prisma });

    const xml = await service.handleOutbound(
      {
        CallSid: 'CA1',
        selectedNumberId: 'pn1',
        destinationNumber: '+15551111111',
      },
      'user_u1_number_pn1',
    );
    expect(xml).toContain('callerId="+15552222222"');
    expect(xml).toContain('record="record-from-answer-dual"');
    expect(xml).toContain(
      'recordingStatusCallback="https://example.com/webhooks/twilio/voice/recording"',
    );
    expect(xml).toContain('<Number>+15551111111</Number>');
    expect(realtime.callStatusUpdated).toHaveBeenCalled();
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
      fromE164: 'user_u1_number_pn1',
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
    };
    const { service } = buildService({ prisma });

    const xml = await service.handleOutbound(
      {
        CallSid: 'CA1',
        selectedNumberId: 'pn1',
        destinationNumber: '+1 530-441-9961',
      },
      'user_u1_number_pn1',
    );

    expect(prisma.call.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          toE164: '+15304419961',
          destinationE164: '+15304419961',
        }),
      }),
    );
    expect(xml).toContain('<Number>+15304419961</Number>');
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
    const { service, realtime } = buildService({ prisma });
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
  it('returns valid Say + Hangup TwiML', () => {
    const { service } = buildService();
    const xml = service.handleFallback();
    expect(xml).toContain('<Response>');
    expect(xml).toContain('<Say');
    expect(xml).toContain('<Hangup');
  });
});
