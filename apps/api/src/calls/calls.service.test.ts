import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CallDirection, CallStatus, RecordingStatus, UserRole } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { decodeCursor, encodeCursor } from './calls.mapper';
import { CallsService } from './calls.service';

function buildService(overrides: { prisma?: any; twilio?: any; audit?: any; realtime?: any } = {}) {
  const prisma = overrides.prisma ?? {
    phoneNumber: { findUnique: vi.fn() },
    call: { findUnique: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  };
  const twilio = overrides.twilio ?? {
    client: { calls: vi.fn(() => ({ update: vi.fn().mockResolvedValue({}) })) },
    fetchRecordingMedia: vi.fn(),
  };
  const audit = overrides.audit ?? { log: vi.fn().mockResolvedValue(undefined) };
  const realtime = overrides.realtime ?? { callStatusUpdated: vi.fn() };
  return {
    service: new CallsService(prisma, twilio, audit, realtime),
    prisma,
    twilio,
    audit,
    realtime,
  };
}

describe('CallsService.list', () => {
  it('rejects ownership when actor is not OWNER and does not own the number', async () => {
    const prisma = {
      phoneNumber: {
        findUnique: vi.fn().mockResolvedValue({ id: 'pn1', userId: 'someone-else' }),
      },
      call: { findMany: vi.fn() },
    };
    const { service } = buildService({ prisma });
    await expect(
      service.list({ userId: 'u1', role: UserRole.VIEWER }, 'pn1', { limit: 50 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns a paginated DTO with nextCursor when results fill the page', async () => {
    const phoneNumber = { id: 'pn1', userId: 'u1' };
    const baseCall = {
      id: 'c1',
      phoneNumberId: 'pn1',
      twilioCallSid: 'CA1',
      direction: CallDirection.OUTBOUND,
      fromE164: '+15552222222',
      toE164: '+15551111111',
      selectedCallerId: '+15552222222',
      destinationE164: '+15551111111',
      status: CallStatus.COMPLETED,
      durationSeconds: 30,
      startedAt: new Date('2026-05-19T00:00:00Z'),
      answeredAt: null,
      endedAt: null,
      createdAt: new Date('2026-05-19T00:00:00Z'),
    };
    const rows = Array.from({ length: 2 }, (_, i) => ({
      ...baseCall,
      id: `c${i + 1}`,
      createdAt: new Date(`2026-05-19T0${i}:00:00Z`),
    }));
    const prisma = {
      phoneNumber: { findUnique: vi.fn().mockResolvedValue(phoneNumber) },
      call: { findMany: vi.fn().mockResolvedValue(rows) },
    };
    const { service } = buildService({ prisma });

    const result = await service.list({ userId: 'u1', role: UserRole.OWNER }, 'pn1', { limit: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).not.toBeNull();
    expect(decodeCursor(result.nextCursor!)).toEqual({
      t: rows[1].createdAt.toISOString(),
      id: 'c2',
    });
  });

  it('rejects an invalid cursor string', async () => {
    const prisma = {
      phoneNumber: { findUnique: vi.fn().mockResolvedValue({ id: 'pn1', userId: 'u1' }) },
      call: { findMany: vi.fn() },
    };
    const { service } = buildService({ prisma });
    await expect(
      service.list({ userId: 'u1', role: UserRole.OWNER }, 'pn1', {
        limit: 10,
        cursor: '!!!not-base64!!!',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('CallsService.findLastDial', () => {
  it('returns the most recent outbound dial to the normalized destination', async () => {
    const createdAt = new Date('2026-06-07T18:31:57.652Z');
    const prisma = {
      phoneNumber: { findUnique: vi.fn().mockResolvedValue({ id: 'pn1', userId: 'u1' }) },
      call: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'c1',
          startedAt: null,
          createdAt,
        }),
      },
    };
    const { service } = buildService({ prisma });

    const result = await service.findLastDial(
      { userId: 'u1', role: UserRole.OWNER },
      'pn1',
      'Call now: (530) 441-9961',
    );

    expect(prisma.call.findFirst).toHaveBeenCalledWith({
      where: {
        phoneNumberId: 'pn1',
        direction: CallDirection.OUTBOUND,
        destinationE164: '+15304419961',
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    expect(result).toEqual({
      callId: 'c1',
      destinationNumber: '+15304419961',
      lastDialedAt: createdAt.toISOString(),
    });
  });

  it('returns null when the destination was not dialed before', async () => {
    const prisma = {
      phoneNumber: { findUnique: vi.fn().mockResolvedValue({ id: 'pn1', userId: 'u1' }) },
      call: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const { service } = buildService({ prisma });

    await expect(
      service.findLastDial({ userId: 'u1', role: UserRole.OWNER }, 'pn1', '+15304419961'),
    ).resolves.toBeNull();
  });

  it('rejects invalid destinations before querying calls', async () => {
    const prisma = {
      phoneNumber: { findUnique: vi.fn().mockResolvedValue({ id: 'pn1', userId: 'u1' }) },
      call: { findFirst: vi.fn() },
    };
    const { service } = buildService({ prisma });

    await expect(
      service.findLastDial({ userId: 'u1', role: UserRole.OWNER }, 'pn1', 'not a phone'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.call.findFirst).not.toHaveBeenCalled();
  });
});

describe('CallsService.listVoicemail', () => {
  it('returns voicemail recordings across provisioned numbers', async () => {
    const createdAt = new Date('2026-05-19T00:00:00Z');
    const prisma = {
      callRecording: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'rec1',
            twilioCallSid: 'CA1',
            twilioRecordingSid: 'RE1',
            source: 'voicemail',
            status: RecordingStatus.COMPLETED,
            durationSeconds: 18,
            startedAt: createdAt,
            createdAt,
            call: {
              id: 'c1',
              phoneNumberId: 'pn1',
              fromE164: '+15551111111',
              toE164: '+15552222222',
              phoneNumber: {
                id: 'pn1',
                phoneNumberE164: '+15552222222',
                friendlyName: 'Main line',
              },
            },
          },
        ]),
      },
    };
    const { service } = buildService({ prisma });

    const result = await service.listVoicemail({ limit: 25 });

    expect(prisma.callRecording.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ source: 'voicemail' }),
        take: 25,
      }),
    );
    expect(result.items).toEqual([
      expect.objectContaining({
        id: 'rec1',
        callId: 'c1',
        phoneNumberId: 'pn1',
        phoneNumberE164: '+15552222222',
        phoneNumberFriendlyName: 'Main line',
        from: '+15551111111',
        durationSeconds: 18,
      }),
    ]);
  });

  it('rejects an invalid voicemail cursor string', async () => {
    const { service } = buildService();

    await expect(service.listVoicemail({ limit: 10, cursor: 'bad' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('CallsService.hangup', () => {
  it('throws NotFound for missing call', async () => {
    const prisma = {
      phoneNumber: { findUnique: vi.fn() },
      call: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn() },
    };
    const { service } = buildService({ prisma });
    await expect(
      service.hangup({ userId: 'u1', role: UserRole.OWNER }, 'c-missing'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses to hang up a non-active call (e.g. COMPLETED)', async () => {
    const prisma = {
      phoneNumber: { findUnique: vi.fn().mockResolvedValue({ id: 'pn1', userId: 'u1' }) },
      call: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'c1',
          phoneNumberId: 'pn1',
          twilioCallSid: 'CA1',
          status: CallStatus.COMPLETED,
        }),
        update: vi.fn(),
      },
    };
    const { service } = buildService({ prisma });
    await expect(
      service.hangup({ userId: 'u1', role: UserRole.OWNER }, 'c1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('updates Twilio + DB, audits, and emits status event for an active call', async () => {
    const existing = {
      id: 'c1',
      phoneNumberId: 'pn1',
      twilioCallSid: 'CA1',
      status: CallStatus.IN_PROGRESS,
    };
    const updated = {
      ...existing,
      status: CallStatus.COMPLETED,
      direction: CallDirection.OUTBOUND,
      fromE164: '+15552222222',
      toE164: '+15551111111',
      selectedCallerId: '+15552222222',
      destinationE164: '+15551111111',
      durationSeconds: 10,
      startedAt: new Date('2026-05-19T00:00:00Z'),
      answeredAt: new Date('2026-05-19T00:00:01Z'),
      endedAt: new Date('2026-05-19T00:00:11Z'),
      createdAt: new Date('2026-05-19T00:00:00Z'),
    };
    const update = vi.fn().mockResolvedValue({});
    const prisma = {
      phoneNumber: { findUnique: vi.fn().mockResolvedValue({ id: 'pn1', userId: 'u1' }) },
      call: {
        findUnique: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockResolvedValue(updated),
      },
    };
    const twilio = { client: { calls: vi.fn(() => ({ update })) } };
    const { service, audit, realtime } = buildService({ prisma, twilio });

    const result = await service.hangup({ userId: 'u1', role: UserRole.OWNER }, 'c1');

    expect(twilio.client.calls).toHaveBeenCalledWith('CA1');
    expect(update).toHaveBeenCalledWith({ status: 'completed' });
    expect(prisma.call.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'c1' },
        data: expect.objectContaining({ status: CallStatus.COMPLETED }),
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'call.hangup', entityId: 'c1' }),
    );
    expect(realtime.callStatusUpdated).toHaveBeenCalledTimes(1);
    expect(result.id).toBe('c1');
    expect(result.status).toBe(CallStatus.COMPLETED);
  });
});

describe('CallsService.getRecordingMedia', () => {
  const baseCall = {
    id: 'c1',
    phoneNumberId: 'pn1',
    twilioCallSid: 'CA1',
    status: CallStatus.COMPLETED,
    recordings: [
      {
        id: 'rec1',
        twilioCallSid: 'CA1',
        twilioRecordingSid: 'RE1',
        status: RecordingStatus.COMPLETED,
      },
    ],
  };

  it('throws NotFound when recording does not belong to the call', async () => {
    const prisma = {
      phoneNumber: { findUnique: vi.fn().mockResolvedValue({ id: 'pn1', userId: 'u1' }) },
      call: { findUnique: vi.fn().mockResolvedValue(baseCall) },
    };
    const { service } = buildService({ prisma });

    await expect(
      service.getRecordingMedia({ userId: 'u1', role: UserRole.OWNER }, 'pn1', 'c1', 'missing'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects recordings that are not completed yet', async () => {
    const prisma = {
      phoneNumber: { findUnique: vi.fn().mockResolvedValue({ id: 'pn1', userId: 'u1' }) },
      call: {
        findUnique: vi.fn().mockResolvedValue({
          ...baseCall,
          recordings: [{ ...baseCall.recordings[0], status: RecordingStatus.IN_PROGRESS }],
        }),
      },
    };
    const { service } = buildService({ prisma });

    await expect(
      service.getRecordingMedia({ userId: 'u1', role: UserRole.OWNER }, 'pn1', 'c1', 'rec1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('fetches completed recording media through Twilio after ownership checks', async () => {
    const prisma = {
      phoneNumber: { findUnique: vi.fn().mockResolvedValue({ id: 'pn1', userId: 'u1' }) },
      call: { findUnique: vi.fn().mockResolvedValue(baseCall) },
    };
    const twilio = {
      client: { calls: vi.fn() },
      fetchRecordingMedia: vi.fn().mockResolvedValue({
        body: Buffer.from('mp3-bytes'),
        contentType: 'audio/mpeg',
      }),
    };
    const { service } = buildService({ prisma, twilio });

    const media = await service.getRecordingMedia(
      { userId: 'u1', role: UserRole.OWNER },
      'pn1',
      'c1',
      'rec1',
    );

    expect(twilio.fetchRecordingMedia).toHaveBeenCalledWith('RE1');
    expect(media.contentType).toBe('audio/mpeg');
    expect(media.filename).toBe('RE1.mp3');
    expect(media.body.toString()).toBe('mp3-bytes');
  });
});

describe('CallsService.getVoicemailMedia', () => {
  it('fetches completed voicemail media through Twilio', async () => {
    const prisma = {
      callRecording: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'rec1',
          twilioRecordingSid: 'RE1',
          twilioCallSid: 'CA1',
          source: 'voicemail',
          status: RecordingStatus.COMPLETED,
          call: {
            id: 'c1',
            phoneNumberId: 'pn1',
            fromE164: '+15551111111',
            toE164: '+15552222222',
            phoneNumber: {
              id: 'pn1',
              phoneNumberE164: '+15552222222',
              friendlyName: 'Main line',
            },
          },
        }),
      },
    };
    const twilio = {
      client: { calls: vi.fn() },
      fetchRecordingMedia: vi.fn().mockResolvedValue({
        body: Buffer.from('mp3-bytes'),
        contentType: 'audio/mpeg',
      }),
    };
    const { service } = buildService({ prisma, twilio });

    const media = await service.getVoicemailMedia('rec1');

    expect(twilio.fetchRecordingMedia).toHaveBeenCalledWith('RE1');
    expect(media.filename).toBe('RE1.mp3');
    expect(media.body.toString()).toBe('mp3-bytes');
  });

  it('does not expose normal call recordings through voicemail media', async () => {
    const prisma = {
      callRecording: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'rec1',
          source: 'DialVerb',
          status: RecordingStatus.COMPLETED,
          call: {
            id: 'c1',
            phoneNumberId: 'pn1',
            fromE164: '+15551111111',
            toE164: '+15552222222',
            phoneNumber: {
              id: 'pn1',
              phoneNumberE164: '+15552222222',
              friendlyName: 'Main line',
            },
          },
        }),
      },
    };
    const { service } = buildService({ prisma });

    await expect(service.getVoicemailMedia('rec1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('calls.mapper cursor codec', () => {
  it('round-trips encode/decode', () => {
    const ts = new Date('2026-05-19T12:34:56.789Z');
    const cursor = encodeCursor(ts, 'abc');
    expect(decodeCursor(cursor)).toEqual({ t: ts.toISOString(), id: 'abc' });
  });

  it('returns null for malformed cursor', () => {
    expect(decodeCursor('!!!not-base64!!!')).toBeNull();
  });
});
