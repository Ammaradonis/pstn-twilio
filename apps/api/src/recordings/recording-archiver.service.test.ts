import { Readable } from 'stream';

import { RecordingStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { TwilioRecordingMediaError } from '../twilio/twilio.service';

import { MAX_ARCHIVE_ATTEMPTS, RecordingArchiverService } from './recording-archiver.service';

const RECORDING = {
  id: 'rec1',
  twilioCallSid: 'CA1',
  twilioRecordingSid: 'RE1',
  status: RecordingStatus.COMPLETED,
  createdAt: new Date('2026-10-07T12:00:00Z'),
  storedAt: null,
  twilioDeletedAt: null,
  archiveAttempts: 0,
} as never;

function build(opts: { env?: Record<string, string>; twilio?: any; storage?: any } = {}) {
  const prisma = {
    callRecording: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const twilio = opts.twilio ?? {
    fetchRecordingMedia: vi.fn().mockResolvedValue({
      stream: Readable.from(Buffer.from('mp3-bytes')),
      contentType: 'audio/mpeg',
    }),
    deleteRecording: vi.fn().mockResolvedValue(true),
  };
  const storage = opts.storage ?? {
    enabled: true,
    keyFor: vi.fn().mockReturnValue('recordings/2026/10/CA1/RE1.mp3'),
    put: vi.fn().mockResolvedValue(undefined),
  };
  const redis = {
    client: { set: vi.fn().mockResolvedValue('OK'), del: vi.fn().mockResolvedValue(1) },
  };
  const env = opts.env ?? {};
  const config = { get: (name: string) => env[name] };
  const archiver = new RecordingArchiverService(
    config as never,
    prisma as never,
    twilio as never,
    redis as never,
    storage as never,
  );
  return { archiver, prisma, twilio, storage, redis };
}

describe('RecordingArchiverService.archive', () => {
  it('copies the recording to storage, records it, then deletes it from Twilio', async () => {
    const { archiver, prisma, twilio, storage } = build();

    await archiver.archive(RECORDING);

    expect(storage.put).toHaveBeenCalledWith(
      'recordings/2026/10/CA1/RE1.mp3',
      Buffer.from('mp3-bytes'),
      'audio/mpeg',
    );
    expect(prisma.callRecording.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'rec1' },
      data: expect.objectContaining({
        storageKey: 'recordings/2026/10/CA1/RE1.mp3',
        contentType: 'audio/mpeg',
        sizeBytes: 9,
        storedAt: expect.any(Date),
      }),
    });
    expect(twilio.deleteRecording).toHaveBeenCalledWith('RE1');
    expect(prisma.callRecording.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'rec1' },
      data: { twilioDeletedAt: expect.any(Date) },
    });
    // The row is saved as stored before Twilio's copy is touched.
    expect(prisma.callRecording.update.mock.invocationCallOrder[0]).toBeLessThan(
      twilio.deleteRecording.mock.invocationCallOrder[0],
    );
  });

  it('archives the Twilio copy of an outbound call of any length, browser recording or not', async () => {
    // A 12-second outbound call the browser also recorded: its browser file is
    // too short to upload, so this Twilio copy must still reach storage.
    const { archiver, storage, twilio } = build();

    await archiver.archive({
      ...(RECORDING as object),
      source: 'DialVerb',
      durationSeconds: 12,
    } as never);

    expect(storage.put).toHaveBeenCalledTimes(1);
    expect(twilio.deleteRecording).toHaveBeenCalledWith('RE1');
  });

  it('keeps the Twilio copy and counts the attempt when the upload fails', async () => {
    const storage = {
      enabled: true,
      keyFor: vi.fn().mockReturnValue('k'),
      put: vi.fn().mockRejectedValue(new Error('R2 upload failed: 500')),
    };
    const { archiver, prisma, twilio } = build({ storage });

    await archiver.archive(RECORDING);

    expect(twilio.deleteRecording).not.toHaveBeenCalled();
    expect(prisma.callRecording.update).toHaveBeenCalledWith({
      where: { id: 'rec1' },
      data: { archiveAttempts: { increment: 1 }, archiveError: 'R2 upload failed: 500' },
    });
  });

  it('stops retrying a recording Twilio no longer has', async () => {
    const twilio = {
      fetchRecordingMedia: vi.fn().mockRejectedValue(new TwilioRecordingMediaError(404)),
      deleteRecording: vi.fn(),
    };
    const { archiver, prisma } = build({ twilio });

    await archiver.archive(RECORDING);

    expect(prisma.callRecording.update).toHaveBeenCalledWith({
      where: { id: 'rec1' },
      data: {
        archiveAttempts: MAX_ARCHIVE_ATTEMPTS,
        archiveError: 'Twilio no longer has this recording.',
      },
    });
    expect(twilio.deleteRecording).not.toHaveBeenCalled();
  });

  it('leaves the Twilio copy when RECORDINGS_DELETE_FROM_TWILIO is false', async () => {
    const { archiver, twilio, storage } = build({
      env: { RECORDINGS_DELETE_FROM_TWILIO: 'false' },
    });

    await archiver.archive(RECORDING);

    expect(storage.put).toHaveBeenCalled();
    expect(twilio.deleteRecording).not.toHaveBeenCalled();
  });
});

describe('RecordingArchiverService.sweep', () => {
  it('only picks completed Twilio recordings that have settled and are not stored', async () => {
    const { archiver, prisma } = build();
    const now = new Date('2026-10-07T12:00:00Z');

    await archiver.sweep(now);

    expect(prisma.callRecording.findMany).toHaveBeenNthCalledWith(1, {
      where: {
        status: RecordingStatus.COMPLETED,
        storedAt: null,
        twilioRecordingSid: { not: null },
        archiveAttempts: { lt: MAX_ARCHIVE_ATTEMPTS },
        updatedAt: { lt: new Date('2026-10-07T11:50:00Z') },
      },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });
  });

  it('retries deleting stored recordings that are still at Twilio', async () => {
    const { archiver, prisma, twilio } = build();
    prisma.callRecording.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...(RECORDING as object), storedAt: new Date() }]);

    await archiver.sweep();

    expect(twilio.deleteRecording).toHaveBeenCalledWith('RE1');
    expect(prisma.callRecording.update).toHaveBeenCalledWith({
      where: { id: 'rec1' },
      data: { twilioDeletedAt: expect.any(Date) },
    });
  });

  it('does nothing while another machine holds the lock', async () => {
    const { archiver, prisma, redis } = build();
    redis.client.set.mockResolvedValue(null);

    await archiver.sweep();

    expect(prisma.callRecording.findMany).not.toHaveBeenCalled();
    expect(redis.client.del).not.toHaveBeenCalled();
  });

  it('does nothing until storage is configured', async () => {
    const { archiver, prisma } = build({ storage: { enabled: false } });

    await archiver.sweep();

    expect(prisma.callRecording.findMany).not.toHaveBeenCalled();
  });
});
