import { Injectable } from '@nestjs/common';
import {
  WS_EVENTS,
  WsAiCallEvent,
  WsCallEvent,
  WsEmailFinderFoundEvent,
  WsNumberEvent,
  WsSmsEvent,
  WsTwilioWebhookErrorEvent,
  WsVoiceAppCallAnsweredEvent,
  type VoiceAppSyncKind,
} from '@pstn-twilio/shared';

import { PrismaService } from '../prisma/prisma.service';

import { RealtimeGateway } from './realtime.gateway';

// Number owners rarely change; a short cache keeps a DB read off every event.
const NUMBER_OWNER_TTL_MS = 60_000;

/**
 * Number events reach the user the number belongs to and every owner (who
 * sees all numbers). Other users never receive them.
 */
@Injectable()
export class RealtimeService {
  // Shared promises keep events for one number in the order they were sent.
  private readonly numberOwners = new Map<string, { at: number; userId: Promise<string | null> }>();

  constructor(
    private readonly gateway: RealtimeGateway,
    private readonly prisma: PrismaService,
  ) {}

  smsReceived(payload: WsSmsEvent): void {
    this.emitForNumber(payload.numberId, WS_EVENTS.SMS_RECEIVED, payload);
  }

  smsSent(payload: WsSmsEvent): void {
    this.emitForNumber(payload.numberId, WS_EVENTS.SMS_SENT, payload);
  }

  smsStatusUpdated(payload: WsSmsEvent): void {
    this.emitForNumber(payload.numberId, WS_EVENTS.SMS_STATUS_UPDATED, payload);
  }

  numberCreated(payload: WsNumberEvent): void {
    this.emitForNumber(payload.number.id, WS_EVENTS.NUMBER_CREATED, payload);
  }

  numberUpdated(payload: WsNumberEvent): void {
    this.emitForNumber(payload.number.id, WS_EVENTS.NUMBER_UPDATED, payload);
  }

  callInboundRinging(payload: WsCallEvent): void {
    this.emitForNumber(payload.numberId, WS_EVENTS.CALL_INBOUND_RINGING, payload);
  }

  callStatusUpdated(payload: WsCallEvent): void {
    this.emitForNumber(payload.numberId, WS_EVENTS.CALL_STATUS_UPDATED, payload);
  }

  aiCallUpdated(payload: WsAiCallEvent): void {
    this.gateway.emitToOwnersAnd(null, WS_EVENTS.AI_CALL_UPDATED, payload);
  }

  webhookError(payload: WsTwilioWebhookErrorEvent): void {
    this.gateway.emitToOwnersAnd(null, WS_EVENTS.TWILIO_WEBHOOK_ERROR, payload);
  }

  emailFinderFound(userId: string, payload: WsEmailFinderFoundEvent): void {
    this.gateway.emitToUser(userId, WS_EVENTS.EMAIL_FINDER_FOUND, payload);
  }

  /** Tell the user's other devices to refetch what changed. */
  voiceAppSync(userId: string, kinds: VoiceAppSyncKind[]): void {
    this.gateway.emitToUser(userId, WS_EVENTS.VOICE_APP_SYNC, { kinds });
  }

  voiceAppCallAnswered(userId: string, payload: WsVoiceAppCallAnsweredEvent): void {
    this.gateway.emitToUser(userId, WS_EVENTS.VOICE_APP_CALL_ANSWERED, payload);
  }

  private emitForNumber(numberId: string | null, event: string, payload: unknown): void {
    if (!numberId) {
      this.gateway.emitToOwnersAnd(null, event, payload);
      return;
    }
    void this.numberOwner(numberId).then((userId) =>
      this.gateway.emitToOwnersAnd(userId, event, payload),
    );
  }

  private numberOwner(numberId: string): Promise<string | null> {
    const cached = this.numberOwners.get(numberId);
    if (cached && Date.now() - cached.at < NUMBER_OWNER_TTL_MS) return cached.userId;
    const userId = this.prisma.phoneNumber
      .findUnique({ where: { id: numberId }, select: { userId: true } })
      .then((row) => row?.userId ?? null)
      .catch(() => {
        this.numberOwners.delete(numberId);
        return null;
      });
    this.numberOwners.set(numberId, { at: Date.now(), userId });
    return userId;
  }
}
