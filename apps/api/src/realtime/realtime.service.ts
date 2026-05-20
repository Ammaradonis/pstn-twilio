import { Injectable } from '@nestjs/common';
import {
  WS_EVENTS,
  type WsCallEvent,
  type WsNumberEvent,
  type WsSmsEvent,
  type WsTwilioWebhookErrorEvent,
} from '@pstn-twilio/shared';

import { type RealtimeGateway } from './realtime.gateway';

@Injectable()
export class RealtimeService {
  constructor(private readonly gateway: RealtimeGateway) {}

  smsReceived(payload: WsSmsEvent): void {
    this.gateway.emit(WS_EVENTS.SMS_RECEIVED, payload);
  }

  smsSent(payload: WsSmsEvent): void {
    this.gateway.emit(WS_EVENTS.SMS_SENT, payload);
  }

  smsStatusUpdated(payload: WsSmsEvent): void {
    this.gateway.emit(WS_EVENTS.SMS_STATUS_UPDATED, payload);
  }

  numberCreated(payload: WsNumberEvent): void {
    this.gateway.emit(WS_EVENTS.NUMBER_CREATED, payload);
  }

  numberUpdated(payload: WsNumberEvent): void {
    this.gateway.emit(WS_EVENTS.NUMBER_UPDATED, payload);
  }

  callInboundRinging(payload: WsCallEvent): void {
    this.gateway.emit(WS_EVENTS.CALL_INBOUND_RINGING, payload);
  }

  callStatusUpdated(payload: WsCallEvent): void {
    this.gateway.emit(WS_EVENTS.CALL_STATUS_UPDATED, payload);
  }

  webhookError(payload: WsTwilioWebhookErrorEvent): void {
    this.gateway.emit(WS_EVENTS.TWILIO_WEBHOOK_ERROR, payload);
  }
}
