import { Readable } from 'stream';

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CallDirection,
  MessageDirection,
  Prisma,
  RecordingStatus,
  type Call,
  type CallRecording,
} from '@prisma/client';
import type {
  PaginatedDto,
  SmsMessageDto,
  VoiceAppBootstrapDto,
  VoiceCallKind,
  VoiceCallLogItemDto,
  VoiceConversationDto,
  VoiceThreadDto,
  VoiceUnreadDto,
  VoiceVoicemailDto,
} from '@pstn-twilio/shared';

import { decodeCursor, encodeCursor } from '../calls/calls.mapper';
import { mapMessage } from '../messages/messages.mapper';
import { MessagesService } from '../messages/messages.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TwilioService } from '../twilio/twilio.service';

import { VoiceAppSettingsService } from './voice-app-settings.service';
import { VoiceAppContext, mapVoiceNumber, type VoiceActor } from './voice-app.context';
import { VoicePushService } from './voice-push.service';

const ENDED_CALL_STATUSES = ['COMPLETED', 'CANCELED', 'NO_ANSWER', 'BUSY', 'FAILED'] as const;
const CONVERSATION_LIMIT = 300;

type CallWithRecordings = Call & { recordings: CallRecording[] };

interface ConversationRow {
  id: string;
  numberId: string;
  direction: CallDirection;
  body: string | null;
  status: SmsMessageDto['status'];
  numMedia: number;
  createdAt: Date;
  counterpart: string;
}

@Injectable()
export class VoiceAppService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly twilio: TwilioService,
    private readonly realtime: RealtimeService,
    private readonly messages: MessagesService,
    private readonly settings: VoiceAppSettingsService,
    private readonly push: VoicePushService,
    private readonly ctx: VoiceAppContext,
  ) {}

  async bootstrap(actor: VoiceActor): Promise<VoiceAppBootstrapDto> {
    const [numbers, settings, forwarding, blocked, unread] = await Promise.all([
      this.ctx.numbers(actor.userId),
      this.settings.getSettings(actor.userId),
      this.settings.listForwarding(actor.userId),
      this.settings.listBlocked(actor.userId),
      this.unread(actor.userId),
    ]);
    return {
      user: { id: actor.userId, email: actor.email },
      numbers: numbers.map(mapVoiceNumber),
      identity: this.twilio.voiceIdentity(actor.userId),
      settings,
      forwarding,
      blocked,
      unread,
      pushPublicKey: this.push.publicKey,
    };
  }

  async calls(
    userId: string,
    opts: { cursor?: string; limit: number; filter?: 'all' | 'missed' },
  ): Promise<PaginatedDto<VoiceCallLogItemDto>> {
    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
    if (opts.cursor && !cursor) throw new BadRequestException('Invalid cursor');
    const [ids, settings] = await Promise.all([
      this.ctx.numberIds(userId),
      this.ctx.settings(userId),
    ]);
    const and: Prisma.CallWhereInput[] = [
      {
        // Incoming calls to the user's numbers, plus calls the user placed from
        // the voice app. Blocked and declined callers are kept here — the log is
        // the record of what happened, and hiding a call the user blocked
        // themselves makes the block list impossible to audit.
        OR: [
          { direction: CallDirection.INBOUND },
          // Calls placed by this user; an owner may also dial out from the number.
          { direction: CallDirection.OUTBOUND, browserIdentity: this.twilio.voiceIdentity(userId) },
        ],
      },
    ];
    if (opts.filter === 'missed') {
      // Missed means "rang and nobody picked up": a call the user declined was
      // seen and dealt with, and a blocked call never rang at all.
      and.push({
        direction: CallDirection.INBOUND,
        answeredAt: null,
        OR: [{ handledBy: null }, { handledBy: { notIn: ['blocked', 'declined'] } }],
      });
    }
    if (cursor) {
      and.push({
        OR: [
          { createdAt: { lt: new Date(cursor.t) } },
          { createdAt: new Date(cursor.t), id: { lt: cursor.id } },
        ],
      });
    }
    const rows = (await this.prisma.call.findMany({
      where: {
        phoneNumberId: { in: ids },
        createdAt: { gte: settings.historyStartsAt },
        AND: and,
      },
      include: { recordings: { where: { source: 'voicemail' }, orderBy: { createdAt: 'desc' } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: opts.limit,
    })) as CallWithRecordings[];
    const last = rows[rows.length - 1];
    return {
      items: rows.map(mapCallLogItem),
      nextCursor: rows.length === opts.limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  async voicemail(
    userId: string,
    opts: { cursor?: string; limit: number },
  ): Promise<PaginatedDto<VoiceVoicemailDto>> {
    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
    if (opts.cursor && !cursor) throw new BadRequestException('Invalid cursor');
    const [ids, settings] = await Promise.all([
      this.ctx.numberIds(userId),
      this.ctx.settings(userId),
    ]);
    const rows = await this.prisma.callRecording.findMany({
      where: {
        ...voicemailWhere(ids, settings.historyStartsAt),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: new Date(cursor.t) } },
                { createdAt: new Date(cursor.t), id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      include: { call: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: opts.limit,
    });
    const last = rows[rows.length - 1];
    return {
      items: rows.filter((row) => row.call).map((row) => mapVoicemail(row, row.call!)),
      nextCursor: rows.length === opts.limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  async voicemailMedia(
    userId: string,
    id: string,
  ): Promise<{ stream: Readable; contentType: string; filename: string }> {
    const recording = await this.ownVoicemail(userId, id);
    if (recording.status !== RecordingStatus.COMPLETED) {
      throw new BadRequestException('This voicemail is still being saved');
    }
    const media = await this.twilio.fetchRecordingMedia(recording.twilioRecordingSid);
    return { ...media, filename: `voicemail-${recording.id}.mp3` };
  }

  async markVoicemailHeard(userId: string, id: string): Promise<void> {
    const recording = await this.ownVoicemail(userId, id);
    if (recording.heardAt) return;
    await this.prisma.callRecording.update({ where: { id }, data: { heardAt: new Date() } });
    this.realtime.voiceAppSync(userId, ['voicemail']);
  }

  async conversations(userId: string): Promise<VoiceConversationDto[]> {
    const [ids, settings, blocked] = await Promise.all([
      this.ctx.numberIds(userId),
      this.ctx.settings(userId),
      this.blockedSet(userId),
    ]);
    if (ids.length === 0) return [];
    const since = settings.historyStartsAt;
    const [latest, unread] = await Promise.all([
      this.prisma.$queryRaw<ConversationRow[]>`
        SELECT * FROM (
          SELECT DISTINCT ON (counterpart)
            m.id, m.phone_number_id AS "numberId", m.direction::text AS direction, m.body,
            m.status::text AS status, m.num_media AS "numMedia", m.created_at AS "createdAt",
            CASE WHEN m.direction = 'INBOUND' THEN m.from_e164 ELSE m.to_e164 END AS counterpart
          FROM sms_messages m
          WHERE m.phone_number_id = ANY(${ids}) AND m.created_at >= ${since}
          ORDER BY counterpart, m.created_at DESC, m.id DESC
        ) latest
        ORDER BY "createdAt" DESC
        LIMIT ${CONVERSATION_LIMIT}`,
      this.unreadByCounterpart(userId, ids, since),
    ]);
    return latest
      .filter((row) => !blocked.has(row.counterpart))
      .map((row) => ({
        counterpart: row.counterpart,
        numberId: row.numberId,
        last: {
          id: row.id,
          direction: row.direction,
          body: row.body ?? '',
          status: row.status,
          numMedia: row.numMedia,
          createdAt: new Date(row.createdAt).toISOString(),
        },
        unread: unread.get(row.counterpart) ?? 0,
      }));
  }

  async thread(
    userId: string,
    counterpart: string,
    opts: { cursor?: string; limit: number },
  ): Promise<VoiceThreadDto> {
    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
    if (opts.cursor && !cursor) throw new BadRequestException('Invalid cursor');
    const [ids, settings] = await Promise.all([
      this.ctx.numberIds(userId),
      this.ctx.settings(userId),
    ]);
    const rows = await this.prisma.smsMessage.findMany({
      where: {
        phoneNumberId: { in: ids },
        createdAt: { gte: settings.historyStartsAt },
        AND: [
          {
            OR: [
              { direction: MessageDirection.INBOUND, fromE164: counterpart },
              { direction: MessageDirection.OUTBOUND, toE164: counterpart },
            ],
          },
          ...(cursor
            ? [
                {
                  OR: [
                    { createdAt: { lt: new Date(cursor.t) } },
                    { createdAt: new Date(cursor.t), id: { lt: cursor.id } },
                  ],
                },
              ]
            : []),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: opts.limit,
    });
    const last = rows[rows.length - 1];
    return {
      counterpart,
      messages: rows.map(mapMessage),
      nextCursor: rows.length === opts.limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  async sendMessage(actor: VoiceActor, to: string, body: string): Promise<SmsMessageDto> {
    const number = await this.ctx.primaryNumber(actor.userId, 'sms');
    const message = await this.messages.send(actor, number.id, { to, body });
    // Replying reads the conversation.
    await this.markRead(actor.userId, `sms:${to}`);
    return message;
  }

  async markRead(userId: string, key: string): Promise<void> {
    const readAt = new Date();
    await this.prisma.readMarker.upsert({
      where: { userId_key: { userId, key } },
      update: { readAt },
      create: { userId, key, readAt },
    });
    this.realtime.voiceAppSync(userId, ['read']);
  }

  async unread(userId: string): Promise<VoiceUnreadDto> {
    const [ids, settings, blocked, callsMarker] = await Promise.all([
      this.ctx.numberIds(userId),
      this.ctx.settings(userId),
      this.blockedSet(userId),
      this.prisma.readMarker.findUnique({ where: { userId_key: { userId, key: 'calls' } } }),
    ]);
    if (ids.length === 0) return { missedCalls: 0, voicemail: 0, messages: 0 };
    const since = settings.historyStartsAt;
    const callsSince =
      callsMarker && callsMarker.readAt > since ? callsMarker.readAt : settings.historyStartsAt;
    const [missedCalls, voicemail, byCounterpart] = await Promise.all([
      this.prisma.call.count({
        where: {
          phoneNumberId: { in: ids },
          direction: CallDirection.INBOUND,
          answeredAt: null,
          status: { in: [...ENDED_CALL_STATUSES] },
          createdAt: { gt: callsSince },
          OR: [{ handledBy: null }, { handledBy: { not: 'blocked' } }],
        },
      }),
      this.prisma.callRecording.count({
        where: { ...voicemailWhere(ids, since), heardAt: null },
      }),
      this.unreadByCounterpart(userId, ids, since),
    ]);
    let messages = 0;
    for (const [counterpart, count] of byCounterpart) {
      if (!blocked.has(counterpart)) messages += count;
    }
    return { missedCalls, voicemail, messages };
  }

  private async unreadByCounterpart(
    userId: string,
    ids: string[],
    since: Date,
  ): Promise<Map<string, number>> {
    const rows = await this.prisma.$queryRaw<Array<{ counterpart: string; unread: number }>>`
      SELECT m.from_e164 AS counterpart, COUNT(*)::int AS unread
      FROM sms_messages m
      LEFT JOIN read_markers r ON r.user_id = ${userId} AND r.key = 'sms:' || m.from_e164
      WHERE m.phone_number_id = ANY(${ids}) AND m.created_at >= ${since}
        AND m.direction = 'INBOUND' AND (r.read_at IS NULL OR m.created_at > r.read_at)
      GROUP BY m.from_e164`;
    return new Map(rows.map((row) => [row.counterpart, Number(row.unread)]));
  }

  private async blockedSet(userId: string): Promise<Set<string>> {
    const rows = await this.prisma.blockedNumber.findMany({
      where: { userId },
      select: { e164: true },
    });
    return new Set(rows.map((row) => row.e164));
  }

  private async ownVoicemail(userId: string, id: string) {
    const recording = await this.prisma.callRecording.findUnique({
      where: { id },
      include: { call: { include: { phoneNumber: true } } },
    });
    if (
      !recording ||
      recording.source !== 'voicemail' ||
      recording.call?.phoneNumber?.userId !== userId
    ) {
      throw new NotFoundException('Voicemail not found');
    }
    return recording;
  }
}

function voicemailWhere(ids: string[], since: Date): Prisma.CallRecordingWhereInput {
  return {
    source: 'voicemail',
    status: RecordingStatus.COMPLETED,
    durationSeconds: { gte: 1 },
    call: { phoneNumberId: { in: ids }, createdAt: { gte: since } },
  };
}

function mapVoicemail(row: CallRecording, call: Call): VoiceVoicemailDto {
  return {
    id: row.id,
    callId: call.id,
    from: call.fromE164,
    to: call.toE164,
    durationSeconds: row.durationSeconds,
    transcript: row.transcript,
    transcriptStatus: row.transcriptStatus,
    heard: Boolean(row.heardAt),
    ready: row.status === RecordingStatus.COMPLETED,
    createdAt: row.createdAt.toISOString(),
  };
}

export function callKind(call: CallWithRecordings): VoiceCallKind {
  // These two are decisions the user made about the call, so they outrank how
  // the call ended: a declined call still shows as declined even though the
  // caller was handed to voicemail afterwards.
  if (call.handledBy === 'blocked') return 'blocked';
  if (call.handledBy === 'declined') return 'declined';
  if (call.direction === CallDirection.OUTBOUND) return 'outgoing';
  if (call.answeredAt) return 'answered';
  if (playableVoicemail(call)) return 'voicemail';
  return 'missed';
}

function playableVoicemail(call: CallWithRecordings): CallRecording | null {
  return (
    call.recordings.find(
      (r) =>
        r.source === 'voicemail' &&
        r.status === RecordingStatus.COMPLETED &&
        (r.durationSeconds ?? 0) >= 1,
    ) ?? null
  );
}

export function mapCallLogItem(call: CallWithRecordings): VoiceCallLogItemDto {
  const voicemail = playableVoicemail(call);
  return {
    id: call.id,
    callSid: call.twilioCallSid,
    numberId: call.phoneNumberId,
    direction: call.direction,
    counterpart:
      call.direction === CallDirection.OUTBOUND
        ? (call.destinationE164 ?? call.toE164)
        : call.fromE164,
    kind: callKind(call),
    status: call.status,
    startedAt: (call.startedAt ?? call.createdAt).toISOString(),
    answeredAt: call.answeredAt?.toISOString() ?? null,
    endedAt: call.endedAt?.toISOString() ?? null,
    durationSeconds: call.durationSeconds,
    handledBy: call.handledBy,
    voicemail: voicemail ? mapVoicemail(voicemail, call) : null,
  };
}
