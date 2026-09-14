import { BadGatewayException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { AiCallDirection, AiCallStatus, UserRole, type AiCall } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  decryptSecret,
  encryptSecret,
  signPayload,
  verifySignedPayload,
} from '../common/secret-box';

import { VapiSecretGuard } from './ai-calls-webhooks.controller';
import { AiCallsService, deriveOutcome } from './ai-calls.service';
import {
  ASSISTANT_VARIABLES,
  SYSTEM_PROMPT,
  TOOL_BOOK_CONSULTATION,
  TOOL_CHECK_AVAILABILITY,
  buildConsultBookerAssistant,
} from './consult-booker.assistant';
import { CalendarUnavailableError } from './google-calendar.service';
import { VapiRequestError } from './vapi.client';

// Monday 2026-09-14, 1:33 PM in Alabama (Central).
const NOW = new Date('2026-09-14T18:33:00Z');

const schedule = {
  durationMinutes: 20,
  stepMinutes: 30,
  dayStartHour: 9,
  dayEndHour: 18,
  weekdays: [1, 2, 3, 4, 5],
  minLeadMinutes: 120,
  horizonDays: 10,
  bufferMinutes: 10,
};

function settings(overrides: Record<string, unknown> = {}) {
  return {
    vapiAssistantId: 'asst_1',
    vapiPhoneNumberId: 'pn_667',
    callerNumber: '+16672206726',
    agentName: 'Sarah',
    businessName: 'Dojo Growth',
    hostName: 'Ammar',
    demoNumber: '+18776524532',
    defaultStateCode: 'AL',
    callWindow: { startHour: 8, endHour: 21 },
    schedule,
    ownerEmail: 'owner@example.com',
    missingServerSettings: () => [],
    ...overrides,
  };
}

function aiCallRow(overrides: Partial<AiCall> = {}): AiCall {
  return {
    id: 'ai1',
    userId: 'u1',
    vapiCallId: 'call_1',
    direction: AiCallDirection.OUTBOUND,
    customerE164: '+12055550100',
    stateCode: 'AL',
    timeZone: 'America/Chicago',
    status: AiCallStatus.IN_PROGRESS,
    outcome: null,
    endedReason: null,
    summary: null,
    structuredData: null,
    transcript: null,
    recordingUrl: null,
    schoolName: null,
    contactName: null,
    contactEmail: null,
    callbackTime: null,
    consultStartAt: null,
    consultEventId: null,
    consultMeetUrl: null,
    costUsd: null,
    startedAt: null,
    endedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function build(options: { settings?: Record<string, unknown>; row?: AiCall | null } = {}) {
  const row = options.row === undefined ? aiCallRow() : options.row;
  const prisma = {
    doNotCallNumber: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
    aiCall: {
      create: vi
        .fn()
        .mockImplementation(async ({ data }) =>
          aiCallRow({ ...data, vapiCallId: null, status: AiCallStatus.QUEUED }),
        ),
      update: vi
        .fn()
        .mockImplementation(async ({ data }) => ({ ...(row ?? aiCallRow()), ...data })),
      upsert: vi.fn().mockResolvedValue(row),
      findUnique: vi.fn().mockResolvedValue(row),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: 'owner1' }),
      findFirst: vi.fn().mockResolvedValue({ id: 'owner1' }),
    },
  };
  const calendar = {
    status: vi.fn().mockResolvedValue({ connected: true, email: 'host@example.com' }),
    busyIntervals: vi.fn().mockResolvedValue([]),
    createConsultEvent: vi.fn().mockResolvedValue({
      eventId: 'evt1',
      meetUrl: 'https://meet.google.com/abc-defg-hij',
      htmlLink: null,
    }),
  };
  const vapi = {
    createCall: vi.fn().mockResolvedValue({ id: 'call_new', status: 'queued' }),
    getCall: vi.fn(),
    sendControl: vi.fn().mockResolvedValue(undefined),
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const realtime = { aiCallUpdated: vi.fn() };
  const service = new AiCallsService(
    prisma as never,
    settings(options.settings) as never,
    calendar as never,
    vapi as never,
    audit as never,
    realtime as never,
  );
  return { service, prisma, calendar, vapi, audit, realtime };
}

const actor = { userId: 'u1', role: UserRole.OWNER };

describe('AiCallsService.startCall', () => {
  it('places the Vapi call from the 667 line with Alabama variables', async () => {
    const { service, vapi, prisma, realtime } = build();

    const dto = await service.startCall(
      actor,
      { destinationNumber: '(205) 555-0100', stateCode: 'AL' },
      NOW,
    );

    expect(prisma.aiCall.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'u1',
        customerE164: '+12055550100',
        stateCode: 'AL',
        timeZone: 'America/Chicago',
      }),
    });
    expect(vapi.createCall).toHaveBeenCalledWith({
      assistantId: 'asst_1',
      phoneNumberId: 'pn_667',
      customer: { number: '+12055550100' },
      assistantOverrides: {
        variableValues: {
          agentName: 'Sarah',
          businessName: 'Dojo Growth',
          hostName: 'Ammar',
          consultMinutes: '20',
          stateName: 'Alabama',
          timeZoneLabel: 'Central Time',
          prospectLocalNow: 'Monday, September 14, 2026 at 1:33 PM',
          recordingNotice: '',
          demoLine: '(877) 652-4532',
          callContext: 'outbound',
          callbackNumberKeys: '6672206726',
        },
        metadata: { aiCallId: 'ai1' },
      },
    });
    expect(dto).toMatchObject({ vapiCallId: 'call_new', status: 'QUEUED' });
    expect(realtime.aiCallUpdated).toHaveBeenCalled();
  });

  it('asks for the recording notice in all-party consent states and uses the chosen zone', async () => {
    const { service, vapi } = build();
    await service.startCall(
      actor,
      { destinationNumber: '+13055550100', stateCode: 'FL', timeZone: 'America/Chicago' },
      NOW,
    );
    const vars = vapi.createCall.mock.calls[0]![0].assistantOverrides.variableValues;
    expect(vars).toMatchObject({
      stateName: 'Florida',
      timeZoneLabel: 'Central Time',
      recordingNotice: 'Mention that the call is recorded.',
    });
  });

  it('refuses calls outside 8 AM to 9 PM prospect time', async () => {
    const { service, vapi } = build();
    // 9:40 PM Central.
    const late = new Date('2026-09-15T02:40:00Z');
    await expect(
      service.startCall(actor, { destinationNumber: '+12055550100', stateCode: 'AL' }, late),
    ).rejects.toThrow(
      "It's 9:40 PM in Alabama. The agent only calls between 8 AM and 9 PM local time.",
    );
    // 7:59 AM Central.
    await expect(
      service.startCall(
        actor,
        { destinationNumber: '+12055550100', stateCode: 'AL' },
        new Date('2026-09-14T12:59:00Z'),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(vapi.createCall).not.toHaveBeenCalled();
  });

  it('refuses do-not-call numbers, bad zones, non-US numbers, and incomplete setup', async () => {
    const dnc = build();
    dnc.prisma.doNotCallNumber.findUnique.mockResolvedValue({ e164: '+12055550100' });
    await expect(
      dnc.service.startCall(actor, { destinationNumber: '+12055550100', stateCode: 'AL' }, NOW),
    ).rejects.toThrow('asked not to be called');

    const { service } = build();
    await expect(
      service.startCall(
        actor,
        { destinationNumber: '+12055550100', stateCode: 'AL', timeZone: 'America/New_York' },
        NOW,
      ),
    ).rejects.toThrow('not a time zone used in Alabama');
    await expect(
      service.startCall(actor, { destinationNumber: '+442071234567', stateCode: 'AL' }, NOW),
    ).rejects.toThrow('only dial U.S. numbers');

    const noCalendar = build();
    noCalendar.calendar.status.mockResolvedValue({ connected: false, email: null });
    await expect(
      noCalendar.service.startCall(
        actor,
        { destinationNumber: '+12055550100', stateCode: 'AL' },
        NOW,
      ),
    ).rejects.toThrow('Connect your Google Calendar');
    expect(noCalendar.vapi.createCall).not.toHaveBeenCalled();
  });

  it('marks the call failed when Vapi rejects it', async () => {
    const { service, vapi, prisma } = build();
    vapi.createCall.mockRejectedValue(new VapiRequestError(400, 'customer.number must be valid'));
    await expect(
      service.startCall(actor, { destinationNumber: '+12055550100', stateCode: 'AL' }, NOW),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(prisma.aiCall.update).toHaveBeenCalledWith({
      where: { id: 'ai1' },
      data: expect.objectContaining({ status: 'FAILED', outcome: 'failed' }),
    });
  });
});

describe('AiCallsService tools', () => {
  it('returns open times in the prospect time zone around busy calendar time', async () => {
    const { service, calendar } = build();
    calendar.busyIntervals.mockResolvedValue([
      // Monday 4:00-5:00 PM Central is taken.
      { start: new Date('2026-09-14T21:00:00Z'), end: new Date('2026-09-14T22:00:00Z') },
    ]);

    const result = await service.checkAvailability(aiCallRow(), {}, NOW);

    expect(calendar.busyIntervals).toHaveBeenCalledWith('u1', NOW, expect.any(Date));
    expect(result.timeZone).toBe('Central Time');
    // 4:00, 4:30 and 5:00 PM overlap the busy hour plus buffer; 5:30 PM is free.
    expect(result.options).toEqual([
      { startIso: '2026-09-14T22:30:00.000Z', spoken: 'Monday, September 14 at 5:30 PM' },
      { startIso: '2026-09-15T14:00:00.000Z', spoken: 'Tuesday, September 15 at 9 AM' },
      { startIso: '2026-09-16T14:00:00.000Z', spoken: 'Wednesday, September 16 at 9 AM' },
    ]);
  });

  it('falls back to the soonest times when the requested day is full', async () => {
    const { service } = build();
    const result = await service.checkAvailability(
      aiCallRow(),
      { preferredDate: '2026-09-19', partOfDay: 'morning' },
      NOW,
    );
    expect(result.note).toContain('Nothing is open for what they asked');
    expect(result.options[0]!.spoken).toBe('Monday, September 14 at 4 PM');
  });

  it('books a free slot with a Meet invite and records it on the call', async () => {
    const { service, calendar, prisma, realtime } = build();

    const result = await service.bookConsultation(
      aiCallRow(),
      {
        startIso: '2026-09-15T14:00:00.000Z',
        contactName: 'Mike Johnson',
        schoolName: 'Tiger Karate Birmingham',
        email: ' Mike@TigerKarate.com ',
        role: 'owner',
      },
      NOW,
    );

    expect(result).toEqual({
      booked: true,
      spoken: 'Tuesday, September 15 at 9 AM Central Time',
      inviteSentTo: 'mike@tigerkarate.com',
      meetLinkIncluded: true,
    });
    expect(calendar.createConsultEvent).toHaveBeenCalledWith('u1', {
      start: new Date('2026-09-15T14:00:00.000Z'),
      end: new Date('2026-09-15T14:20:00.000Z'),
      timeZone: 'America/Chicago',
      summary: 'Tiger Karate Birmingham x Dojo Growth',
      description: expect.stringContaining('Phone: +12055550100'),
      attendeeEmail: 'mike@tigerkarate.com',
    });
    expect(prisma.aiCall.update).toHaveBeenCalledWith({
      where: { id: 'ai1' },
      data: expect.objectContaining({
        consultEventId: 'evt1',
        consultMeetUrl: 'https://meet.google.com/abc-defg-hij',
        outcome: 'booked',
      }),
    });
    expect(realtime.aiCallUpdated).toHaveBeenCalled();
  });

  it('refuses a taken slot and offers alternatives without booking', async () => {
    const { service, calendar } = build();
    calendar.busyIntervals.mockResolvedValue([
      { start: new Date('2026-09-15T14:00:00Z'), end: new Date('2026-09-15T15:00:00Z') },
    ]);
    const result = await service.bookConsultation(
      aiCallRow(),
      {
        startIso: '2026-09-15T14:00:00.000Z',
        contactName: 'Mike',
        schoolName: 'Tiger',
        email: 'm@t.com',
      },
      NOW,
    );
    expect(result).toMatchObject({ booked: false, reason: 'slot_taken' });
    expect((result as { alternatives: unknown[] }).alternatives.length).toBeGreaterThan(0);
    expect(calendar.createConsultEvent).not.toHaveBeenCalled();
  });

  it('rejects bad emails and never books twice on one call', async () => {
    const { service, calendar } = build();
    await expect(
      service.bookConsultation(
        aiCallRow(),
        {
          startIso: '2026-09-15T14:00:00.000Z',
          contactName: 'Mike',
          schoolName: 'Tiger',
          email: 'mike at tiger',
        },
        NOW,
      ),
    ).resolves.toMatchObject({ booked: false, reason: 'invalid_email' });

    const booked = aiCallRow({
      consultEventId: 'evt1',
      consultStartAt: new Date('2026-09-15T14:00:00.000Z'),
    });
    await expect(
      service.bookConsultation(
        booked,
        {
          startIso: '2026-09-16T14:00:00.000Z',
          contactName: 'Mike',
          schoolName: 'Tiger',
          email: 'm@t.com',
        },
        NOW,
      ),
    ).resolves.toMatchObject({ booked: true, alreadyBooked: true });
    expect(calendar.createConsultEvent).not.toHaveBeenCalled();
  });

  it('answers Vapi tool-call webhooks in its results format, including calendar failures', async () => {
    const { service, calendar } = build();
    calendar.busyIntervals.mockRejectedValue(
      new CalendarUnavailableError('Google Calendar is not connected.'),
    );

    const response = await service.handleWebhook({
      type: 'tool-calls',
      call: { id: 'call_1' },
      toolCallList: [
        { id: 'tc1', function: { name: TOOL_CHECK_AVAILABILITY, arguments: '{}' } },
        { id: 'tc2', name: 'mystery_tool', parameters: {} },
      ],
    });

    const results = response.results as { toolCallId: string; name: string; result: string }[];
    expect(results.map((r) => [r.toolCallId, r.name])).toEqual([
      ['tc1', TOOL_CHECK_AVAILABILITY],
      ['tc2', 'mystery_tool'],
    ]);
    expect(JSON.parse(results[0]!.result)).toMatchObject({ error: 'calendar_unavailable' });
    expect(JSON.parse(results[1]!.result)).toEqual({ error: 'unknown_tool:mystery_tool' });
  });
});

describe('AiCallsService.pressKeys', () => {
  it('tells the agent on a live call to press the keys with its dtmf tool', async () => {
    const { service, prisma, vapi, audit } = build();
    prisma.aiCall.findFirst.mockResolvedValue(aiCallRow());
    vapi.getCall.mockResolvedValue({
      id: 'call_1',
      status: 'in-progress',
      monitor: { controlUrl: 'https://phone-call-websocket.vapi.ai/call_1/control' },
    });

    await expect(service.pressKeys(actor, 'ai1', '1')).resolves.toEqual({ sent: true });

    expect(prisma.aiCall.findFirst).toHaveBeenCalledWith({ where: { id: 'ai1', userId: 'u1' } });
    expect(vapi.sendControl).toHaveBeenCalledWith(
      'https://phone-call-websocket.vapi.ai/call_1/control',
      {
        type: 'add-message',
        message: {
          role: 'system',
          content: expect.stringContaining('press the keys "1" now with the dtmf tool'),
        },
        triggerResponseEnabled: true,
      },
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ai_call.keypad', metadata: { keys: '1' } }),
    );
  });

  it('refuses ended calls, calls Vapi reports ended, and invalid keys', async () => {
    const ended = build();
    ended.prisma.aiCall.findFirst.mockResolvedValue(aiCallRow({ status: AiCallStatus.ENDED }));
    await expect(ended.service.pressKeys(actor, 'ai1', '1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(ended.vapi.getCall).not.toHaveBeenCalled();

    const vapiEnded = build();
    vapiEnded.prisma.aiCall.findFirst.mockResolvedValue(aiCallRow());
    vapiEnded.vapi.getCall.mockResolvedValue({ id: 'call_1', status: 'ended', monitor: {} });
    await expect(vapiEnded.service.pressKeys(actor, 'ai1', '1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(vapiEnded.vapi.sendControl).not.toHaveBeenCalled();

    const invalid = build();
    await expect(invalid.service.pressKeys(actor, 'ai1', '1; drop')).rejects.toThrow(
      'Keys may only contain',
    );
    expect(invalid.prisma.aiCall.findFirst).not.toHaveBeenCalled();
  });
});

describe('AiCallsService webhooks', () => {
  it('answers a callback to the 667 line with the earlier call context', async () => {
    const { service, prisma } = build();
    prisma.aiCall.findFirst.mockResolvedValue(
      aiCallRow({ stateCode: 'TN', timeZone: 'America/New_York', schoolName: 'Knox BJJ' }),
    );

    const response = await service.handleWebhook({
      type: 'assistant-request',
      call: { id: 'call_in', customer: { number: '+18655550100' } },
    });

    expect(response).toMatchObject({
      assistantId: 'asst_1',
      assistantOverrides: {
        variableValues: {
          callContext: 'callback',
          stateName: 'Tennessee',
          timeZoneLabel: 'Eastern Time',
        },
      },
    });
    expect(prisma.aiCall.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { vapiCallId: 'call_in' },
        create: expect.objectContaining({
          direction: 'INBOUND',
          customerE164: '+18655550100',
          stateCode: 'TN',
          userId: 'u1',
          schoolName: 'Knox BJJ',
        }),
      }),
    );
  });

  it('declines callbacks until the business and host names are configured', async () => {
    const { service, prisma } = build({ settings: { businessName: undefined } });
    await expect(
      service.handleWebhook({
        type: 'assistant-request',
        call: { id: 'call_in', customer: { number: '+18655550100' } },
      }),
    ).resolves.toEqual({
      error: "Sorry, we can't take your call right now. Please try again later.",
    });
    expect(prisma.aiCall.upsert).not.toHaveBeenCalled();
  });

  it('stores the end-of-call report and honors do-not-call requests', async () => {
    const { service, prisma } = build();

    await service.handleWebhook({
      type: 'end-of-call-report',
      endedReason: 'customer-ended-call',
      startedAt: '2026-09-14T18:40:00Z',
      endedAt: '2026-09-14T18:42:10Z',
      cost: 0.21,
      call: { id: 'call_1' },
      analysis: {
        summary: 'Owner asked not to be called.',
        structuredData: { doNotCall: true, schoolName: 'Tiger Karate', contactRole: 'owner' },
      },
      artifact: { transcript: 'AI: Hi...', recordingUrl: 'https://storage.vapi.ai/rec.wav' },
    });

    expect(prisma.aiCall.update).toHaveBeenCalledWith({
      where: { id: 'ai1' },
      data: expect.objectContaining({
        status: 'ENDED',
        outcome: 'do_not_call',
        summary: 'Owner asked not to be called.',
        recordingUrl: 'https://storage.vapi.ai/rec.wav',
        schoolName: 'Tiger Karate',
      }),
    });
    expect(prisma.doNotCallNumber.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { e164: '+12055550100' } }),
    );
  });

  it('matches early webhooks by the metadata id before the Vapi id is saved', async () => {
    const { service, prisma } = build({ row: null });
    prisma.aiCall.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(aiCallRow({ vapiCallId: null }));

    await service.handleWebhook({
      type: 'status-update',
      status: 'ringing',
      call: { id: 'call_new', assistantOverrides: { metadata: { aiCallId: 'ai1' } } },
    });

    expect(prisma.aiCall.update).toHaveBeenCalledWith({
      where: { id: 'ai1' },
      data: { vapiCallId: 'call_new' },
    });
  });

  it('derives outcomes from the call result', () => {
    const none = { consultEventId: null, outcome: null };
    expect(deriveOutcome({ consultEventId: 'evt', outcome: null }, {}, 'customer-ended-call')).toBe(
      'booked',
    );
    expect(deriveOutcome(none, {}, 'voicemail', '2026-09-14T18:00:00Z')).toBe('voicemail');
    expect(deriveOutcome(none, {}, 'customer-did-not-answer')).toBe('no_answer');
    expect(deriveOutcome(none, {}, 'call.start.error-get-transport')).toBe('failed');
    expect(deriveOutcome(none, { callbackRequested: true }, 'assistant-ended-call', 'x')).toBe(
      'callback',
    );
    expect(
      deriveOutcome(none, { interestLevel: 'not_interested' }, 'customer-ended-call', 'x'),
    ).toBe('not_interested');
    expect(
      deriveOutcome(
        none,
        { reachedDecisionMaker: false, contactRole: 'front_desk' },
        'assistant-ended-call',
        'x',
      ),
    ).toBe('gatekeeper');
  });
});

describe('VapiSecretGuard', () => {
  const context = (headers: Record<string, string>) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ headers }) }) }) as never;

  it('accepts only the configured secret', () => {
    const guard = new VapiSecretGuard({ vapiWebhookSecret: 's3cret' } as never);
    expect(guard.canActivate(context({ 'x-vapi-secret': 's3cret' }))).toBe(true);
    expect(() => guard.canActivate(context({ 'x-vapi-secret': 'nope' }))).toThrow(
      UnauthorizedException,
    );
    expect(() => guard.canActivate(context({}))).toThrow(UnauthorizedException);
    const unset = new VapiSecretGuard({ vapiWebhookSecret: undefined } as never);
    expect(() => unset.canActivate(context({ 'x-vapi-secret': '' }))).toThrow(
      UnauthorizedException,
    );
  });
});

describe('secret box', () => {
  const key = Buffer.alloc(32, 7).toString('base64');

  it('round-trips encrypted secrets and rejects tampering', () => {
    const sealed = encryptSecret('1//refresh-token', key);
    expect(sealed).not.toContain('refresh-token');
    expect(decryptSecret(sealed, key)).toBe('1//refresh-token');
    const [v, iv, tag, data] = sealed.split('.');
    const tampered = [v, iv, tag, `${data!.slice(0, -2)}AA`].join('.');
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it('signs OAuth state and rejects altered payloads', () => {
    const token = signPayload({ u: 'u1', exp: 1 }, 'secret');
    expect(verifySignedPayload(token, 'secret')).toEqual({ u: 'u1', exp: 1 });
    expect(verifySignedPayload(token, 'other')).toBeNull();
    const [, mac] = token.split('.');
    const forged = `${Buffer.from(JSON.stringify({ u: 'admin', exp: 1 })).toString('base64url')}.${mac}`;
    expect(verifySignedPayload(forged, 'secret')).toBeNull();
  });
});

describe('consult booker assistant', () => {
  it('declares every prompt variable the API sends and nothing more', () => {
    const used = new Set(
      [...SYSTEM_PROMPT.matchAll(/\{\{\s*([a-zA-Z]+)\s*\}\}/g)].map((m) => m[1]),
    );
    used.delete('customer'); // {{customer.number}} is supplied by Vapi.
    expect([...used].sort()).toEqual([...ASSISTANT_VARIABLES].sort());

    const { service } = build();
    const vars = service.variableValues(
      {
        code: 'AL',
        name: 'Alabama',
        timeZones: ['America/Chicago'],
        allPartyRecordingConsent: false,
      },
      'America/Chicago',
      'outbound',
      NOW,
    );
    expect(Object.keys(vars).sort()).toEqual([...ASSISTANT_VARIABLES].sort());
  });

  it('points both booking tools and call events at the secured webhook', () => {
    const assistant = buildConsultBookerAssistant({
      webhookUrl: 'https://api.example.com/webhooks/vapi',
      webhookSecret: 'shh',
    });
    const server = {
      url: 'https://api.example.com/webhooks/vapi',
      headers: { 'x-vapi-secret': 'shh' },
      timeoutSeconds: 20,
    };
    const functions = assistant.model.tools.filter((t) => t.type === 'function');
    expect(functions.map((t) => (t as { function: { name: string } }).function.name)).toEqual([
      TOOL_CHECK_AVAILABILITY,
      TOOL_BOOK_CONSULTATION,
    ]);
    for (const tool of functions) expect((tool as { server: unknown }).server).toEqual(server);
    expect(assistant.server).toEqual(server);
    expect(assistant.firstMessageMode).toBe('assistant-waits-for-user');
    // Phone menus: the agent can press keys, and voicemail is judged by the
    // model so menus offering an operator aren't hung up on.
    expect(assistant.model.tools.some((t) => t.type === 'dtmf')).toBe(true);
    expect(assistant.voicemailDetection).toBe('off');
    expect(assistant.endCallMessage).toBeNull();
    expect(assistant.voicemailMessage).toBeNull();
    expect(assistant.silenceTimeoutSeconds).toBeGreaterThanOrEqual(60);
    expect(assistant.endCallPhrases).toEqual(['have a great day', "we won't call again"]);
    // Every scripted goodbye ends with a phrase that hangs up.
    for (const goodbye of [
      "Thanks, I'll try back then. Have a great day.",
      "Understood, we won't call again. Sorry to bother you.",
      'No problem, thanks for your time. Have a great day.',
    ]) {
      expect(SYSTEM_PROMPT).toContain(goodbye);
      expect(
        assistant.endCallPhrases.some((phrase) => goodbye.toLowerCase().includes(phrase)),
      ).toBe(true);
    }
    expect(SYSTEM_PROMPT).toContain('your whole reply is "{{agentName}}."');
    expect(SYSTEM_PROMPT).toContain('WW{{callbackNumberKeys}}#WW');
    expect(assistant.serverMessages).toEqual(['status-update', 'end-of-call-report']);
  });
});
