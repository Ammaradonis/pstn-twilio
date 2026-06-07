import { Injectable, Logger } from '@nestjs/common';
import {
  CallDirection,
  Call,
  CallRecording,
  CallStatus,
  RecordingStatus,
  WebhookProvider,
} from '@prisma/client';
import { normalizeDialablePhoneNumber } from '@pstn-twilio/shared';
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

export interface RecordingStatusParams {
  AccountSid?: string;
  CallSid?: string;
  ParentCallSid?: string;
  RecordingSid?: string;
  RecordingUrl?: string;
  RecordingStatus?: string;
  RecordingDuration?: string;
  RecordingChannels?: string;
  RecordingSource?: string;
  RecordingTrack?: string;
  Timestamp?: string;
  ErrorCode?: string;
  ErrorMessage?: string;
  [key: string]: string | undefined;
}

export interface VoicemailParams {
  CallSid?: string;
  From?: string;
  To?: string;
  DialCallStatus?: string;
  CallStatus?: string;
  [key: string]: string | undefined;
}

type CallWithRecordings = Call & { recordings?: CallRecording[] };

const RECORDING_CALLBACK_EVENTS = ['in-progress', 'completed', 'absent'] as const;
const CALL_WITH_RECORDINGS_INCLUDE = {
  recordings: { orderBy: { createdAt: 'desc' as const } },
};
const CALL_STATUS_RANK: Record<CallStatus, number> = {
  [CallStatus.INITIATED]: 1,
  [CallStatus.RINGING]: 2,
  [CallStatus.IN_PROGRESS]: 3,
  [CallStatus.COMPLETED]: 4,
  [CallStatus.BUSY]: 4,
  [CallStatus.FAILED]: 4,
  [CallStatus.NO_ANSWER]: 4,
  [CallStatus.CANCELED]: 4,
};
type DialRecordingAttributes = {
  record: 'record-from-answer-dual';
  recordingStatusCallback: string;
  recordingStatusCallbackMethod: 'POST';
  recordingStatusCallbackEvent: Array<(typeof RECORDING_CALLBACK_EVENTS)[number]>;
  recordingTrack: 'both';
  trim: 'do-not-trim';
};

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
    const dial = response.dial({
      answerOnBridge: true,
      timeout: 30,
      action: `${this.twilio.webhookBaseUrl}/webhooks/twilio/voice/voicemail`,
      method: 'POST',
      ...this.recordingDialAttributes(),
    });
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

  async handleVoicemail(params: VoicemailParams): Promise<string> {
    const callSid = params.CallSid ?? '';
    const dialStatus = params.DialCallStatus ?? params.CallStatus ?? 'unknown';
    if (callSid) {
      await this.recordWebhookEvent(
        `voice:voicemail-prompt:${callSid}:${dialStatus}`,
        'voice.voicemail.prompt',
        callSid,
        params,
      );
    }

    if (dialStatus === 'completed' || dialStatus === 'answered') {
      const response = new twilio.twiml.VoiceResponse();
      response.hangup();
      return response.toString();
    }

    const response = new twilio.twiml.VoiceResponse();
    response.say(
      { voice: 'alice' },
      'The browser phone is unavailable. Please leave a voicemail after the beep.',
    );
    response.record({
      action: `${this.twilio.webhookBaseUrl}/webhooks/twilio/voice/voicemail/complete`,
      method: 'POST',
      maxLength: 180,
      playBeep: true,
      timeout: 8,
      trim: 'trim-silence',
      recordingStatusCallback: `${this.twilio.webhookBaseUrl}/webhooks/twilio/voice/recording?kind=voicemail`,
      recordingStatusCallbackMethod: 'POST',
      recordingStatusCallbackEvent: [...RECORDING_CALLBACK_EVENTS],
    });
    response.say({ voice: 'alice' }, 'No voicemail was recorded. Goodbye.');
    response.hangup();
    return response.toString();
  }

  handleVoicemailComplete(): string {
    const response = new twilio.twiml.VoiceResponse();
    response.say({ voice: 'alice' }, 'Your voicemail has been saved. Goodbye.');
    response.hangup();
    return response.toString();
  }

  async handleOutbound(params: OutboundVoiceParams, identity: string | undefined): Promise<string> {
    const callSid = params.CallSid ?? '';
    const selectedNumberId = params.selectedNumberId;
    const rawDestinationNumber = params.destinationNumber;
    if (!selectedNumberId || !rawDestinationNumber) {
      this.logger.warn('Outbound voice webhook missing selectedNumberId/destinationNumber');
      return hangupTwiml('Missing call parameters.');
    }
    const destinationNumber = normalizeDialablePhoneNumber(rawDestinationNumber);
    if (!destinationNumber) {
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

    void this.persistOutboundStart({
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

    const response = new twilio.twiml.VoiceResponse();
    const dial = response.dial({
      callerId: phoneNumber.phoneNumberE164,
      answerOnBridge: true,
      ...this.recordingDialAttributes(),
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

  async handleRecording(
    params: RecordingStatusParams,
    options: { kind?: string } = {},
  ): Promise<void> {
    const callSid = params.CallSid;
    const recordingSid = params.RecordingSid;
    const statusRaw = params.RecordingStatus;
    if (!callSid || !recordingSid || !statusRaw) return;

    const isVoicemail = options.kind === 'voicemail';
    const dedupeKey = `voice:recording:${recordingSid}:${statusRaw}`;
    if (await this.alreadyProcessed(dedupeKey)) return;
    await this.recordWebhookEvent(
      dedupeKey,
      isVoicemail ? 'voice.voicemail' : 'voice.recording',
      recordingSid,
      params,
    );

    const call = await this.findCallForRecording(params);
    const existingRecording = await this.prisma.callRecording.findUnique({
      where: { twilioRecordingSid: recordingSid },
    });
    const status = mapRecordingStatus(statusRaw);
    const duration = parseDuration(params.RecordingDuration);
    const channels = parseDuration(params.RecordingChannels);
    const startedAt =
      existingRecording?.startedAt ??
      (status === RecordingStatus.IN_PROGRESS ? new Date() : undefined);

    await this.prisma.callRecording.upsert({
      where: { twilioRecordingSid: recordingSid },
      update: {
        callId: call?.id ?? existingRecording?.callId ?? null,
        twilioCallSid: callSid,
        recordingUrl: params.RecordingUrl ?? existingRecording?.recordingUrl ?? null,
        status,
        durationSeconds: duration ?? existingRecording?.durationSeconds ?? null,
        channels: channels ?? existingRecording?.channels ?? null,
        source: isVoicemail
          ? 'voicemail'
          : (params.RecordingSource ?? existingRecording?.source ?? null),
        track: params.RecordingTrack ?? existingRecording?.track ?? null,
        rawPayload: params as never,
        startedAt,
      },
      create: {
        callId: call?.id ?? null,
        twilioCallSid: callSid,
        twilioRecordingSid: recordingSid,
        recordingUrl: params.RecordingUrl ?? null,
        status,
        durationSeconds: duration,
        channels,
        source: isVoicemail ? 'voicemail' : (params.RecordingSource ?? null),
        track: params.RecordingTrack ?? null,
        rawPayload: params as never,
        startedAt,
      },
    });

    if (!call) return;

    const updatedCall = await this.prisma.call.findUnique({
      where: { id: call.id },
      include: CALL_WITH_RECORDINGS_INCLUDE,
    });
    if (!updatedCall) return;

    this.realtime.callStatusUpdated({
      numberId: updatedCall.phoneNumberId,
      call: toCallDto(updatedCall),
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

  private async persistOutboundStart(input: {
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
  }): Promise<void> {
    try {
      await this.recordWebhookEvent(
        `voice:outbound:${input.twilioCallSid}`,
        'voice.outbound',
        input.twilioCallSid,
        input.rawPayload,
      );
      const call = await this.upsertCall(input);
      this.realtime.callStatusUpdated({
        numberId: input.phoneNumberId,
        call: toCallDto(call),
      });
    } catch (err) {
      this.logger.warn(
        `Outbound call persistence failed for ${input.twilioCallSid}: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
    }
  }

  private recordingDialAttributes(): DialRecordingAttributes {
    return {
      record: 'record-from-answer-dual',
      recordingStatusCallback: `${this.twilio.webhookBaseUrl}/webhooks/twilio/voice/recording`,
      recordingStatusCallbackMethod: 'POST',
      recordingStatusCallbackEvent: [...RECORDING_CALLBACK_EVENTS],
      recordingTrack: 'both',
      trim: 'do-not-trim',
    };
  }

  private async findCallForRecording(params: RecordingStatusParams): Promise<Call | null> {
    const callSid = params.CallSid;
    if (callSid) {
      const call = await this.prisma.call.findUnique({ where: { twilioCallSid: callSid } });
      if (call) return call;
    }
    if (params.ParentCallSid) {
      return this.prisma.call.findUnique({ where: { twilioCallSid: params.ParentCallSid } });
    }
    return null;
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
      const updateData: Record<string, unknown> = {
        phoneNumberId: input.phoneNumberId,
        direction: input.direction,
        fromE164: input.fromE164,
        toE164: input.toE164,
        selectedCallerId: input.selectedCallerId ?? existing.selectedCallerId,
        destinationE164: input.destinationE164 ?? existing.destinationE164,
        browserIdentity: input.browserIdentity ?? existing.browserIdentity,
        rawPayload: input.rawPayload as never,
        startedAt: existing.startedAt ?? new Date(),
      };
      if (CALL_STATUS_RANK[status] >= CALL_STATUS_RANK[existing.status]) {
        updateData.status = status;
      }
      return this.prisma.call.update({
        where: { twilioCallSid: input.twilioCallSid },
        data: updateData,
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

function mapRecordingStatus(value: string): RecordingStatus {
  switch (value) {
    case 'completed':
      return RecordingStatus.COMPLETED;
    case 'absent':
      return RecordingStatus.ABSENT;
    case 'in-progress':
    default:
      return RecordingStatus.IN_PROGRESS;
  }
}

function toCallDto(call: CallWithRecordings) {
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
    recordings: (call.recordings ?? []).map(toCallRecordingDto),
  };
}

function toCallRecordingDto(recording: CallRecording) {
  return {
    id: recording.id,
    twilioCallSid: recording.twilioCallSid,
    twilioRecordingSid: recording.twilioRecordingSid,
    recordingUrl: recording.recordingUrl,
    status: recording.status,
    durationSeconds: recording.durationSeconds,
    channels: recording.channels,
    source: recording.source,
    track: recording.track,
    startedAt: recording.startedAt?.toISOString() ?? null,
    createdAt: recording.createdAt.toISOString(),
  };
}
