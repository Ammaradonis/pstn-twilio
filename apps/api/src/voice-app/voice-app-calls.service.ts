import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CallStatus,
  RecordingStatus,
  type Call,
  type PhoneNumber,
  type VoiceSettings,
} from '@prisma/client';
import twilio from 'twilio';

import { mapCall } from '../calls/calls.mapper';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RedisService } from '../redis/redis.service';
import { TwilioService } from '../twilio/twilio.service';

import { VoiceAppContext, doNotDisturbActive, spokenNumber } from './voice-app.context';
import { VoicePushService } from './voice-push.service';
import { VoicemailTranscriber } from './voicemail-transcriber.service';

const VOICE = 'Polly.Joanna';
const DEFAULT_GREETING =
  'The person you are calling is not available. Please leave a message after the tone.';
const VOICEMAIL_MAX_SECONDS = 180;
const SCREEN_TIMEOUT_SECONDS = 8;
// Longest a forwarded or app call may last (Twilio's own maximum is 4 hours).
const CALL_TIME_LIMIT_SECONDS = 4 * 60 * 60;
// Redis keys: dialed legs of a ringing call, and what to do when its <Dial> ends.
const LEGS_KEY = (parentSid: string) => `voiceapp:legs:${parentSid}`;
const REDIAL_KEY = (parentSid: string) => `voiceapp:redial:${parentSid}`;
const VOICEMAIL_NOTIFIED_KEY = (recordingSid: string) => `voiceapp:vm-notified:${recordingSid}`;
const ENDED_STATUSES = new Set<CallStatus>([
  CallStatus.COMPLETED,
  CallStatus.CANCELED,
  CallStatus.NO_ANSWER,
  CallStatus.BUSY,
  CallStatus.FAILED,
]);
const CALLER_GONE_STATUSES = new Set(['completed', 'canceled', 'busy', 'no-answer', 'failed']);
const E164_RE = /^\+[1-9]\d{6,14}$/;

export interface InboundCallParams {
  CallSid?: string;
  From?: string;
  To?: string;
  CallStatus?: string;
  [key: string]: string | undefined;
}

type CallWithNumber = Call & { phoneNumber: PhoneNumber | null };

/**
 * Incoming calls to voice app numbers: blocking, do not disturb, ringing the
 * app on every device together with linked phones, call screening on those
 * phones, voicemail, and the notifications that go with them.
 */
@Injectable()
export class VoiceAppCallsService {
  private readonly logger = new Logger(VoiceAppCallsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilio: TwilioService,
    private readonly redis: RedisService,
    private readonly realtime: RealtimeService,
    private readonly push: VoicePushService,
    private readonly ctx: VoiceAppContext,
    private readonly transcriber: VoicemailTranscriber,
  ) {}

  isVoiceUser(userId: string | null | undefined): Promise<boolean> {
    return this.ctx.isVoiceUser(userId);
  }

  /** TwiML for a call to a voice app user's number. The call row exists. */
  async inboundTwiml(
    params: InboundCallParams,
    phoneNumber: PhoneNumber,
    callId: string,
  ): Promise<string> {
    const userId = phoneNumber.userId!;
    const callSid = params.CallSid ?? '';
    const from = params.From ?? '';

    if (await this.ctx.isBlocked(userId, from)) {
      await this.prisma.call
        .update({ where: { id: callId }, data: { handledBy: 'blocked' } })
        .catch(() => undefined);
      // Not answered and not billed; the caller hears that the number is not in service.
      const response = new twilio.twiml.VoiceResponse();
      response.reject({ reason: 'rejected' });
      return response.toString();
    }

    const settings = await this.ctx.settings(userId);
    if (doNotDisturbActive(settings)) {
      return this.voicemailTwiml(userId, settings);
    }

    const callerName = await this.ctx.contactName(userId, from);
    const ring = await this.ringTwiml({ userId, settings, phoneNumber, callSid, from, callerName });
    if (!ring) return this.voicemailTwiml(userId, settings);

    if (settings.ringDevices) {
      void this.push.sendToUser(
        userId,
        {
          type: 'incoming-call',
          title: callerName ?? displayPhone(from),
          body: `Incoming call to ${displayPhone(phoneNumber.phoneNumberE164)}`,
          tag: `call-${callSid}`,
          url: `/voice/calls?answer=${encodeURIComponent(callSid)}`,
          callSid,
          actionToken: this.push.actionToken(userId, callSid),
          requireInteraction: true,
          renotify: true,
        },
        { ttl: 30, urgency: 'high' },
      );
    }
    return ring;
  }

  /** <Dial> action: the app and linked phones stopped ringing. */
  async dialComplete(params: {
    CallSid?: string;
    CallStatus?: string;
    DialCallStatus?: string;
    DialBridged?: string;
  }): Promise<string> {
    const callSid = params.CallSid ?? '';
    if (params.DialBridged === 'true') return hangupTwiml();

    const call = await this.findCall(callSid);
    const userId = call?.phoneNumber?.userId;
    if (!call || !userId) return hangupTwiml();
    const callerName = await this.ctx.contactName(userId, call.fromE164);

    // The caller hung up while it rang.
    if (CALLER_GONE_STATUSES.has(params.CallStatus ?? '')) {
      await this.notifyMissed(userId, call, callerName);
      return hangupTwiml();
    }

    const settings = await this.ctx.settings(userId);
    if (await this.takeFlag(REDIAL_KEY(callSid))) {
      // A device that just opened the app asked to ring again.
      const ring = await this.ringTwiml({
        userId,
        settings,
        phoneNumber: call.phoneNumber!,
        callSid,
        from: call.fromE164,
        callerName,
      });
      if (ring) return ring;
    }

    await this.notifyMissed(userId, call, callerName);
    return this.voicemailTwiml(userId, settings);
  }

  /** Dialed-leg status: remembers legs and records who answered. */
  async legStatus(
    leg: string | undefined,
    parentSid: string | undefined,
    params: { CallSid?: string; CallStatus?: string; ParentCallSid?: string },
  ): Promise<void> {
    const parent = parentSid || params.ParentCallSid;
    if (!parent || !params.CallSid || !leg) return;
    const status = params.CallStatus ?? '';
    if (status === 'initiated' || status === 'ringing' || status === 'queued') {
      await this.redis.client
        .multi()
        .sadd(LEGS_KEY(parent), params.CallSid)
        .expire(LEGS_KEY(parent), 15 * 60)
        .exec()
        .catch(() => undefined);
      return;
    }
    if (status !== 'in-progress') return;

    if (leg === 'app') {
      await this.markAnswered(parent, 'app');
      return;
    }
    const forwarding = await this.prisma.forwardingNumber.findUnique({ where: { id: leg } });
    if (!forwarding) return;
    const settings = await this.ctx.settings(forwarding.userId);
    // With screening, picking up isn't taking the call: pressing 1 is.
    if (!settings.screenCalls) {
      await this.markAnswered(parent, `phone:${forwarding.e164}`, forwarding.label);
    }
  }

  /** Runs on a linked phone that picked up, before the caller is connected. */
  async screenTwiml(forwardingId: string, parentSid: string, from: string): Promise<string> {
    const forwarding = await this.prisma.forwardingNumber.findUnique({
      where: { id: forwardingId },
    });
    if (!forwarding) return hangupTwiml();
    const name = await this.ctx.contactName(forwarding.userId, from);
    const who = name ?? (E164_RE.test(from) ? spokenNumber(from) : 'an unknown number');
    const response = new twilio.twiml.VoiceResponse();
    const gather = response.gather({
      numDigits: 1,
      timeout: SCREEN_TIMEOUT_SECONDS,
      action: this.webhookUrl('screen-result', { fid: forwardingId, parent: parentSid }),
      method: 'POST',
    });
    gather.say(
      { voice: VOICE },
      `Call from ${who}. Press 1 to answer, or 2 to send it to voicemail.`,
    );
    // Voicemail on the linked phone, or nobody pressing a key: leave the call to the others.
    response.hangup();
    return response.toString();
  }

  async screenResult(
    forwardingId: string,
    parentSid: string,
    params: { CallSid?: string; Digits?: string },
  ): Promise<string> {
    const forwarding = await this.prisma.forwardingNumber.findUnique({
      where: { id: forwardingId },
    });
    if (!forwarding) return hangupTwiml();
    if (params.Digits === '1') {
      await this.markAnswered(parentSid, `phone:${forwarding.e164}`, forwarding.label);
      // An empty document ends screening and connects the caller.
      return new twilio.twiml.VoiceResponse().toString();
    }
    if (params.Digits === '2') {
      await this.redis.client.del(REDIAL_KEY(parentSid)).catch(() => undefined);
      void this.cancelLegs(parentSid, params.CallSid);
    }
    return hangupTwiml();
  }

  voicemailDoneTwiml(): string {
    return hangupTwiml();
  }

  async voicemailRecording(params: {
    CallSid?: string;
    RecordingSid?: string;
    RecordingUrl?: string;
    RecordingStatus?: string;
    RecordingDuration?: string;
  }): Promise<void> {
    const { CallSid: callSid, RecordingSid: recordingSid } = params;
    if (!callSid || !recordingSid) return;
    const call = await this.findCall(callSid);
    const userId = call?.phoneNumber?.userId ?? null;
    const settings = userId ? await this.ctx.settings(userId) : null;
    const status =
      params.RecordingStatus === 'completed'
        ? RecordingStatus.COMPLETED
        : params.RecordingStatus === 'absent'
          ? RecordingStatus.ABSENT
          : RecordingStatus.IN_PROGRESS;
    const duration = parseSeconds(params.RecordingDuration);
    const transcribe = Boolean(settings?.voicemailTranscribe && this.transcriber.enabled);

    await this.prisma.callRecording.upsert({
      where: { twilioRecordingSid: recordingSid },
      update: {
        callId: call?.id ?? undefined,
        status,
        durationSeconds: duration ?? undefined,
        recordingUrl: params.RecordingUrl ?? undefined,
        rawPayload: params as never,
      },
      create: {
        callId: call?.id ?? null,
        twilioCallSid: callSid,
        twilioRecordingSid: recordingSid,
        recordingUrl: params.RecordingUrl ?? null,
        status,
        durationSeconds: duration,
        channels: 1,
        source: 'voicemail',
        transcriptStatus: transcribe ? 'in-progress' : null,
        rawPayload: params as never,
        startedAt: new Date(),
      },
    });
    if (!call || !userId) return;

    this.emitCallUpdate(call.id);
    this.realtime.voiceAppSync(userId, ['voicemail', 'calls']);
    if (status !== RecordingStatus.COMPLETED || (duration ?? 0) < 1) return;
    const first = await this.redis.client
      .set(VOICEMAIL_NOTIFIED_KEY(recordingSid), '1', 'EX', 24 * 60 * 60, 'NX')
      .catch(() => 'OK');
    if (first !== 'OK') return;
    if (transcribe) void this.transcribeVoicemail(recordingSid);
    const name = await this.ctx.contactName(userId, call.fromE164);
    await this.push.sendToUser(
      userId,
      {
        type: 'voicemail',
        title: `Voicemail from ${name ?? displayPhone(call.fromE164)}`,
        body: transcribe
          ? `${formatDuration(duration ?? 0)} · Transcribing…`
          : formatDuration(duration ?? 0),
        tag: `call-${callSid}`,
        url: '/voice/voicemail',
        renotify: true,
      },
      { ttl: 24 * 60 * 60, urgency: 'normal' },
    );
  }

  /** Writes the voicemail's text and updates the notification with it. Never throws. */
  async transcribeVoicemail(recordingSid: string): Promise<void> {
    let text: string | null = null;
    let ok = false;
    try {
      text = await this.transcriber.transcribe(recordingSid);
      ok = true;
    } catch (err) {
      this.logger.warn(
        `Voicemail ${recordingSid} transcription failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
    try {
      const recording = await this.prisma.callRecording.update({
        where: { twilioRecordingSid: recordingSid },
        data: { transcript: text, transcriptStatus: ok ? 'completed' : 'failed' },
        include: { call: { include: { phoneNumber: true } } },
      });
      const userId = recording.call?.phoneNumber?.userId;
      if (!userId || !recording.call) return;
      this.realtime.voiceAppSync(userId, ['voicemail']);
      if (!text) return;
      const name = await this.ctx.contactName(userId, recording.call.fromE164);
      await this.push.sendToUser(
        userId,
        {
          type: 'voicemail',
          title: `Voicemail from ${name ?? displayPhone(recording.call.fromE164)}`,
          body: text.length > 180 ? `${text.slice(0, 177)}…` : text,
          tag: `call-${recording.twilioCallSid}`,
          url: '/voice/voicemail',
          silent: true,
        },
        { ttl: 24 * 60 * 60, urgency: 'normal' },
      );
    } catch (err) {
      this.logger.warn(
        `Saving voicemail ${recordingSid} transcript failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  /** The device that opened from a notification asks the call to ring again. */
  async ringHere(userId: string, callSid: string): Promise<{ ringing: true }> {
    await this.ringingCall(userId, callSid);
    await this.redis.client.set(REDIAL_KEY(callSid), '1', 'EX', 120);
    await this.cancelLegs(callSid);
    return { ringing: true };
  }

  /** Stop ringing everywhere and send the caller to voicemail. */
  async decline(userId: string, callSid: string): Promise<{ declined: true }> {
    const call = await this.ringingCall(userId, callSid);
    await this.redis.client.del(REDIAL_KEY(callSid)).catch(() => undefined);
    // Record that this was a decision, not a call nobody got to. The caller
    // still lands in voicemail, so the recording keeps arriving as usual; only
    // answeredAt is left alone, which is what keeps this call out of the
    // missed-call badge.
    await this.prisma.call.updateMany({
      where: { id: call.id, answeredAt: null, endedAt: null },
      data: { handledBy: 'declined' },
    });
    await this.cancelLegs(callSid);
    this.realtime.voiceAppSync(userId, ['calls']);
    return { declined: true };
  }

  /** A device reports it answered, so others can say where the call went. */
  async reportAnswered(userId: string, callSid: string, deviceId: string): Promise<void> {
    const call = await this.findCall(callSid);
    if (!call || call.phoneNumber?.userId !== userId) {
      throw new NotFoundException('Call not found');
    }
    const device = await this.prisma.userDevice.findFirst({
      where: { id: deviceId, userId },
      select: { name: true },
    });
    await this.markAnswered(callSid, `app:${deviceId}`, device?.name ?? 'another device');
  }

  /** New text to a voice app user's number: notify their devices. */
  async onInboundSms(
    phoneNumber: { userId: string | null },
    message: { fromE164: string; body: string | null; numMedia: number },
  ): Promise<void> {
    const userId = phoneNumber.userId;
    if (!userId || !(await this.ctx.isVoiceUser(userId))) return;
    if (await this.ctx.isBlocked(userId, message.fromE164)) return;
    const [settings, name] = await Promise.all([
      this.ctx.settings(userId),
      this.ctx.contactName(userId, message.fromE164),
    ]);
    const body = message.body?.trim() || (message.numMedia > 0 ? 'Sent a picture' : 'New message');
    await this.push.sendToUser(
      userId,
      {
        type: 'message',
        title: name ?? displayPhone(message.fromE164),
        body: body.length > 180 ? `${body.slice(0, 177)}…` : body,
        tag: `sms-${message.fromE164}`,
        url: `/voice/messages/${encodeURIComponent(message.fromE164)}`,
        renotify: true,
        silent: doNotDisturbActive(settings),
      },
      { ttl: 24 * 60 * 60, urgency: 'high' },
    );
  }

  /** Voicemail TwiML; also the fallback when routing a voice app call fails. */
  async voicemailTwiml(userId: string | null, settings: VoiceSettings | null): Promise<string> {
    const response = new twilio.twiml.VoiceResponse();
    if (settings && !settings.voicemailEnabled) {
      response.say({ voice: VOICE }, 'The person you are calling is not available. Goodbye.');
      response.hangup();
      return response.toString();
    }

    const greeting =
      userId && settings?.greetingMode === 'recorded'
        ? await this.prisma.voicemailGreeting.findUnique({
            where: { userId },
            select: { token: true },
          })
        : null;
    if (greeting) {
      response.play(
        `${this.twilio.webhookBaseUrl}/webhooks/twilio/voice-app/greeting/${greeting.token}.wav`,
      );
    } else if (settings?.greetingMode === 'text' && settings.greetingText?.trim()) {
      response.say({ voice: VOICE }, settings.greetingText.trim());
    } else {
      response.say({ voice: VOICE }, DEFAULT_GREETING);
    }

    // Text comes from Deepgram after the recording completes (see transcribeVoicemail).
    response.record({
      action: this.webhookUrl('voicemail-done'),
      method: 'POST',
      maxLength: VOICEMAIL_MAX_SECONDS,
      timeout: 5,
      playBeep: true,
      finishOnKey: '#',
      trim: 'trim-silence',
      recordingStatusCallback: this.webhookUrl('voicemail-recording'),
      recordingStatusCallbackMethod: 'POST',
      recordingStatusCallbackEvent: ['completed', 'absent'],
    });
    return response.toString();
  }

  private async ringTwiml(input: {
    userId: string;
    settings: VoiceSettings;
    phoneNumber: PhoneNumber;
    callSid: string;
    from: string;
    callerName: string | null;
  }): Promise<string | null> {
    const { userId, settings, phoneNumber, callSid, from, callerName } = input;
    const forwards = (
      await this.prisma.forwardingNumber.findMany({
        where: { userId, enabled: true, verifiedAt: { not: null } },
        orderBy: { createdAt: 'asc' },
        take: 6,
      })
    ).filter((forwarding) => forwarding.e164 !== from);
    if (!settings.ringDevices && forwards.length === 0) return null;

    const response = new twilio.twiml.VoiceResponse();
    const dial = response.dial({
      answerOnBridge: true,
      timeout: settings.ringSeconds,
      action: this.webhookUrl('dial-complete'),
      method: 'POST',
      timeLimit: CALL_TIME_LIMIT_SECONDS,
      // Linked phones show the caller's number; a withheld one can't be passed on.
      ...(E164_RE.test(from) ? {} : { callerId: phoneNumber.phoneNumberE164 }),
    });
    if (settings.ringDevices) {
      const client = dial.client({
        statusCallback: this.webhookUrl('leg-status', { leg: 'app', parent: callSid }),
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['initiated', 'answered'],
      });
      client.identity(this.twilio.voiceIdentity(userId));
      client.parameter({ name: 'calledNumber', value: phoneNumber.phoneNumberE164 });
      client.parameter({ name: 'parentCallSid', value: callSid });
      if (callerName) client.parameter({ name: 'callerName', value: callerName });
    }
    for (const forwarding of forwards) {
      dial.number(
        {
          ...(settings.screenCalls
            ? {
                url: this.webhookUrl('screen', { fid: forwarding.id, parent: callSid }),
                method: 'POST',
              }
            : {}),
          statusCallback: this.webhookUrl('leg-status', { leg: forwarding.id, parent: callSid }),
          statusCallbackMethod: 'POST',
          statusCallbackEvent: ['initiated', 'answered'],
        },
        forwarding.e164,
      );
    }
    return response.toString();
  }

  private async markAnswered(parentSid: string, handledBy: string, where?: string): Promise<void> {
    const call = await this.findCall(parentSid);
    const userId = call?.phoneNumber?.userId;
    if (!call || !userId) return;
    // "app" from Twilio must not overwrite the device that reported itself.
    const keep = handledBy === 'app' && call.handledBy?.startsWith('app:');
    const firstAnswer = !call.answeredAt;
    const updated = await this.prisma.call.update({
      where: { id: call.id },
      data: {
        handledBy: keep ? call.handledBy : handledBy,
        answeredAt: call.answeredAt ?? new Date(),
        ...(call.status === CallStatus.INITIATED || call.status === CallStatus.RINGING
          ? { status: CallStatus.IN_PROGRESS }
          : {}),
      },
    });
    const place =
      where ?? (handledBy.startsWith('phone:') ? displayPhone(handledBy.slice(6)) : 'the app');
    this.realtime.callStatusUpdated({ numberId: updated.phoneNumberId, call: mapCall(updated) });
    this.realtime.voiceAppCallAnswered(userId, {
      callSid: parentSid,
      handledBy: updated.handledBy ?? handledBy,
      where: place,
    });
    this.realtime.voiceAppSync(userId, ['calls']);
    if (!firstAnswer) return;
    const name = await this.ctx.contactName(userId, call.fromE164);
    void this.push.sendToUser(
      userId,
      {
        type: 'call-answered',
        title: name ?? displayPhone(call.fromE164),
        body: `Answered on ${place}`,
        tag: `call-${parentSid}`,
        url: '/voice/calls',
        silent: true,
      },
      { ttl: 30, urgency: 'high' },
    );
  }

  private async notifyMissed(userId: string, call: Call, callerName: string | null): Promise<void> {
    this.realtime.voiceAppSync(userId, ['calls']);
    await this.push.sendToUser(
      userId,
      {
        type: 'missed-call',
        title: 'Missed call',
        body: callerName ?? displayPhone(call.fromE164),
        tag: `call-${call.twilioCallSid}`,
        url: '/voice/calls',
        renotify: true,
      },
      { ttl: 24 * 60 * 60, urgency: 'normal' },
    );
  }

  private async ringingCall(userId: string, callSid: string): Promise<CallWithNumber> {
    const call = await this.findCall(callSid);
    if (!call || call.phoneNumber?.userId !== userId || call.direction !== 'INBOUND') {
      throw new NotFoundException('Call not found');
    }
    if (call.answeredAt) throw new ConflictException('The call was answered on another device');
    if (call.endedAt || ENDED_STATUSES.has(call.status)) {
      throw new ConflictException('The call has ended');
    }
    return call;
  }

  /** End every leg that is still ringing (or screening) for a call. */
  private async cancelLegs(parentSid: string, exceptSid?: string): Promise<void> {
    const sids = new Set<string>(
      await this.redis.client.smembers(LEGS_KEY(parentSid)).catch(() => [] as string[]),
    );
    const statuses = new Map<string, string>();
    try {
      const children = await this.twilio.client.api.v2010
        .accounts(this.twilio.accountSid)
        .calls.list({ parentCallSid: parentSid, limit: 20 });
      for (const child of children) {
        statuses.set(child.sid, child.status);
        if (['queued', 'ringing', 'in-progress'].includes(child.status)) sids.add(child.sid);
        else sids.delete(child.sid);
      }
    } catch (err) {
      this.logger.warn(
        `Listing legs of ${parentSid} failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
    if (exceptSid) sids.delete(exceptSid);
    await Promise.all(
      [...sids].map(async (sid) => {
        const calls = this.twilio.client.api.v2010.accounts(this.twilio.accountSid).calls(sid);
        try {
          await calls.update({
            status: statuses.get(sid) === 'in-progress' ? 'completed' : 'canceled',
          });
        } catch {
          // Screening legs are in progress and can't be canceled, only ended.
          await calls.update({ status: 'completed' }).catch(() => undefined);
        }
      }),
    );
  }

  private async takeFlag(key: string): Promise<boolean> {
    try {
      const value = await this.redis.client.get(key);
      if (!value) return false;
      await this.redis.client.del(key);
      return true;
    } catch {
      return false;
    }
  }

  private findCall(callSid: string): Promise<CallWithNumber | null> {
    if (!callSid) return Promise.resolve(null);
    return this.prisma.call.findUnique({
      where: { twilioCallSid: callSid },
      include: { phoneNumber: true },
    });
  }

  private emitCallUpdate(callId: string): void {
    void this.prisma.call
      .findUnique({
        where: { id: callId },
        include: { recordings: { orderBy: { createdAt: 'desc' } } },
      })
      .then((call) => {
        if (call)
          this.realtime.callStatusUpdated({ numberId: call.phoneNumberId, call: mapCall(call) });
      })
      .catch(() => undefined);
  }

  private webhookUrl(path: string, query: Record<string, string> = {}): string {
    const qs = new URLSearchParams(query).toString();
    return `${this.twilio.webhookBaseUrl}/webhooks/twilio/voice-app/${path}${qs ? `?${qs}` : ''}`;
  }
}

function hangupTwiml(): string {
  const response = new twilio.twiml.VoiceResponse();
  response.hangup();
  return response.toString();
}

function parseSeconds(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function formatDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** "(415) 555-0100" for US numbers, E.164 otherwise. */
export function displayPhone(e164: string | null | undefined): string {
  if (!e164 || !/\d/.test(e164)) return 'Unknown caller';
  if (/^\+1\d{10}$/.test(e164)) {
    return `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`;
  }
  return e164;
}
