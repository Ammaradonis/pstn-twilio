import { randomBytes } from 'crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CallDirection, CallStatus, UserRole, type Call } from '@prisma/client';
import {
  VOICEMAIL_DROP_MAX_MS,
  type VoicemailDropDto,
  type VoicemailDropResultDto,
  type VoicemailDropUploadInput,
} from '@pstn-twilio/shared';
import twilio from 'twilio';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioService } from '../twilio/twilio.service';

interface ActorContext {
  userId: string;
  role: UserRole;
}

export interface VoicemailDropAudio {
  audio: Buffer;
  contentType: string;
}

// 120 s of 8 kHz 16-bit mono is 1.92 MB; leave room for the header.
const MAX_AUDIO_BYTES = 2_100_000;

const ENDED_STATUSES: CallStatus[] = [
  CallStatus.COMPLETED,
  CallStatus.BUSY,
  CallStatus.FAILED,
  CallStatus.NO_ANSWER,
  CallStatus.CANCELED,
];

/**
 * The user's voicemail drop message, and dropping it on a live outbound call.
 *
 * An outbound call is the browser's leg (the parent) running <Dial><Number>,
 * which bridged in the callee's leg (the child). Dropping redirects the
 * callee's leg to <Play>message</Play><Hangup/>. That takes it out of the
 * <Dial>, so the browser's leg has no TwiML left and ends, while the callee's
 * voicemail keeps recording the message.
 */
@Injectable()
export class VoicemailDropService {
  private readonly logger = new Logger(VoicemailDropService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilio: TwilioService,
    private readonly audit: AuditService,
  ) {}

  async get(userId: string): Promise<VoicemailDropDto | null> {
    const message = await this.prisma.voicemailDrop.findUnique({
      where: { userId },
      select: { durationMs: true, updatedAt: true },
    });
    return message ? toDto(message) : null;
  }

  async save(userId: string, input: VoicemailDropUploadInput): Promise<VoicemailDropDto> {
    const audio = Buffer.from(input.audioBase64, 'base64');
    if (audio.length > MAX_AUDIO_BYTES) {
      throw new BadRequestException('The message is too long.');
    }
    const wavMs = wavDurationMs(audio);
    if (wavMs === null) {
      throw new BadRequestException('The message must be a PCM WAV recording.');
    }
    if (wavMs < 500) throw new BadRequestException('The message is too short.');
    if (wavMs > VOICEMAIL_DROP_MAX_MS + 1000) {
      throw new BadRequestException('The message is too long.');
    }
    // A new URL per recording, so Twilio never plays a cached older message.
    const token = randomBytes(24).toString('base64url');
    const durationMs = Math.round(wavMs);
    const saved = await this.prisma.voicemailDrop.upsert({
      where: { userId },
      update: { audio, contentType: input.contentType, durationMs, token },
      create: { userId, audio, contentType: input.contentType, durationMs, token },
      select: { durationMs: true, updatedAt: true },
    });
    return toDto(saved);
  }

  async remove(userId: string): Promise<void> {
    await this.prisma.voicemailDrop.deleteMany({ where: { userId } });
  }

  async audio(userId: string): Promise<VoicemailDropAudio> {
    const message = await this.prisma.voicemailDrop.findUnique({ where: { userId } });
    if (!message) throw new NotFoundException('No voicemail message recorded yet.');
    return { audio: Buffer.from(message.audio), contentType: message.contentType };
  }

  /** For Twilio <Play>; the token is the only credential. */
  async audioByToken(token: string): Promise<VoicemailDropAudio> {
    const message = await this.prisma.voicemailDrop.findUnique({
      where: { token: token.replace(/\.wav$/, '') },
    });
    if (!message) throw new NotFoundException();
    return { audio: Buffer.from(message.audio), contentType: message.contentType };
  }

  /**
   * Plays the actor's message to the callee of their live outbound call, then
   * hangs the callee up. The browser's leg ends by itself once Twilio has the
   * new instructions; the browser hangs up too as soon as this returns.
   */
  async drop(actor: ActorContext, callSid: string): Promise<VoicemailDropResultDto> {
    // Look the callee's leg up while the database checks run: every
    // millisecond here is the user waiting on a call they want gone.
    const legs = this.twilio.client.calls.list({
      parentCallSid: callSid,
      status: 'in-progress',
      limit: 5,
    });
    legs.catch(() => undefined); // awaited below; don't report it unhandled

    const [call, message] = await Promise.all([
      this.ownedCall(actor, callSid),
      this.prisma.voicemailDrop.findUnique({
        where: { userId: actor.userId },
        select: { token: true, durationMs: true },
      }),
    ]);
    if (call.direction !== CallDirection.OUTBOUND) {
      throw new BadRequestException('Voicemail drop works on outbound calls only.');
    }
    if (ENDED_STATUSES.includes(call.status)) {
      throw new ConflictException('The call has already ended.');
    }
    if (!message) {
      throw new BadRequestException(
        'Record your voicemail message first (Voicemail drop in the menu).',
      );
    }

    let callee: { sid: string } | undefined;
    try {
      callee = (await legs)[0];
    } catch (err) {
      this.logger.warn(`Callee lookup for ${callSid} failed: ${errorMessage(err)}`);
      throw new ConflictException('Twilio could not find the other side of this call. Try again.');
    }
    if (!callee) {
      throw new ConflictException(
        'Nobody has answered yet. Wait for the voicemail greeting and the beep, then drop.',
      );
    }

    const response = new twilio.twiml.VoiceResponse();
    response.play(
      `${this.twilio.webhookBaseUrl}/webhooks/twilio/voicemail-drop/${message.token}.wav`,
    );
    response.hangup();
    try {
      await this.twilio.client.calls(callee.sid).update({ twiml: response.toString() });
    } catch (err) {
      this.logger.warn(`Voicemail drop on ${callee.sid} failed: ${errorMessage(err)}`);
      throw new ConflictException('The call ended before the message could be dropped.');
    }

    this.audit
      .log({
        userId: actor.userId,
        action: 'voicemail_drop.dropped',
        entityType: 'call',
        entityId: call.id,
        metadata: { callSid, calleeCallSid: callee.sid, durationMs: message.durationMs },
      })
      .catch((err) => this.logger.warn(`Audit log failed: ${errorMessage(err)}`));

    return { calleeCallSid: callee.sid, durationMs: message.durationMs };
  }

  private async ownedCall(actor: ActorContext, callSid: string): Promise<Call> {
    const call = await this.prisma.call.findUnique({ where: { twilioCallSid: callSid } });
    if (!call) throw new NotFoundException('This call is not in the call log yet.');
    if (actor.role === UserRole.OWNER) return call;
    const number = call.phoneNumberId
      ? await this.prisma.phoneNumber.findUnique({
          where: { id: call.phoneNumberId },
          select: { userId: true },
        })
      : null;
    if (number?.userId !== actor.userId) {
      throw new ForbiddenException('You do not own this call.');
    }
    return call;
  }
}

function toDto(message: { durationMs: number; updatedAt: Date }): VoicemailDropDto {
  return { durationMs: message.durationMs, updatedAt: message.updatedAt.toISOString() };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}

/** Length of a PCM WAV file in ms, or null when it is not one. */
export function wavDurationMs(file: Buffer): number | null {
  if (file.length < 44) return null;
  if (file.toString('ascii', 0, 4) !== 'RIFF' || file.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }
  let byteRate = 0;
  let offset = 12;
  while (offset + 8 <= file.length) {
    const id = file.toString('ascii', offset, offset + 4);
    const size = file.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > file.length) return null;
      if (file.readUInt16LE(body) !== 1) return null; // PCM only
      byteRate = file.readUInt32LE(body + 8);
    } else if (id === 'data') {
      if (!byteRate) return null;
      const dataBytes = Math.min(size, file.length - body);
      return (dataBytes / byteRate) * 1000;
    }
    offset = body + size + (size % 2);
  }
  return null;
}
