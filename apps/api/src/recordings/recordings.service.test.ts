import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CallStatus, RecordingStatus, UserRole } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { RecordingsService } from './recordings.service';

const CALL_SID = 'CA0123456789abcdef0123456789abcdef';
const UPLOAD_ID = '6f1c2a8e-4b7d-4c3e-9a51-2f0d8b7e6c4a';
const OWNER = { userId: 'u1', role: UserRole.OWNER };
const CALL = {
  id: 'c1',
  phoneNumberId: 'pn1',
  twilioCallSid: CALL_SID,
  status: CallStatus.IN_PROGRESS,
  direction: 'OUTBOUND',
  fromE164: '+15550000001',
  toE164: '+15550000002',
  createdAt: new Date('2026-10-07T12:00:00Z'),
};

function recordingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: UPLOAD_ID,
    callId: 'c1',
    twilioCallSid: CALL_SID,
    twilioRecordingSid: null,
    recordingUrl: null,
    status: RecordingStatus.COMPLETED,
    durationSeconds: 42,
    channels: 2,
    source: 'browser',
    track: 'both',
    contentType: 'audio/webm',
    storedAt: new Date('2026-10-07T12:01:00Z'),
    startedAt: new Date('2026-10-07T12:00:00Z'),
    createdAt: new Date('2026-10-07T12:01:00Z'),
    ...overrides,
  };
}

function build(opts: { storageEnabled?: boolean } = {}) {
  const prisma = {
    call: {
      findUnique: vi
        .fn()
        .mockImplementation(({ where }: { where: Record<string, string> }) =>
          where.twilioCallSid === CALL_SID || where.id === 'c1'
            ? { ...CALL, recordings: [recordingRow()] }
            : null,
        ),
    },
    phoneNumber: { findUnique: vi.fn().mockResolvedValue({ id: 'pn1', userId: 'u1' }) },
    callRecording: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(({ data }) => recordingRow(data)),
    },
  };
  const legFetch = vi.fn().mockResolvedValue({ parentCallSid: CALL_SID });
  const twilio = {
    startCallRecording: vi.fn().mockResolvedValue('RE9'),
    client: { calls: vi.fn(() => ({ fetch: legFetch })) },
  };
  const realtime = { callStatusUpdated: vi.fn() };
  const storage = {
    enabled: opts.storageEnabled ?? true,
    keyFor: vi.fn().mockReturnValue(`recordings/2026/10/${CALL_SID}/${UPLOAD_ID}.webm`),
    put: vi.fn().mockResolvedValue(undefined),
  };
  const service = new RecordingsService(
    prisma as never,
    twilio as never,
    realtime as never,
    storage as never,
  );
  return { service, prisma, twilio, realtime, storage, legFetch };
}

const INPUT = {
  uploadId: UPLOAD_ID,
  callSid: CALL_SID,
  startedAt: '2026-10-07T12:00:00.000Z',
  durationSeconds: 120,
};

describe('RecordingsService.saveBrowserRecording', () => {
  it('stores the file, lists it with the call, and tells open pages', async () => {
    const { service, prisma, storage, realtime } = build();

    const dto = await service.saveBrowserRecording(OWNER, INPUT, Buffer.from('webm'), 'audio/webm');

    expect(storage.put).toHaveBeenCalledWith(
      `recordings/2026/10/${CALL_SID}/${UPLOAD_ID}.webm`,
      Buffer.from('webm'),
      'audio/webm',
    );
    expect(prisma.callRecording.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: UPLOAD_ID,
        callId: 'c1',
        twilioCallSid: CALL_SID,
        status: RecordingStatus.COMPLETED,
        source: 'browser',
        channels: 2,
        durationSeconds: 120,
        sizeBytes: 4,
      }),
    });
    expect(realtime.callStatusUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ numberId: 'pn1' }),
    );
    expect(dto).toMatchObject({ id: UPLOAD_ID, source: 'browser', twilioRecordingSid: null });
  });

  it('refuses browser recordings shorter than 90 seconds', async () => {
    const { service, storage, prisma } = build();

    await expect(
      service.saveBrowserRecording(
        OWNER,
        { ...INPUT, durationSeconds: 89 },
        Buffer.from('webm'),
        'audio/webm',
      ),
    ).rejects.toThrow('under 90 seconds');
    expect(storage.put).not.toHaveBeenCalled();
    expect(prisma.callRecording.create).not.toHaveBeenCalled();

    await service.saveBrowserRecording(
      OWNER,
      { ...INPUT, durationSeconds: 90 },
      Buffer.from('webm'),
      'audio/webm',
    );
    expect(storage.put).toHaveBeenCalledTimes(1);
  });

  it('returns the earlier result when the browser retries an upload that landed', async () => {
    const { service, prisma, storage } = build();
    prisma.callRecording.findUnique.mockResolvedValue(recordingRow());

    const dto = await service.saveBrowserRecording(OWNER, INPUT, Buffer.from('webm'), 'audio/webm');

    expect(storage.put).not.toHaveBeenCalled();
    expect(prisma.callRecording.create).not.toHaveBeenCalled();
    expect(dto.id).toBe(UPLOAD_ID);
  });

  it('refuses an upload id that belongs to another call', async () => {
    const { service, prisma } = build();
    prisma.callRecording.findUnique.mockResolvedValue(recordingRow({ callId: 'other-call' }));

    await expect(
      service.saveBrowserRecording(OWNER, INPUT, Buffer.from('webm'), 'audio/webm'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('files a recording from the leg that answered an incoming call under the inbound call', async () => {
    const { service, prisma, twilio } = build();
    const LEG_SID = 'CA' + 'e'.repeat(32);

    await service.saveBrowserRecording(
      OWNER,
      { ...INPUT, callSid: LEG_SID },
      Buffer.from('webm'),
      'audio/webm',
    );

    expect(twilio.client.calls).toHaveBeenCalledWith(LEG_SID);
    expect(prisma.callRecording.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ callId: 'c1', twilioCallSid: CALL_SID }),
    });
  });

  it('asks the browser to keep the file while storage is not configured', async () => {
    const { service } = build({ storageEnabled: false });

    await expect(
      service.saveBrowserRecording(OWNER, INPUT, Buffer.from('webm'), 'audio/webm'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('refuses a call on a number the user does not own', async () => {
    const { service, prisma, storage } = build();
    prisma.phoneNumber.findUnique.mockResolvedValue({ id: 'pn1', userId: 'someone-else' });

    await expect(
      service.saveBrowserRecording(
        { userId: 'u1', role: UserRole.VIEWER },
        INPUT,
        Buffer.from('webm'),
        'audio/webm',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(storage.put).not.toHaveBeenCalled();
  });
});

describe('RecordingsService.startTwilioBackup', () => {
  it('starts a dual-channel Twilio recording of the live call', async () => {
    const { service, twilio } = build();

    await expect(service.startTwilioBackup(OWNER, CALL_SID)).resolves.toEqual({
      recordingSid: 'RE9',
      alreadyRecording: false,
    });
    expect(twilio.startCallRecording).toHaveBeenCalledWith(CALL_SID);
  });

  it('does not start a second recording when Twilio is already recording', async () => {
    const { service, prisma, twilio } = build();
    prisma.callRecording.findFirst.mockResolvedValue({ twilioRecordingSid: 'RE1' });

    await expect(service.startTwilioBackup(OWNER, CALL_SID)).resolves.toEqual({
      recordingSid: 'RE1',
      alreadyRecording: true,
    });
    expect(twilio.startCallRecording).not.toHaveBeenCalled();
  });

  it('refuses a call that has ended', async () => {
    const { service, prisma } = build();
    prisma.call.findUnique.mockResolvedValue({ ...CALL, status: CallStatus.COMPLETED });

    await expect(service.startTwilioBackup(OWNER, CALL_SID)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
