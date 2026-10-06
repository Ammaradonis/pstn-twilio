import { CallStatus, RecordingStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { VoiceAppCallsService } from './voice-app-calls.service';

const PARENT = 'CA11111111111111111111111111111111';

function settings(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'u1',
    historyStartsAt: new Date('2026-10-01T00:00:00Z'),
    ringDevices: true,
    screenCalls: true,
    ringSeconds: 25,
    doNotDisturb: false,
    doNotDisturbUntil: null,
    voicemailEnabled: true,
    voicemailTranscribe: true,
    greetingMode: 'default',
    greetingText: null,
    ...overrides,
  };
}

const phoneNumber = {
  id: 'pn1',
  userId: 'u1',
  phoneNumberE164: '+18776524532',
  active: true,
  capabilitiesVoice: true,
};

function inboundCall(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    twilioCallSid: PARENT,
    phoneNumberId: 'pn1',
    direction: 'INBOUND',
    fromE164: '+14155550100',
    toE164: '+18776524532',
    status: CallStatus.RINGING,
    answeredAt: null,
    endedAt: null,
    handledBy: null,
    startedAt: new Date(),
    createdAt: new Date(),
    phoneNumber,
    ...overrides,
  };
}

function build(
  opts: {
    blocked?: boolean;
    settings?: Record<string, unknown>;
    forwards?: Array<Record<string, unknown>>;
    call?: Record<string, unknown> | null;
    contactName?: string | null;
    redisGet?: string | null;
    transcriber?: { enabled: boolean; transcribe: ReturnType<typeof vi.fn> };
  } = {},
) {
  const callRow = opts.call === null ? null : inboundCall(opts.call ?? {});
  const prisma = {
    call: {
      findUnique: vi.fn().mockResolvedValue(callRow),
      update: vi.fn().mockImplementation(({ data }) => Promise.resolve({ ...callRow, ...data })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    forwardingNumber: {
      findMany: vi.fn().mockResolvedValue(opts.forwards ?? []),
      findUnique: vi
        .fn()
        .mockImplementation(({ where }) =>
          Promise.resolve((opts.forwards ?? []).find((f) => f.id === where.id) ?? null),
        ),
    },
    voicemailGreeting: { findUnique: vi.fn().mockResolvedValue(null) },
    callRecording: {
      upsert: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({
        twilioCallSid: PARENT,
        call: { fromE164: '+14155550100', phoneNumber: { userId: 'u1' } },
      }),
    },
    userDevice: { findFirst: vi.fn().mockResolvedValue({ name: 'Pixel · Chrome' }) },
  };
  const legsUpdate = vi.fn().mockResolvedValue({});
  const twilioClient = {
    api: {
      v2010: {
        accounts: () => ({
          calls: Object.assign(
            (sid: string) => ({ update: (data: unknown) => legsUpdate(sid, data) }),
            {
              list: vi.fn().mockResolvedValue([
                { sid: 'CAleg1', status: 'ringing' },
                { sid: 'CAleg2', status: 'in-progress' },
                { sid: 'CAold', status: 'completed' },
              ]),
            },
          ),
        }),
      },
    },
  };
  const twilio = {
    webhookBaseUrl: 'https://api.example.com',
    accountSid: 'AC1',
    voiceIdentity: (userId: string) => `user_${userId}`,
    client: twilioClient,
  };
  const multi = { sadd: vi.fn(), expire: vi.fn(), exec: vi.fn().mockResolvedValue([]) };
  multi.sadd.mockReturnValue(multi);
  multi.expire.mockReturnValue(multi);
  const redis = {
    client: {
      get: vi.fn().mockResolvedValue(opts.redisGet ?? null),
      del: vi.fn().mockResolvedValue(1),
      set: vi.fn().mockResolvedValue('OK'),
      smembers: vi.fn().mockResolvedValue(['CAleg1']),
      multi: vi.fn().mockReturnValue(multi),
    },
  };
  const realtime = {
    callStatusUpdated: vi.fn(),
    voiceAppSync: vi.fn(),
    voiceAppCallAnswered: vi.fn(),
  };
  const push = {
    sendToUser: vi.fn().mockResolvedValue(undefined),
    actionToken: vi.fn().mockReturnValue('token'),
  };
  const ctx = {
    isVoiceUser: vi.fn().mockResolvedValue(true),
    isBlocked: vi.fn().mockResolvedValue(Boolean(opts.blocked)),
    settings: vi.fn().mockResolvedValue(settings(opts.settings)),
    contactName: vi.fn().mockResolvedValue(opts.contactName ?? null),
  };
  const transcriber = opts.transcriber ?? {
    enabled: true,
    transcribe: vi.fn().mockResolvedValue('Hi, call me back.'),
  };
  const service = new VoiceAppCallsService(
    prisma as never,
    twilio as never,
    redis as never,
    realtime as never,
    push as never,
    ctx as never,
    transcriber as never,
  );
  return { service, prisma, redis, realtime, push, ctx, legsUpdate, multi, transcriber };
}

const VERIFIED_FORWARD = {
  id: 'f1',
  userId: 'u1',
  e164: '+14155550199',
  label: 'Work phone',
  enabled: true,
  verifiedAt: new Date(),
  createdAt: new Date(),
};

describe('VoiceAppCallsService.inboundTwiml', () => {
  const params = { CallSid: PARENT, From: '+14155550100', To: '+18776524532' };

  it('rejects blocked callers unanswered with a not-in-service response', async () => {
    const { service, prisma, push } = build({ blocked: true });
    const xml = await service.inboundTwiml(params, phoneNumber as never, 'c1');
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="rejected"/></Response>',
    );
    expect(prisma.call.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { handledBy: 'blocked' },
    });
    expect(push.sendToUser).not.toHaveBeenCalled();
  });

  it('sends calls straight to voicemail during do not disturb', async () => {
    const { service, push } = build({
      settings: { doNotDisturb: true, doNotDisturbUntil: new Date(Date.now() + 60_000) },
    });
    const xml = await service.inboundTwiml(params, phoneNumber as never, 'c1');
    expect(xml).not.toContain('<Dial');
    expect(xml).toContain('<Record');
    // Transcripts come from Deepgram, not Twilio (13620 on this account).
    expect(xml).not.toContain('transcribe=');
    expect(push.sendToUser).not.toHaveBeenCalled();
  });

  it('rings again once do not disturb has expired', async () => {
    const { service } = build({
      settings: { doNotDisturb: true, doNotDisturbUntil: new Date(Date.now() - 60_000) },
    });
    const xml = await service.inboundTwiml(params, phoneNumber as never, 'c1');
    expect(xml).toContain('<Dial');
  });

  it('rings every device and each verified linked phone together, with screening', async () => {
    const { service, push, prisma } = build({ forwards: [VERIFIED_FORWARD], contactName: 'Ana' });
    const xml = await service.inboundTwiml(params, phoneNumber as never, 'c1');
    expect(prisma.forwardingNumber.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u1', enabled: true, verifiedAt: { not: null } },
      }),
    );
    expect(xml).toContain('answerOnBridge="true"');
    expect(xml).toContain('timeout="25"');
    expect(xml).toContain(
      'action="https://api.example.com/webhooks/twilio/voice-app/dial-complete"',
    );
    expect(xml).toContain('<Identity>user_u1</Identity>');
    expect(xml).toContain(`<Parameter name="parentCallSid" value="${PARENT}"/>`);
    expect(xml).toContain('<Parameter name="callerName" value="Ana"/>');
    expect(xml).toContain(
      `url="https://api.example.com/webhooks/twilio/voice-app/screen?fid=f1&amp;parent=${PARENT}"`,
    );
    expect(xml).toContain('>+14155550199</Number>');
    expect(push.sendToUser).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({
        type: 'incoming-call',
        title: 'Ana',
        tag: `call-${PARENT}`,
        callSid: PARENT,
        actionToken: 'token',
      }),
      { ttl: 30, urgency: 'high' },
    );
  });

  it('does not screen linked phones when screening is off', async () => {
    const { service } = build({ forwards: [VERIFIED_FORWARD], settings: { screenCalls: false } });
    const xml = await service.inboundTwiml(params, phoneNumber as never, 'c1');
    expect(xml).not.toContain('voice-app/screen');
    expect(xml).toContain('>+14155550199</Number>');
  });

  it('never rings the linked phone that is making the call', async () => {
    const { service } = build({
      forwards: [{ ...VERIFIED_FORWARD, e164: '+14155550100' }],
      settings: { ringDevices: false },
    });
    const xml = await service.inboundTwiml(params, phoneNumber as never, 'c1');
    expect(xml).not.toContain('<Dial');
    expect(xml).toContain('<Record');
  });

  it('keeps the Voice number as caller ID when the caller withholds theirs', async () => {
    const { service } = build({ forwards: [VERIFIED_FORWARD] });
    const xml = await service.inboundTwiml(
      { ...params, From: 'anonymous' },
      phoneNumber as never,
      'c1',
    );
    expect(xml).toContain('callerId="+18776524532"');
  });
});

describe('VoiceAppCallsService.dialComplete', () => {
  it('hangs up after a bridged call', async () => {
    const { service, push } = build();
    const xml = await service.dialComplete({ CallSid: PARENT, DialBridged: 'true' });
    expect(xml).toContain('<Hangup/>');
    expect(push.sendToUser).not.toHaveBeenCalled();
  });

  it('notifies a missed call when the caller hung up while ringing', async () => {
    const { service, push } = build();
    const xml = await service.dialComplete({
      CallSid: PARENT,
      CallStatus: 'completed',
      DialCallStatus: 'canceled',
    });
    expect(xml).toContain('<Hangup/>');
    expect(push.sendToUser).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ type: 'missed-call', tag: `call-${PARENT}` }),
      expect.anything(),
    );
  });

  it('takes a voicemail with the custom text greeting when nobody answered', async () => {
    const { service } = build({
      settings: {
        greetingMode: 'text',
        greetingText: 'Hi, leave a message.',
        voicemailTranscribe: false,
      },
    });
    const xml = await service.dialComplete({
      CallSid: PARENT,
      CallStatus: 'ringing',
      DialCallStatus: 'no-answer',
    });
    expect(xml).toContain('<Say voice="Polly.Joanna">Hi, leave a message.</Say>');
    expect(xml).toContain('maxLength="180"');
    expect(xml).toContain(
      'recordingStatusCallback="https://api.example.com/webhooks/twilio/voice-app/voicemail-recording"',
    );
    expect(xml).not.toContain('transcribe=');
  });

  it('plays a recorded greeting from its token URL', async () => {
    const { service, prisma } = build({ settings: { greetingMode: 'recorded' } });
    prisma.voicemailGreeting.findUnique.mockResolvedValue({ token: 'tok123' });
    const xml = await service.dialComplete({ CallSid: PARENT, CallStatus: 'ringing' });
    expect(xml).toContain(
      '<Play>https://api.example.com/webhooks/twilio/voice-app/greeting/tok123.wav</Play>',
    );
  });

  it('rings again when a device asked to ring here', async () => {
    const { service, redis } = build({ redisGet: '1' });
    const xml = await service.dialComplete({ CallSid: PARENT, CallStatus: 'ringing' });
    expect(xml).toContain('<Dial');
    expect(redis.client.del).toHaveBeenCalledWith(`voiceapp:redial:${PARENT}`);
  });

  it('says goodbye instead of recording when voicemail is off', async () => {
    const { service } = build({ settings: { voicemailEnabled: false } });
    const xml = await service.dialComplete({ CallSid: PARENT, CallStatus: 'ringing' });
    expect(xml).not.toContain('<Record');
    expect(xml).toContain('<Hangup/>');
  });
});

describe('VoiceAppCallsService screening and legs', () => {
  it('asks the linked phone to press 1 and hangs up without input', async () => {
    const { service } = build({ forwards: [VERIFIED_FORWARD], contactName: 'Ana' });
    const xml = await service.screenTwiml('f1', PARENT, '+14155550100');
    expect(xml).toContain('numDigits="1"');
    expect(xml).toContain('Call from Ana. Press 1 to answer, or 2 to send it to voicemail.');
    expect(xml).toMatch(/<\/Gather><Hangup\/>/);
  });

  it('reads an unknown caller digit by digit', async () => {
    const { service } = build({ forwards: [VERIFIED_FORWARD] });
    const xml = await service.screenTwiml('f1', PARENT, '+14155550100');
    expect(xml).toContain('Call from 4 1 5, 5 5 5, 0 1 0 0.');
  });

  it('connects the caller when the linked phone presses 1', async () => {
    const { service, prisma, realtime, push } = build({ forwards: [VERIFIED_FORWARD] });
    const xml = await service.screenResult('f1', PARENT, { CallSid: 'CAleg1', Digits: '1' });
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    expect(prisma.call.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          handledBy: 'phone:+14155550199',
          status: CallStatus.IN_PROGRESS,
        }),
      }),
    );
    expect(realtime.voiceAppCallAnswered).toHaveBeenCalledWith('u1', {
      callSid: PARENT,
      handledBy: 'phone:+14155550199',
      where: 'Work phone',
    });
    expect(push.sendToUser).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ type: 'call-answered', body: 'Answered on Work phone' }),
      expect.anything(),
    );
  });

  it('sends the caller to voicemail when the linked phone presses 2', async () => {
    const { service, legsUpdate } = build({ forwards: [VERIFIED_FORWARD] });
    const xml = await service.screenResult('f1', PARENT, { CallSid: 'CAleg2', Digits: '2' });
    expect(xml).toContain('<Hangup/>');
    await vi.waitFor(() =>
      expect(legsUpdate).toHaveBeenCalledWith('CAleg1', { status: 'canceled' }),
    );
    expect(legsUpdate).not.toHaveBeenCalledWith('CAleg2', expect.anything());
    expect(legsUpdate).not.toHaveBeenCalledWith('CAold', expect.anything());
  });

  it('remembers dialed legs and marks the app as the answerer', async () => {
    const { service, multi, prisma } = build();
    await service.legStatus('app', PARENT, { CallSid: 'CAleg1', CallStatus: 'initiated' });
    expect(multi.sadd).toHaveBeenCalledWith(`voiceapp:legs:${PARENT}`, 'CAleg1');
    await service.legStatus('app', PARENT, { CallSid: 'CAleg1', CallStatus: 'in-progress' });
    expect(prisma.call.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ handledBy: 'app' }) }),
    );
  });

  it('does not count a screened phone picking up as answered', async () => {
    const { service, prisma } = build({ forwards: [VERIFIED_FORWARD] });
    await service.legStatus('f1', PARENT, { CallSid: 'CAleg2', CallStatus: 'in-progress' });
    expect(prisma.call.update).not.toHaveBeenCalled();
  });

  it('keeps the device that reported itself over the generic app answer', async () => {
    const { service, prisma } = build({
      call: { handledBy: 'app:dev-123456', answeredAt: new Date() },
    });
    await service.legStatus('app', PARENT, { CallSid: 'CAleg1', CallStatus: 'in-progress' });
    expect(prisma.call.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ handledBy: 'app:dev-123456' }) }),
    );
  });
});

describe('VoiceAppCallsService ring here and decline', () => {
  it('flags a redial and cancels the ringing legs', async () => {
    const { service, redis, legsUpdate } = build();
    await expect(service.ringHere('u1', PARENT)).resolves.toEqual({ ringing: true });
    expect(redis.client.set).toHaveBeenCalledWith(`voiceapp:redial:${PARENT}`, '1', 'EX', 120);
    expect(legsUpdate).toHaveBeenCalledWith('CAleg1', { status: 'canceled' });
    expect(legsUpdate).toHaveBeenCalledWith('CAleg2', { status: 'completed' });
  });

  it('refuses once another device answered', async () => {
    const { service } = build({ call: { answeredAt: new Date() } });
    await expect(service.ringHere('u1', PARENT)).rejects.toThrow('answered on another device');
  });

  it("refuses another user's call", async () => {
    const { service } = build();
    await expect(service.decline('u2', PARENT)).rejects.toThrow('Call not found');
  });

  it('decline clears a pending redial so the caller reaches voicemail', async () => {
    const { service, redis } = build();
    await service.decline('u1', PARENT);
    expect(redis.client.del).toHaveBeenCalledWith(`voiceapp:redial:${PARENT}`);
  });

  it('decline records the decision without marking the call answered', async () => {
    const { service, prisma } = build();
    await service.decline('u1', PARENT);
    expect(prisma.call.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', answeredAt: null, endedAt: null },
      data: { handledBy: 'declined' },
    });
  });

  it('a call that was already answered cannot be marked declined', async () => {
    const { service, prisma } = build({ call: { answeredAt: new Date() } });
    await expect(service.decline('u1', PARENT)).rejects.toThrow('answered on another device');
    expect(prisma.call.updateMany).not.toHaveBeenCalled();
  });
});

describe('VoiceAppCallsService voicemail callbacks', () => {
  it('stores the voicemail and notifies once', async () => {
    // The transcript's own notification is covered below.
    const { service, prisma, push, redis } = build({
      transcriber: { enabled: true, transcribe: vi.fn().mockResolvedValue(null) },
    });
    const params = {
      CallSid: PARENT,
      RecordingSid: 'RE1',
      RecordingStatus: 'completed',
      RecordingDuration: '23',
      RecordingUrl: 'https://api.twilio.com/rec/RE1',
    };
    await service.voicemailRecording(params);
    expect(prisma.callRecording.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { twilioRecordingSid: 'RE1' },
        create: expect.objectContaining({
          source: 'voicemail',
          status: RecordingStatus.COMPLETED,
          durationSeconds: 23,
          transcriptStatus: 'in-progress',
        }),
      }),
    );
    expect(push.sendToUser).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ type: 'voicemail', body: '0:23 · Transcribing…' }),
      expect.anything(),
    );
    redis.client.set.mockResolvedValue(null);
    await service.voicemailRecording(params);
    expect(push.sendToUser).toHaveBeenCalledTimes(1);
  });

  it('transcribes the voicemail and updates the notification with the text', async () => {
    const { service, prisma, push, transcriber } = build();
    await service.voicemailRecording({
      CallSid: PARENT,
      RecordingSid: 'RE5',
      RecordingStatus: 'completed',
      RecordingDuration: '9',
    });
    await vi.waitFor(() =>
      expect(prisma.callRecording.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { twilioRecordingSid: 'RE5' },
          data: { transcript: 'Hi, call me back.', transcriptStatus: 'completed' },
        }),
      ),
    );
    expect(transcriber.transcribe).toHaveBeenCalledWith('RE5');
    await vi.waitFor(() =>
      expect(push.sendToUser).toHaveBeenLastCalledWith(
        'u1',
        expect.objectContaining({ body: 'Hi, call me back.', tag: `call-${PARENT}`, silent: true }),
        expect.anything(),
      ),
    );
  });

  it('marks the transcript failed when Deepgram fails', async () => {
    const { service, prisma } = build({
      transcriber: { enabled: true, transcribe: vi.fn().mockRejectedValue(new Error('502')) },
    });
    await service.transcribeVoicemail('RE6');
    expect(prisma.callRecording.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { transcript: null, transcriptStatus: 'failed' } }),
    );
  });

  it('skips transcription when no transcriber is configured', async () => {
    const { service, prisma, push, transcriber } = build({
      transcriber: { enabled: false, transcribe: vi.fn() },
    });
    await service.voicemailRecording({
      CallSid: PARENT,
      RecordingSid: 'RE7',
      RecordingStatus: 'completed',
      RecordingDuration: '65',
    });
    expect(prisma.callRecording.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ transcriptStatus: null }) }),
    );
    expect(push.sendToUser).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ body: '1:05' }),
      expect.anything(),
    );
    expect(transcriber.transcribe).not.toHaveBeenCalled();
  });

  it('does not notify an empty recording', async () => {
    const { service, push } = build();
    await service.voicemailRecording({
      CallSid: PARENT,
      RecordingSid: 'RE2',
      RecordingStatus: 'absent',
      RecordingDuration: '0',
    });
    expect(push.sendToUser).not.toHaveBeenCalled();
  });

  it('notifies texts from people who are not blocked', async () => {
    const { service, push, ctx } = build({ contactName: 'Ana' });
    await service.onInboundSms(
      { userId: 'u1' },
      { fromE164: '+14155550100', body: 'Hi!', numMedia: 0 },
    );
    expect(push.sendToUser).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ type: 'message', title: 'Ana', body: 'Hi!' }),
      expect.anything(),
    );
    ctx.isBlocked.mockResolvedValue(true);
    await service.onInboundSms(
      { userId: 'u1' },
      { fromE164: '+14155550100', body: 'Hi!', numMedia: 0 },
    );
    expect(push.sendToUser).toHaveBeenCalledTimes(1);
  });
});
