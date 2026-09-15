import { BadGatewayException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { AiCallDirection, AiCallStatus, UserRole, type AiCall } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// In-memory ai_calls table covering the queries the queue uses.
function aiCallStore(initial: AiCall[] = []) {
  const rows = new Map(initial.map((r) => [r.id, { ...r }]));
  let seq = 0;
  const matches = (r: AiCall, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([key, cond]) => {
      const value = (r as Record<string, unknown>)[key];
      if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
        const c = cond as Record<string, unknown>;
        if ('in' in c) return (c.in as unknown[]).includes(value);
        if ('not' in c) return value !== c.not;
        if ('lt' in c) return (value as Date) < (c.lt as Date);
        if ('startsWith' in c) return String(value).startsWith(String(c.startsWith));
      }
      return value === cond;
    });
  const sorted = () =>
    [...rows.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return {
    rows,
    create: vi.fn(async ({ data }: { data: Partial<AiCall> }) => {
      seq += 1;
      const row = aiCallRow({
        id: `ai${seq}`,
        vapiCallId: null,
        status: AiCallStatus.QUEUED,
        createdAt: new Date(NOW.getTime() + seq),
        ...data,
      });
      rows.set(row.id, row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<AiCall> }) => {
      const next = { ...rows.get(where.id)!, ...data };
      rows.set(where.id, next);
      return next;
    }),
    updateMany: vi.fn(
      async ({ where, data }: { where: Record<string, unknown>; data: Partial<AiCall> }) => {
        let count = 0;
        for (const r of sorted()) {
          if (!matches(r, where)) continue;
          rows.set(r.id, { ...r, ...data });
          count += 1;
        }
        return { count };
      },
    ),
    deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      let count = 0;
      for (const r of sorted()) if (matches(r, where) && rows.delete(r.id)) count += 1;
      return { count };
    }),
    findUnique: vi.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        sorted().find((r) => matches(r, where)) ?? null,
    ),
    findFirst: vi.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        sorted().find((r) => matches(r, where)) ?? null,
    ),
    findMany: vi.fn(
      async ({
        where,
        orderBy,
        distinct,
      }: { where?: Record<string, unknown>; orderBy?: unknown; distinct?: string[] } = {}) => {
        let list = sorted().filter((r) => matches(r, where));
        if (JSON.stringify(orderBy)?.includes('desc')) list = list.reverse();
        if (distinct?.includes('userId')) {
          const seen = new Set();
          list = list.filter((r) => !seen.has(r.userId) && seen.add(r.userId));
        }
        return list;
      },
    ),
    count: vi.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        sorted().filter((r) => matches(r, where)).length,
    ),
    upsert: vi.fn(),
  };
}

function buildWithStore(initial: AiCall[] = [], settingsOverrides: Record<string, unknown> = {}) {
  const built = build({ settings: settingsOverrides });
  const store = aiCallStore(initial);
  Object.assign(built.prisma.aiCall, store);
  let n = 0;
  built.vapi.createCall.mockImplementation(async () => ({ id: `call_${++n}`, status: 'queued' }));
  return { ...built, store };
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
    downloadRecording: vi.fn(),
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
    const { service, vapi, prisma, realtime } = buildWithStore();

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
    expect(dto).toMatchObject({ vapiCallId: 'call_1', status: 'QUEUED' });
    expect(realtime.aiCallUpdated).toHaveBeenCalled();
  });

  it('asks for the recording notice in all-party consent states and uses the chosen zone', async () => {
    const { service, vapi } = buildWithStore();
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
    const { service, vapi, store } = buildWithStore();
    vapi.createCall.mockRejectedValue(new VapiRequestError(400, 'customer.number must be valid'));
    await expect(
      service.startCall(actor, { destinationNumber: '+12055550100', stateCode: 'AL' }, NOW),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(store.rows.get('ai1')).toMatchObject({ status: 'FAILED', outcome: 'failed' });
  });
});

describe('AiCallsService queue', () => {
  // Webhook-triggered queue steps read the clock; pin it inside the calling window.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const live = (overrides: Partial<AiCall> = {}) =>
    aiCallRow({
      id: 'live1',
      vapiCallId: 'call_live',
      customerE164: '+12055550999',
      status: AiCallStatus.IN_PROGRESS,
      createdAt: new Date(NOW.getTime() - 60_000),
      updatedAt: NOW,
      ...overrides,
    });

  it('queues schools while the agent is on a call instead of calling them', async () => {
    const { service, vapi, store } = buildWithStore([live()]);

    const first = await service.startCall(
      actor,
      { destinationNumber: '+12055550101', stateCode: 'AL' },
      NOW,
    );
    const second = await service.startCall(
      actor,
      { destinationNumber: '+12055550102', stateCode: 'AL' },
      NOW,
    );

    expect(first.status).toBe('WAITING');
    expect(second.status).toBe('WAITING');
    expect(vapi.createCall).not.toHaveBeenCalled();
    expect((await service.queue('u1')).map((c) => c.customerNumber)).toEqual([
      '+12055550101',
      '+12055550102',
    ]);
    expect((await service.list('u1')).map((c) => c.id)).toEqual(['live1']);
    expect(store.rows.size).toBe(3);
  });

  it('calls the next school in order when the current call ends, one at a time', async () => {
    const { service, vapi, store } = buildWithStore([live()]);
    await service.startCall(actor, { destinationNumber: '+12055550101', stateCode: 'AL' }, NOW);
    await service.startCall(actor, { destinationNumber: '+12055550102', stateCode: 'AL' }, NOW);

    await service.handleWebhook({
      type: 'status-update',
      status: 'ended',
      call: { id: 'call_live' },
    });
    await vi.waitFor(() => expect(vapi.createCall).toHaveBeenCalledTimes(1));

    expect(vapi.createCall.mock.calls[0]![0].customer).toEqual({ number: '+12055550101' });
    // The end-of-call report for the same call must not start a second call.
    await service.handleWebhook({
      type: 'end-of-call-report',
      endedReason: 'customer-ended-call',
      call: { id: 'call_live' },
    });
    await service.processQueue('u1', NOW);
    expect(vapi.createCall).toHaveBeenCalledTimes(1);
    expect([...store.rows.values()].filter((r) => r.status === 'WAITING')).toHaveLength(1);
  });

  it('refuses duplicates and a full queue of 100', async () => {
    const waiting = Array.from({ length: 100 }, (_, i) =>
      aiCallRow({
        id: `w${i}`,
        vapiCallId: null,
        customerE164: `+1205555${String(i).padStart(4, '0')}`,
        status: AiCallStatus.WAITING,
        createdAt: new Date(NOW.getTime() - 1000 + i),
      }),
    );
    const { service, vapi } = buildWithStore([live(), ...waiting]);

    await expect(
      service.startCall(actor, { destinationNumber: '+12055550005', stateCode: 'AL' }, NOW),
    ).rejects.toThrow('already in the queue');
    await expect(
      service.startCall(actor, { destinationNumber: '+12055550999', stateCode: 'AL' }, NOW),
    ).rejects.toThrow('already calling this number');
    await expect(
      service.startCall(actor, { destinationNumber: '+13345550100', stateCode: 'AL' }, NOW),
    ).rejects.toThrow('The queue is full (100 schools)');
    expect(vapi.createCall).not.toHaveBeenCalled();
  });

  it('lets a school outside its calling window wait while later ones are called', async () => {
    const { service, vapi, store } = buildWithStore([
      // Queued first, but Hawaii is still before 8 AM.
      aiCallRow({
        id: 'late',
        vapiCallId: null,
        status: AiCallStatus.WAITING,
        timeZone: 'Pacific/Honolulu',
        stateCode: 'HI',
        customerE164: '+18085550100',
        createdAt: new Date(NOW.getTime() - 2000),
      }),
      aiCallRow({
        id: 'ok',
        vapiCallId: null,
        status: AiCallStatus.WAITING,
        customerE164: '+12055550100',
        createdAt: new Date(NOW.getTime() - 1000),
      }),
    ]);
    // 8:30 AM in Alabama, 3:30 AM in Hawaii.
    const morning = new Date('2026-09-14T13:30:00Z');

    await service.processQueue('u1', morning);

    expect(vapi.createCall).toHaveBeenCalledTimes(1);
    expect(vapi.createCall.mock.calls[0]![0].customer).toEqual({ number: '+12055550100' });
    expect(store.rows.get('late')!.status).toBe('WAITING');
  });

  it('skips a waiting school that asked not to be called and moves on', async () => {
    const { service, vapi, store, prisma } = buildWithStore([
      aiCallRow({
        id: 'dnc',
        vapiCallId: null,
        status: AiCallStatus.WAITING,
        customerE164: '+12055550100',
        createdAt: new Date(NOW.getTime() - 2000),
      }),
      aiCallRow({
        id: 'next',
        vapiCallId: null,
        status: AiCallStatus.WAITING,
        customerE164: '+12055550101',
        createdAt: new Date(NOW.getTime() - 1000),
      }),
    ]);
    prisma.doNotCallNumber.findUnique.mockImplementation(
      async ({ where }: { where: { e164: string } }) =>
        where.e164 === '+12055550100' ? { e164: where.e164 } : null,
    );

    await service.processQueue('u1', NOW);

    expect(store.rows.get('dnc')).toMatchObject({ status: 'ENDED', outcome: 'do_not_call' });
    expect(vapi.createCall).toHaveBeenCalledTimes(1);
    expect(vapi.createCall.mock.calls[0]![0].customer).toEqual({ number: '+12055550101' });
  });

  it('holds the queue while setup is incomplete', async () => {
    const { service, vapi, store } = buildWithStore(
      [aiCallRow({ id: 'w', vapiCallId: null, status: AiCallStatus.WAITING })],
      { missingServerSettings: () => ['Set AI_HOST_NAME.'] },
    );
    await service.processQueue('u1', NOW);
    expect(vapi.createCall).not.toHaveBeenCalled();
    expect(store.rows.get('w')!.status).toBe('WAITING');
  });

  it('removes one waiting school or clears the whole queue, never a started call', async () => {
    const { service, store } = buildWithStore([
      live(),
      aiCallRow({
        id: 'a',
        vapiCallId: null,
        status: AiCallStatus.WAITING,
        customerE164: '+12055550101',
      }),
      aiCallRow({
        id: 'b',
        vapiCallId: null,
        status: AiCallStatus.WAITING,
        customerE164: '+12055550102',
      }),
      aiCallRow({
        id: 'c',
        vapiCallId: null,
        status: AiCallStatus.WAITING,
        customerE164: '+12055550103',
      }),
    ]);

    await service.removeFromQueue('u1', 'a');
    await expect(service.removeFromQueue('u1', 'live1')).rejects.toThrow('no longer waiting');
    await expect(service.clearQueue('u1')).resolves.toEqual({ removed: 2 });
    expect([...store.rows.keys()]).toEqual(['live1']);
  });

  it('recovers a call whose end webhook was missed, then advances the queue', async () => {
    const { service, vapi, store } = buildWithStore([
      live({ updatedAt: new Date(NOW.getTime() - 13 * 60_000) }),
      aiCallRow({
        id: 'w',
        vapiCallId: null,
        status: AiCallStatus.WAITING,
        customerE164: '+12055550101',
      }),
    ]);
    vapi.getCall.mockResolvedValue({
      id: 'call_live',
      status: 'ended',
      endedReason: 'customer-ended-call',
    });

    await service.sweepQueues(NOW);
    await vi.waitFor(() => expect(vapi.createCall).toHaveBeenCalledTimes(1));

    expect(store.rows.get('live1')!.status).toBe('ENDED');
    expect(store.rows.get('w')!.status).toBe('QUEUED');
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

  it('keeps the prompt cacheable and the turn-taking fast', () => {
    const assistant = buildConsultBookerAssistant({ webhookUrl: 'https://x', webhookSecret: 'x' });
    // Per-call details come last so every call shares one cached prompt prefix.
    const perCall = [
      '{{callContext}}',
      '{{prospectLocalNow}}',
      '{{customer.number}}',
      '{{recordingNotice}}',
    ];
    const detailsStart = SYSTEM_PROMPT.indexOf('# This call');
    expect(detailsStart).toBeGreaterThan(SYSTEM_PROMPT.indexOf('# Critical rules'));
    for (const variable of perCall) {
      expect(SYSTEM_PROMPT.indexOf(variable)).toBeGreaterThan(detailsStart);
    }
    expect(assistant.model.promptCacheKey).toBe('matboss-consult-booker');
    expect(assistant.model.promptCacheRetention).toBe('24h');
    expect(assistant.startSpeakingPlan.waitSeconds).toBeLessThanOrEqual(0.2);
    expect(assistant.startSpeakingPlan.smartEndpointingPlan.waitFunction).not.toContain('t <');
    expect(assistant.voice.optimizeStreamingLatency).toBe(4);
    expect(assistant.voice.chunkPlan.minCharacters).toBeLessThan(30);
  });

  it('opens with who is calling and reveals the AI as the hook by the second reply', () => {
    expect(SYSTEM_PROMPT).toContain(
      '"Hey Mike, it\'s {{agentName}} with {{businessName}}. Quick one, are you the owner over there?"',
    );
    expect(SYSTEM_PROMPT).toContain(
      "I'll be straight with you, I'm an AI, and that's kind of the point.",
    );
    expect(SYSTEM_PROMPT).toContain('no later than your second reply');
    expect(SYSTEM_PROMPT).toContain('Never pretend to be human.');
  });
});

describe('AiCallsService.recording', () => {
  it('serves a Vapi WAV recording as an MP3 download', async () => {
    const { service, prisma, vapi } = build();
    prisma.aiCall.findFirst.mockResolvedValue(
      aiCallRow({
        recordingUrl: 'https://r2.example/private.wav',
        startedAt: new Date('2026-09-14T18:40:00Z'),
      }),
    );
    const pcm = Buffer.alloc(44 + 16000 * 2);
    pcm.write('RIFF', 0, 'ascii');
    pcm.writeUInt32LE(36 + 32000, 4);
    pcm.write('WAVEfmt ', 8, 'ascii');
    pcm.writeUInt32LE(16, 16);
    pcm.writeUInt16LE(1, 20);
    pcm.writeUInt16LE(1, 22);
    pcm.writeUInt32LE(16000, 24);
    pcm.writeUInt32LE(32000, 28);
    pcm.writeUInt16LE(2, 32);
    pcm.writeUInt16LE(16, 34);
    pcm.write('data', 36, 'ascii');
    pcm.writeUInt32LE(32000, 40);
    vapi.downloadRecording.mockResolvedValue({ body: pcm, contentType: 'audio/wav' });

    const media = await service.recording('u1', 'ai1');

    expect(vapi.downloadRecording).toHaveBeenCalledWith('call_1');
    expect(media.contentType).toBe('audio/mpeg');
    expect(media.body[0]).toBe(0xff);
    expect(media.filename).toBe('ai-call-12055550100-2026-09-14_13-40.mp3');
  });

  it('passes native MP3 recordings through and 404s calls without one', async () => {
    const { service, prisma, vapi } = build();
    const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]);
    vapi.downloadRecording.mockResolvedValue({ body: mp3, contentType: 'audio/mpeg' });
    prisma.aiCall.findFirst.mockResolvedValueOnce(
      aiCallRow({ recordingUrl: 'https://r2.example/x.mp3' }),
    );
    await expect(service.recording('u1', 'ai1')).resolves.toMatchObject({ body: mp3 });

    prisma.aiCall.findFirst.mockResolvedValueOnce(aiCallRow({ recordingUrl: null }));
    await expect(service.recording('u1', 'ai1')).rejects.toThrow('No recording for this call.');
  });
});
