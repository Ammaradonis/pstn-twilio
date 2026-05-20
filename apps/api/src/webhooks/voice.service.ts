import { Injectable, Logger } from '@nestjs/common';
import { CallDirection, Call, WebhookProvider } from '@prisma/client';
import twilio from 'twilio';

import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TwilioService } from '../twilio/twilio.service';

import { mapTwilioCallStatus } from './voice-status.mapper';

export interface InboundVoiceParams {
  CallSid?: string;
  From?: string;
  To?: string;
  CallStatus?: string;
  Direction?: string;
  [key: string]: string | undefined;
}

export interface OutboundVoiceParams {
  CallSid?: string;
  From?: string;
  To?: string;
  selectedNumberId?: string;
  destinationNumber?: string;
  [key: string]: string | undefined;
}

export interface CallStatusParams {
  CallSid?: string;
  ParentCallSid?: string;
  CallStatus?: string;
  CallDuration?: string;
  Duration?: string;
  Direction?: string;
  From?: string;
  To?: string;
  Price?: string;
  PriceUnit?: string;
  Timestamp?: string;
  ErrorCode?: string;
  ErrorMessage?: string;
  [key: string]: string | undefined;
}

@Injectable()
export class VoiceWebhookService {
  private readonly logger = new Logger(VoiceWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilio: TwilioService,
    private readonly realtime: RealtimeService,
  ) {}

  async handleInbound(params: InboundVoiceParams): Promise<string> {
    const callSid = params.CallSid ?? '';
    const to = params.To ?? '';
    const from = params.From ?? '';
    if (!callSid || !to) {
      this.logger.warn('Inbound voice webhook missing CallSid or To');
      return hangupTwiml('We could not route this call.');
    }

    await this.recordWebhookEvent(`voice:inbound:${callSid}`, 'voice.inbound', callSid, params);

    const phoneNumber = await this.prisma.phoneNumber.findUnique({
      where: { phoneNumberE164: to },
    });
    if (!phoneNumber) {
      this.logger.warn(`Inbound call to unknown number ${to} (sid ${callSid})`);
      return hangupTwiml('This number is not configured to receive calls.');
    }
    if (!phoneNumber.active || !phoneNumber.userId) {
      return hangupTwiml('This number is not currently available.');
    }

    const call = await this.upsertCall({
      twilioCallSid: callSid,
      phoneNumberId: phoneNumber.id,
      direction: CallDirection.INBOUND,
      fromE164: from,
      toE164: to,
      statusRaw: params.CallStatus ?? 'ringing',
      rawPayload: params,
    });

    this.realtime.callInboundRinging({
      numberId: phoneNumber.id,
      call: toCallDto(call),
    });

    const identity = this.twilio.voiceIdentity(phoneNumber.userId, phoneNumber.id);
    const response = new twilio.twiml.VoiceResponse();
    const dial = response.dial({ answerOnBridge: true, timeout: 30 });
    dial.client(
      {
        statusCallback: `${this.twilio.webhookBaseUrl}/webhooks/twilio/voice/status`,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      },
      identity,
    );
    return response.toString();
  }

  async handleOutbound(params: OutboundVoiceParams, identity: string | undefined): Promise<string> {
    const callSid = params.CallSid ?? '';
    await this.recordWebhookEvent(`voice:outbound:${callSid}`, 'voice.outbound', callSid, params);

    const selectedNumberId = params.selectedNumberId;
    const destinationNumber = params.destinationNumber;
    if (!selectedNumberId || !destinationNumber) {
      this.logger.warn('Outbound voice webhook missing selectedNumberId/destinationNumber');
      return hangupTwiml('Missing call parameters.');
    }
    if (!/^\+[1-9]\d{1,14}$/.test(destinationNumber)) {
      return hangupTwiml('Destination must be a valid phone number.');
    }

    const phoneNumber = await this.prisma.phoneNumber.findUnique({
      where: { id: selectedNumberId },
    });
    if (!phoneNumber || !phoneNumber.active || !phoneNumber.capabilitiesVoice) {
      return hangupTwiml('Selected number cannot place calls.');
    }
    if (identity && phoneNumber.userId) {
      const expected = this.twilio.voiceIdentity(phoneNumber.userId, phoneNumber.id);
      if (identity !== expected) {
        this.logger.warn(
          `Outbound call from identity ${identity} for number owned by another identity (${expected})`,
        );
        return hangupTwiml('You are not authorized to call from this number.');
      }
    }

    const call = await this.upsertCall({
      twilioCallSid: callSid,
      phoneNumberId: phoneNumber.id,
      direction: CallDirection.OUTBOUND,
      fromE164: identity ?? '',
      toE164: destinationNumber,
      selectedCallerId: phoneNumber.phoneNumberE164,
      destinationE164: destinationNumber,
      browserIdentity: identity ?? null,
      statusRaw: params.CallStatus ?? 'initiated',
      rawPayload: params,
    });

    this.realtime.callStatusUpdated({
      numberId: phoneNumber.id,
      call: toCallDto(call),
    });

    const response = new twilio.twiml.VoiceResponse();
    const dial = response.dial({
      callerId: phoneNumber.phoneNumberE164,
      answerOnBridge: true,
    });
    dial.number(destinationNumber);
    return response.toString();
  }

  async handleStatus(params: CallStatusParams): Promise<void> {
    const callSid = params.CallSid;
    const statusRaw = params.CallStatus;
    if (!callSid || !statusRaw) return;

    const dedupeKey = `voice:status:${callSid}:${statusRaw}`;
    if (await this.alreadyProcessed(dedupeKey)) return;
    await this.recordWebhookEvent(dedupeKey, 'voice.status', callSid, params);

    const existing = await this.prisma.call.findUnique({ where: { twilioCallSid: callSid } });
    const newStatus = mapTwilioCallStatus(statusRaw);
    const duration = parseDuration(params.CallDuration ?? params.Duration);

    const updateData: Record<string, unknown> = {
      status: newStatus,
      rawPayload: params as never,
    };
    if (duration !== null) updateData.durationSeconds = duration;
    if (params.Price) updateData.price = params.Price;
    if (params.PriceUnit) updateData.priceUnit = params.PriceUnit;
    if (params.ParentCallSid) updateData.parentCallSid = params.ParentCallSid;
    if (newStatus === 'IN_PROGRESS' && !existing?.answeredAt) updateData.answeredAt = new Date();
    if (
      newStatus === 'COMPLETED' ||
      newStatus === 'FAILED' ||
      newStatus === 'BUSY' ||
      newStatus === 'NO_ANSWER' ||
      newStatus === 'CANCELED'
    ) {
      if (!existing?.endedAt) updateData.endedAt = new Date();
    }

    const call = existing
      ? await this.prisma.call.update({ where: { twilioCallSid: callSid }, data: updateData })
      : await this.prisma.call.create({
          data: {
            twilioCallSid: callSid,
            direction:
              params.Direction?.includes('outbound') === true
                ? CallDirection.OUTBOUND
                : CallDirection.INBOUND,
            fromE164: params.From ?? '',
            toE164: params.To ?? '',
            status: newStatus,
            rawPayload: params as never,
            startedAt: new Date(),
          },
        });

    this.realtime.callStatusUpdated({
      numberId: call.phoneNumberId,
      call: toCallDto(call),
    });
  }

  handleFallback(): string {
    const response = new twilio.twiml.VoiceResponse();
    response.say(
      { voice: 'alice' },
      'We are unable to complete your call right now. Please try again later.',
    );
    response.hangup();
    return response.toString();
  }

  private async upsertCall(input: {
    twilioCallSid: string;
    phoneNumberId: string;
    direction: CallDirection;
    fromE164: string;
    toE164: string;
    statusRaw: string;
    rawPayload: Record<string, unknown>;
    selectedCallerId?: string;
    destinationE164?: string;
    browserIdentity?: string | null;
  }): Promise<Call> {
    const status = mapTwilioCallStatus(input.statusRaw);
    const existing = await this.prisma.call.findUnique({
      where: { twilioCallSid: input.twilioCallSid },
    });
    if (existing) {
      return this.prisma.call.update({
        where: { twilioCallSid: input.twilioCallSid },
        data: {
          status,
          rawPayload: input.rawPayload as never,
        },
      });
    }
    return this.prisma.call.create({
      data: {
        twilioCallSid: input.twilioCallSid,
        phoneNumberId: input.phoneNumberId,
        direction: input.direction,
        fromE164: input.fromE164,
        toE164: input.toE164,
        selectedCallerId: input.selectedCallerId ?? null,
        destinationE164: input.destinationE164 ?? null,
        browserIdentity: input.browserIdentity ?? null,
        status,
        rawPayload: input.rawPayload as never,
        startedAt: new Date(),
      },
    });
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

function hangupTwiml(message: string): string {
  const response = new twilio.twiml.VoiceResponse();
  response.say({ voice: 'alice' }, message);
  response.hangup();
  return response.toString();
}

function parseDuration(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function toCallDto(call: Call) {
  return {
    id: call.id,
    phoneNumberId: call.phoneNumberId,
    twilioCallSid: call.twilioCallSid,
    direction: call.direction,
    from: call.fromE164,
    to: call.toE164,
    selectedCallerId: call.selectedCallerId,
    destination: call.destinationE164,
    status: call.status,
    durationSeconds: call.durationSeconds,
    startedAt: (call.startedAt ?? call.createdAt).toISOString(),
    answeredAt: call.answeredAt?.toISOString() ?? null,
    endedAt: call.endedAt?.toISOString() ?? null,
  };
}
