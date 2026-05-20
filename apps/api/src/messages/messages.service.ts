import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  MessageDirection,
  MessageStatus,
  type PhoneNumber,
  type SmsMessage,
  UserRole,
} from '@prisma/client';
import type { PaginatedDto, SendMessageInput, SmsMessageDto } from '@pstn-twilio/shared';

import { type AuditService } from '../audit/audit.service';
import { type PrismaService } from '../prisma/prisma.service';
import { type RealtimeService } from '../realtime/realtime.service';
import { type TwilioService } from '../twilio/twilio.service';

import { decodeCursor, encodeCursor, mapMessage } from './messages.mapper';

interface ActorContext {
  userId: string;
  role: UserRole;
  ipAddress?: string;
  userAgent?: string;
}

interface SearchInput {
  query?: string;
  from?: string;
  to?: string;
  direction?: MessageDirection;
  limit: number;
}

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilio: TwilioService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(
    actor: ActorContext,
    numberId: string,
    opts: { cursor?: string; limit: number },
  ): Promise<PaginatedDto<SmsMessageDto>> {
    const phoneNumber = await this.assertOwnership(actor, numberId);
    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
    if (opts.cursor && !cursor) {
      throw new BadRequestException('Invalid cursor');
    }

    const where: Record<string, unknown> = { phoneNumberId: phoneNumber.id };
    if (cursor) {
      where.OR = [
        { createdAt: { lt: new Date(cursor.t) } },
        { AND: [{ createdAt: new Date(cursor.t) }, { id: { lt: cursor.id } }] },
      ];
    }

    const rows = await this.prisma.smsMessage.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: opts.limit,
    });
    const items = rows.map(mapMessage);
    const last = rows[rows.length - 1];
    return {
      items,
      nextCursor: rows.length === opts.limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  async getOne(actor: ActorContext, numberId: string, messageId: string): Promise<SmsMessageDto> {
    await this.assertOwnership(actor, numberId);
    const message = await this.prisma.smsMessage.findUnique({ where: { id: messageId } });
    if (!message || message.phoneNumberId !== numberId) {
      throw new NotFoundException(`Message ${messageId} not found`);
    }
    return mapMessage(message);
  }

  async send(
    actor: ActorContext,
    numberId: string,
    input: SendMessageInput,
  ): Promise<SmsMessageDto> {
    const phoneNumber = await this.assertOwnership(actor, numberId);
    if (!phoneNumber.capabilitiesSms) {
      throw new BadRequestException('This number does not have SMS capability');
    }
    if (!phoneNumber.active) {
      throw new ConflictException('Number is inactive');
    }

    const pending = await this.prisma.smsMessage.create({
      data: {
        phoneNumberId: phoneNumber.id,
        direction: MessageDirection.OUTBOUND,
        fromE164: phoneNumber.phoneNumberE164,
        toE164: input.to,
        body: input.body,
        numMedia: input.mediaUrl?.length ?? 0,
        media: input.mediaUrl ? (input.mediaUrl as never) : undefined,
        status: MessageStatus.QUEUED,
      },
    });

    let sent;
    try {
      sent = await this.twilio.client.messages.create({
        from: phoneNumber.phoneNumberE164,
        to: input.to,
        body: input.body,
        mediaUrl: input.mediaUrl,
        statusCallback: `${this.twilio.webhookBaseUrl}/webhooks/twilio/messaging/status`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Twilio send failed';
      this.logger.warn(`Outbound SMS failed: ${message}`);
      const failed = await this.prisma.smsMessage.update({
        where: { id: pending.id },
        data: { status: MessageStatus.FAILED, errorMessage: message },
      });
      this.realtime.smsStatusUpdated({
        numberId: phoneNumber.id,
        message: mapMessage(failed),
      });
      throw new BadRequestException({
        statusCode: 400,
        error: 'TwilioSendError',
        message,
      });
    }

    const updated = await this.prisma.smsMessage.update({
      where: { id: pending.id },
      data: {
        twilioMessageSid: sent.sid,
        status: MessageStatus.SENT,
      },
    });

    await this.audit.log({
      userId: actor.userId,
      action: 'message.sent',
      entityType: 'SmsMessage',
      entityId: updated.id,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      metadata: { to: input.to, sid: sent.sid },
    });

    this.realtime.smsSent({
      numberId: phoneNumber.id,
      message: mapMessage(updated),
    });

    return mapMessage(updated);
  }

  async retry(actor: ActorContext, numberId: string, messageId: string): Promise<SmsMessageDto> {
    await this.assertOwnership(actor, numberId);
    const existing = await this.prisma.smsMessage.findUnique({ where: { id: messageId } });
    if (!existing || existing.phoneNumberId !== numberId) {
      throw new NotFoundException(`Message ${messageId} not found`);
    }
    if (existing.direction !== MessageDirection.OUTBOUND) {
      throw new BadRequestException('Only outbound messages can be retried');
    }
    if (existing.status !== MessageStatus.FAILED && existing.status !== MessageStatus.UNDELIVERED) {
      throw new ConflictException(`Cannot retry message in status ${existing.status}`);
    }
    if (!existing.body && (existing.numMedia ?? 0) === 0) {
      throw new BadRequestException('Cannot retry: original message had no body or media');
    }

    return this.send(actor, numberId, {
      to: existing.toE164,
      body: existing.body ?? '',
      mediaUrl: extractMediaArray(existing),
    });
  }

  async search(actor: ActorContext, input: SearchInput): Promise<SmsMessageDto[]> {
    const ownedNumbers = await this.prisma.phoneNumber.findMany({
      where: actor.role === UserRole.OWNER ? {} : { userId: actor.userId },
      select: { id: true },
    });
    const ownedIds = ownedNumbers.map((n) => n.id);
    if (ownedIds.length === 0) return [];

    const where: Record<string, unknown> = { phoneNumberId: { in: ownedIds } };
    if (input.direction) where.direction = input.direction;
    if (input.from) where.fromE164 = input.from;
    if (input.to) where.toE164 = input.to;
    if (input.query) {
      where.OR = [
        { body: { contains: input.query, mode: 'insensitive' } },
        { fromE164: { contains: input.query } },
        { toE164: { contains: input.query } },
      ];
    }

    const rows = await this.prisma.smsMessage.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: input.limit,
    });
    return rows.map(mapMessage);
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

function extractMediaArray(message: SmsMessage): string[] | undefined {
  if (!message.media) return undefined;
  if (!Array.isArray(message.media)) return undefined;
  const urls = message.media.filter((u): u is string => typeof u === 'string');
  return urls.length > 0 ? urls : undefined;
}
