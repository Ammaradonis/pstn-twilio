import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CallDirection, CallStatus, PhoneNumber, RecordingStatus, UserRole } from '@prisma/client';
import type { CallDto, PaginatedDto, VoicemailDto } from '@pstn-twilio/shared';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TwilioService } from '../twilio/twilio.service';

import { decodeCursor, encodeCursor, mapCall } from './calls.mapper';

interface ActorContext {
  userId: string;
  role: UserRole;
  ipAddress?: string;
  userAgent?: string;
}

interface ListInput {
  cursor?: string;
  limit: number;
  direction?: CallDirection;
  status?: CallStatus;
  since?: string;
}

export interface RecordingMediaResult {
  body: Buffer;
  contentType: string;
  filename: string;
}

const HANGUPPABLE_STATUSES: CallStatus[] = [
  CallStatus.INITIATED,
  CallStatus.RINGING,
  CallStatus.IN_PROGRESS,
];

const CALL_RECORDINGS_INCLUDE = {
  recordings: { orderBy: { createdAt: 'desc' as const } },
};

const VOICEMAIL_INCLUDE = {
  call: { include: { phoneNumber: true } },
};

type VoicemailRow = Awaited<ReturnType<PrismaService['callRecording']['findMany']>>[number] & {
  call: {
    id: string;
    phoneNumberId: string | null;
    fromE164: string;
    toE164: string;
    phoneNumber: {
      id: string;
      phoneNumberE164: string;
      friendlyName: string | null;
    } | null;
  } | null;
};

@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilio: TwilioService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(
    actor: ActorContext,
    numberId: string,
    input: ListInput,
  ): Promise<PaginatedDto<CallDto>> {
    const phoneNumber = await this.assertOwnership(actor, numberId);
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    if (input.cursor && !cursor) throw new BadRequestException('Invalid cursor');

    const where: Record<string, unknown> = { phoneNumberId: phoneNumber.id };
    if (input.direction) where.direction = input.direction;
    if (input.status) where.status = input.status;
    if (input.since) where.createdAt = { gte: new Date(input.since) };
    if (cursor) {
      where.OR = [
        { createdAt: { lt: new Date(cursor.t) } },
        { AND: [{ createdAt: new Date(cursor.t) }, { id: { lt: cursor.id } }] },
      ];
    }

    const rows = await this.prisma.call.findMany({
      where,
      include: CALL_RECORDINGS_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
    });
    const last = rows[rows.length - 1];
    return {
      items: rows.map(mapCall),
      nextCursor:
        rows.length === input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  async getOne(actor: ActorContext, numberId: string, callId: string): Promise<CallDto> {
    await this.assertOwnership(actor, numberId);
    const call = await this.prisma.call.findUnique({
      where: { id: callId },
      include: CALL_RECORDINGS_INCLUDE,
    });
    if (!call || call.phoneNumberId !== numberId) {
      throw new NotFoundException(`Call ${callId} not found`);
    }
    return mapCall(call);
  }

  async listVoicemail(input: {
    cursor?: string;
    limit: number;
  }): Promise<PaginatedDto<VoicemailDto>> {
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    if (input.cursor && !cursor) throw new BadRequestException('Invalid cursor');

    const where: Record<string, unknown> = {
      source: 'voicemail',
      call: { phoneNumberId: { not: null } },
    };
    if (cursor) {
      where.OR = [
        { createdAt: { lt: new Date(cursor.t) } },
        { AND: [{ createdAt: new Date(cursor.t) }, { id: { lt: cursor.id } }] },
      ];
    }

    const rows = (await this.prisma.callRecording.findMany({
      where,
      include: VOICEMAIL_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
    })) as VoicemailRow[];
    const items = rows.filter(isMappableVoicemail).map(mapVoicemail);
    const last = rows[rows.length - 1];

    return {
      items,
      nextCursor:
        rows.length === input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  async hangup(actor: ActorContext, callId: string): Promise<CallDto> {
    const call = await this.prisma.call.findUnique({
      where: { id: callId },
      include: CALL_RECORDINGS_INCLUDE,
    });
    if (!call) throw new NotFoundException(`Call ${callId} not found`);
    if (call.phoneNumberId) await this.assertOwnership(actor, call.phoneNumberId);
    if (!call.twilioCallSid) throw new BadRequestException('Call has no Twilio SID');
    if (!HANGUPPABLE_STATUSES.includes(call.status)) {
      throw new BadRequestException(`Cannot hang up a call in status ${call.status}`);
    }

    try {
      await this.twilio.client.calls(call.twilioCallSid).update({ status: 'completed' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Twilio hangup failed';
      this.logger.warn(`Hangup failed: ${message}`);
      throw new BadRequestException({ statusCode: 400, error: 'TwilioHangupError', message });
    }

    const updated = await this.prisma.call.update({
      where: { id: callId },
      data: { status: CallStatus.COMPLETED, endedAt: new Date() },
      include: CALL_RECORDINGS_INCLUDE,
    });

    await this.audit.log({
      userId: actor.userId,
      action: 'call.hangup',
      entityType: 'Call',
      entityId: callId,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      metadata: { twilioCallSid: call.twilioCallSid },
    });

    this.realtime.callStatusUpdated({
      numberId: updated.phoneNumberId,
      call: mapCall(updated),
    });

    return mapCall(updated);
  }

  async addNote(
    actor: ActorContext,
    callId: string,
    note: string,
  ): Promise<{ callId: string; note: string; createdAt: string }> {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) throw new NotFoundException(`Call ${callId} not found`);
    if (call.phoneNumberId) await this.assertOwnership(actor, call.phoneNumberId);

    await this.audit.log({
      userId: actor.userId,
      action: 'call.note_added',
      entityType: 'Call',
      entityId: callId,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      metadata: { note },
    });

    return { callId, note, createdAt: new Date().toISOString() };
  }

  async getRecordingMedia(
    actor: ActorContext,
    numberId: string,
    callId: string,
    recordingId: string,
  ): Promise<RecordingMediaResult> {
    await this.assertOwnership(actor, numberId);
    const call = await this.prisma.call.findUnique({
      where: { id: callId },
      include: CALL_RECORDINGS_INCLUDE,
    });
    if (!call || call.phoneNumberId !== numberId) {
      throw new NotFoundException(`Call ${callId} not found`);
    }

    const recording = call.recordings.find((row) => row.id === recordingId);
    if (!recording) {
      throw new NotFoundException(`Recording ${recordingId} not found`);
    }
    if (recording.status !== RecordingStatus.COMPLETED) {
      throw new BadRequestException('Recording media is not ready yet');
    }

    try {
      const media = await this.twilio.fetchRecordingMedia(recording.twilioRecordingSid);
      return {
        ...media,
        filename: `${recording.twilioRecordingSid}.mp3`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Twilio recording media fetch failed';
      this.logger.warn(`Recording media fetch failed: ${message}`);
      throw new BadRequestException({
        statusCode: 400,
        error: 'TwilioRecordingMediaError',
        message,
      });
    }
  }

  async getVoicemailMedia(recordingId: string): Promise<RecordingMediaResult> {
    const recording = (await this.prisma.callRecording.findUnique({
      where: { id: recordingId },
      include: VOICEMAIL_INCLUDE,
    })) as VoicemailRow | null;
    if (!recording || !isMappableVoicemail(recording) || recording.source !== 'voicemail') {
      throw new NotFoundException(`Voicemail ${recordingId} not found`);
    }
    if (recording.status !== RecordingStatus.COMPLETED) {
      throw new BadRequestException('Voicemail media is not ready yet');
    }

    try {
      const media = await this.twilio.fetchRecordingMedia(recording.twilioRecordingSid);
      return {
        ...media,
        filename: `${recording.twilioRecordingSid}.mp3`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Twilio voicemail media fetch failed';
      this.logger.warn(`Voicemail media fetch failed: ${message}`);
      throw new BadRequestException({
        statusCode: 400,
        error: 'TwilioVoicemailMediaError',
        message,
      });
    }
  }

  private async assertOwnership(actor: ActorContext, numberId: string): Promise<PhoneNumber> {
    const number = await this.prisma.phoneNumber.findUnique({ where: { id: numberId } });
    if (!number) throw new NotFoundException(`Number ${numberId} not found`);
    if (actor.role !== UserRole.OWNER && number.userId !== actor.userId) {
      throw new ForbiddenException('You do not own this number');
    }
    return number;
  }
}

function isMappableVoicemail(row: VoicemailRow): row is VoicemailRow & {
  call: NonNullable<VoicemailRow['call']> & {
    phoneNumber: NonNullable<NonNullable<VoicemailRow['call']>['phoneNumber']>;
  };
} {
  return Boolean(row.call?.phoneNumber);
}

function mapVoicemail(
  row: VoicemailRow & {
    call: NonNullable<VoicemailRow['call']> & {
      phoneNumber: NonNullable<NonNullable<VoicemailRow['call']>['phoneNumber']>;
    };
  },
): VoicemailDto {
  return {
    id: row.id,
    callId: row.call.id,
    phoneNumberId: row.call.phoneNumber.id,
    phoneNumberE164: row.call.phoneNumber.phoneNumberE164,
    phoneNumberFriendlyName: row.call.phoneNumber.friendlyName,
    twilioCallSid: row.twilioCallSid,
    twilioRecordingSid: row.twilioRecordingSid,
    from: row.call.fromE164,
    to: row.call.toE164,
    status: row.status,
    durationSeconds: row.durationSeconds,
    startedAt: row.startedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
