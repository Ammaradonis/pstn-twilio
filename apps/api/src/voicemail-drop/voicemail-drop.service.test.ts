import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CallDirection, CallStatus, UserRole } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { VoicemailDropService, wavDurationMs } from './voicemail-drop.service';

const PARENT_SID = 'CA0123456789abcdef0123456789abcdef';
const CHILD_SID = 'CAfedcba9876543210fedcba9876543210';
const OWNER = { userId: 'u1', role: UserRole.OWNER };
const OPERATOR = { userId: 'u2', role: UserRole.OPERATOR };
const CALL = {
  id: 'c1',
  phoneNumberId: 'pn1',
  twilioCallSid: PARENT_SID,
  direction: CallDirection.OUTBOUND,
  status: CallStatus.IN_PROGRESS,
};

/** 8 kHz mono 16-bit PCM WAV of the given length. */
function wav(ms: number): Buffer {
  const rate = 8000;
  const dataBytes = Math.round((rate * ms) / 1000) * 2;
  const file = Buffer.alloc(44 + dataBytes);
  file.write('RIFF', 0, 'ascii');
  file.writeUInt32LE(36 + dataBytes, 4);
  file.write('WAVE', 8, 'ascii');
  file.write('fmt ', 12, 'ascii');
  file.writeUInt32LE(16, 16);
  file.writeUInt16LE(1, 20);
  file.writeUInt16LE(1, 22);
  file.writeUInt32LE(rate, 24);
  file.writeUInt32LE(rate * 2, 28);
  file.writeUInt16LE(2, 32);
  file.writeUInt16LE(16, 34);
  file.write('data', 36, 'ascii');
  file.writeUInt32LE(dataBytes, 40);
  return file;
}

function build(
  opts: {
    call?: Record<string, unknown> | null;
    message?: { token: string; durationMs: number } | null;
    legs?: Array<{ sid: string }> | Error;
    update?: Error;
    numberOwner?: string;
  } = {},
) {
  const update = vi.fn(() => (opts.update ? Promise.reject(opts.update) : Promise.resolve({})));
  const list = vi.fn(() =>
    opts.legs instanceof Error
      ? Promise.reject(opts.legs)
      : Promise.resolve(opts.legs ?? [{ sid: CHILD_SID }]),
  );
  const calls = Object.assign(
    vi.fn(() => ({ update })),
    { list },
  );
  const prisma = {
    call: {
      findUnique: vi.fn().mockResolvedValue(opts.call === undefined ? CALL : opts.call),
    },
    phoneNumber: {
      findUnique: vi.fn().mockResolvedValue({ userId: opts.numberOwner ?? 'u2' }),
    },
    voicemailDrop: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          opts.message === undefined
            ? { token: 'tok_abcdefghijklmnopqrstu', durationMs: 23000 }
            : opts.message,
        ),
      upsert: vi.fn().mockImplementation(({ create }) =>
        Promise.resolve({
          durationMs: create.durationMs,
          updatedAt: new Date('2026-11-16T10:00:00Z'),
        }),
      ),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const twilio = {
    client: { calls },
    webhookBaseUrl: 'https://api.example.test',
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const service = new VoicemailDropService(prisma as never, twilio as never, audit as never);
  return { service, prisma, calls, list, update, audit };
}

describe('VoicemailDropService.drop', () => {
  it("redirects the callee's leg to play the message, then hang up", async () => {
    const { service, list, calls, update, audit } = build();

    const result = await service.drop(OWNER, PARENT_SID);

    expect(result).toEqual({ calleeCallSid: CHILD_SID, durationMs: 23000 });
    expect(list).toHaveBeenCalledWith({
      parentCallSid: PARENT_SID,
      status: 'in-progress',
      limit: 5,
    });
    expect(calls).toHaveBeenCalledWith(CHILD_SID);
    const twiml = (update.mock.calls[0] as unknown as [{ twiml: string }])[0].twiml;
    expect(twiml).toContain(
      '<Play>https://api.example.test/webhooks/twilio/voicemail-drop/tok_abcdefghijklmnopqrstu.wav</Play><Hangup/>',
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'voicemail_drop.dropped', entityId: 'c1' }),
    );
  });

  it('never touches the browser leg', async () => {
    const { service, calls } = build();
    await service.drop(OWNER, PARENT_SID);
    expect(calls).not.toHaveBeenCalledWith(PARENT_SID);
  });

  it('asks for a recording when none is saved', async () => {
    const { service, update } = build({ message: null });
    await expect(service.drop(OWNER, PARENT_SID)).rejects.toThrow(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it('waits for an answer before dropping', async () => {
    const { service, update } = build({ legs: [] });
    await expect(service.drop(OWNER, PARENT_SID)).rejects.toThrow(/Nobody has answered yet/);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses inbound calls', async () => {
    const { service } = build({ call: { ...CALL, direction: CallDirection.INBOUND } });
    await expect(service.drop(OWNER, PARENT_SID)).rejects.toThrow(/outbound calls only/);
  });

  it('refuses calls that already ended', async () => {
    const { service } = build({ call: { ...CALL, status: CallStatus.COMPLETED } });
    await expect(service.drop(OWNER, PARENT_SID)).rejects.toThrow(ConflictException);
  });

  it('refuses calls missing from the call log', async () => {
    const { service } = build({ call: null });
    await expect(service.drop(OWNER, PARENT_SID)).rejects.toThrow(NotFoundException);
  });

  it("refuses another user's call", async () => {
    const { service, update } = build({ numberOwner: 'someone-else' });
    await expect(service.drop(OPERATOR, PARENT_SID)).rejects.toThrow(ForbiddenException);
    expect(update).not.toHaveBeenCalled();
  });

  it("lets a user drop on their own number's call", async () => {
    const { service, update } = build({ numberOwner: 'u2' });
    await service.drop(OPERATOR, PARENT_SID);
    expect(update).toHaveBeenCalled();
  });

  it('reports a call that ended mid-drop as a conflict', async () => {
    const { service } = build({ update: new Error('Call is not in-progress') });
    await expect(service.drop(OWNER, PARENT_SID)).rejects.toThrow(/ended before the message/);
  });

  it('reports a failed callee lookup without an unhandled rejection', async () => {
    const { service } = build({ legs: new Error('Twilio down') });
    await expect(service.drop(OWNER, PARENT_SID)).rejects.toThrow(ConflictException);
  });

  it('does not leak a lookup rejection when the database checks fail first', async () => {
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      const { service } = build({ call: null, legs: new Error('Twilio down') });
      await expect(service.drop(OWNER, PARENT_SID)).rejects.toThrow(NotFoundException);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('VoicemailDropService.save', () => {
  it('stores a WAV with its measured length and a fresh token', async () => {
    const { service, prisma } = build();
    const audioBase64 = wav(12_000).toString('base64');

    const saved = await service.save('u1', {
      audioBase64,
      contentType: 'audio/wav',
      durationMs: 99_999, // the file's own length wins
    });

    expect(saved).toEqual({ durationMs: 12000, updatedAt: '2026-11-16T10:00:00.000Z' });
    const args = prisma.voicemailDrop.upsert.mock.calls[0]![0];
    expect(args.create.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(args.update.token).toBe(args.create.token);
  });

  it('gives every recording a new token', async () => {
    const { service, prisma } = build();
    const input = {
      audioBase64: wav(2000).toString('base64'),
      contentType: 'audio/wav' as const,
      durationMs: 2000,
    };
    await service.save('u1', input);
    await service.save('u1', input);
    const [first, second] = prisma.voicemailDrop.upsert.mock.calls.map((c) => c[0].update.token);
    expect(first).not.toBe(second);
  });

  it('rejects files that are not WAV', async () => {
    const { service } = build();
    const notWav = Buffer.alloc(2000, 7).toString('base64');
    await expect(
      service.save('u1', { audioBase64: notWav, contentType: 'audio/wav', durationMs: 2000 }),
    ).rejects.toThrow(/PCM WAV/);
  });

  it('rejects messages over two minutes', async () => {
    const { service } = build();
    await expect(
      service.save('u1', {
        audioBase64: wav(125_000).toString('base64'),
        contentType: 'audio/wav',
        durationMs: 120_000,
      }),
    ).rejects.toThrow(/too long/);
  });
});

describe('wavDurationMs', () => {
  it('reads the length from the header', () => {
    expect(wavDurationMs(wav(1500))).toBe(1500);
  });

  it('skips chunks before the data', () => {
    const plain = wav(1000);
    const list = Buffer.alloc(8 + 6);
    list.write('LIST', 0, 'ascii');
    list.writeUInt32LE(6, 4);
    const withList = Buffer.concat([plain.subarray(0, 36), list, plain.subarray(36)]);
    expect(wavDurationMs(withList)).toBe(1000);
  });

  it('rejects compressed WAV', () => {
    const file = wav(1000);
    file.writeUInt16LE(7, 20); // mu-law
    expect(wavDurationMs(file)).toBeNull();
  });
});
