import { Injectable, Logger } from '@nestjs/common';
import { MessageDirection, MessageStatus, WebhookProvider } from '@prisma/client';

import { mapMessage } from '../messages/messages.mapper';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';

import {
  describeTwilioMessagingError,
  mapTwilioStatusToEnum,
  preserveMostFinalMessageStatus,
} from './status.mapper';

export interface InboundParams {
  MessageSid?: string;
  SmsSid?: string;
  From?: string;
  To?: string;
  Body?: string;
  NumMedia?: string;
  [key: string]: string | undefined;
}

export interface StatusParams {
  MessageSid?: string;
  SmsSid?: string;
  MessageStatus?: string;
  SmsStatus?: string;
  ErrorCode?: string;
  ErrorMessage?: string;
  [key: string]: string | undefined;
}

interface StatusContext {
  localMessageId?: string;
}

@Injectable()
export class MessagingWebhookService {
  private readonly logger = new Logger(MessagingWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async handleInbound(params: InboundParams): Promise<{ deduped: boolean }> {
    const sid = params.MessageSid ?? params.SmsSid;
    if (!sid) {
      throw new Error('MessageSid missing from inbound webhook');
    }
    const dedupeKey = `messaging:inbound:${sid}`;
    if (await this.alreadyProcessed(dedupeKey)) {
      this.logger.debug(`Inbound SMS ${sid} already processed`);
      return { deduped: true };
    }

    const to = params.To;
    if (!to) throw new Error('To missing from inbound webhook');

    const phoneNumber = await this.prisma.phoneNumber.findUnique({
      where: { phoneNumberE164: to },
    });

    await this.recordWebhookEvent(dedupeKey, 'messaging.inbound', sid, params);

    if (!phoneNumber) {
      this.logger.warn(`Inbound SMS for unknown number ${to} (sid ${sid})`);
      return { deduped: false };
    }

    const numMedia = Number.parseInt(params.NumMedia ?? '0', 10) || 0;
    const media = collectMedia(params, numMedia);

    const existing = await this.prisma.smsMessage.findUnique({
      where: { twilioMessageSid: sid },
    });
    if (existing) {
      this.logger.debug(`SMS ${sid} already exists in DB`);
      return { deduped: true };
    }

    const message = await this.prisma.smsMessage.create({
      data: {
        phoneNumberId: phoneNumber.id,
        twilioMessageSid: sid,
        direction: MessageDirection.INBOUND,
        fromE164: params.From ?? '',
        toE164: to,
        body: params.Body ?? null,
        numMedia,
        media: media.length > 0 ? (media as never) : undefined,
        status: MessageStatus.RECEIVED,
        rawPayload: params as never,
      },
    });

    this.realtime.smsReceived({
      numberId: phoneNumber.id,
      message: {
        id: message.id,
        phoneNumberId: message.phoneNumberId,
        twilioMessageSid: message.twilioMessageSid,
        direction: message.direction,
        from: message.fromE164,
        to: message.toE164,
        body: message.body ?? '',
        status: message.status,
        errorCode: message.errorCode,
        errorMessage: message.errorMessage,
        numMedia: message.numMedia,
        mediaUrls: media,
        createdAt: message.createdAt.toISOString(),
        updatedAt: message.updatedAt.toISOString(),
      },
    });

    return { deduped: false };
  }

  async handleStatus(
    params: StatusParams,
    context: StatusContext = {},
  ): Promise<{ deduped: boolean }> {
    const sid = params.MessageSid ?? params.SmsSid;
    const statusRaw = params.MessageStatus ?? params.SmsStatus;
    if (!sid || !statusRaw) {
      throw new Error('MessageSid or MessageStatus missing from status callback');
    }
    const dedupeKey = [
      'messaging:status',
      sid,
      statusRaw.toLowerCase(),
      params.ErrorCode ?? '',
      context.localMessageId ?? '',
    ].join(':');
    if (await this.alreadyProcessed(dedupeKey)) {
      return { deduped: true };
    }
    await this.recordWebhookEvent(dedupeKey, 'messaging.status', sid, params);

    const existing =
      (await this.prisma.smsMessage.findUnique({
        where: { twilioMessageSid: sid },
      })) ??
      (context.localMessageId
        ? await this.prisma.smsMessage.findUnique({ where: { id: context.localMessageId } })
        : null);
    if (!existing) {
      this.logger.warn(`Status callback for unknown SMS sid ${sid}`);
      return { deduped: false };
    }
    if (existing.twilioMessageSid && existing.twilioMessageSid !== sid) {
      this.logger.warn(
        `Status callback sid ${sid} does not match local SMS ${existing.id} sid ${existing.twilioMessageSid}`,
      );
      return { deduped: false };
    }

    const status = preserveMostFinalMessageStatus(
      existing.status,
      mapTwilioStatusToEnum(statusRaw),
    );
    const errorCode = params.ErrorCode ?? existing.errorCode;
    const updated = await this.prisma.smsMessage.update({
      where: { id: existing.id },
      data: {
        twilioMessageSid: existing.twilioMessageSid ?? sid,
        status,
        errorCode,
        errorMessage:
          params.ErrorMessage ?? describeTwilioMessagingError(errorCode) ?? existing.errorMessage,
      },
    });

    this.realtime.smsStatusUpdated({
      numberId: updated.phoneNumberId,
      message: mapMessage(updated),
    });

    return { deduped: false };
  }

  private async alreadyProcessed(dedupeKey: string): Promise<boolean> {
    const found = await this.prisma.webhookEvent.findUnique({ where: { dedupeKey } });
    return Boolean(found);
  }

  private async recordWebhookEvent(
    dedupeKey: string,
    eventType: string,
    twilioSid: string | null,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.prisma.webhookEvent.create({
        data: {
          provider: WebhookProvider.TWILIO,
          eventType,
          signatureValid: true,
          twilioSid,
          dedupeKey,
          rawPayload: payload as never,
          processedAt: new Date(),
        },
      });
    } catch (err) {
      this.logger.debug(`Webhook event dedupe race for ${dedupeKey}: ${(err as Error).message}`);
    }
  }
}

function collectMedia(params: InboundParams, numMedia: number): string[] {
  const urls: string[] = [];
  for (let i = 0; i < numMedia; i += 1) {
    const url = params[`MediaUrl${i}`];
    if (typeof url === 'string' && url.length > 0) urls.push(url);
  }
  return urls;
}
