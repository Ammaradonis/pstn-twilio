import { createHash, randomBytes, randomInt } from 'crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  VOICE_FORWARDING_LIMIT,
  type BlockedNumberDto,
  type ForwardingCreateInput,
  type ForwardingNumberDto,
  type ForwardingUpdateInput,
  type ForwardingVerificationDto,
  type VoiceGreetingUploadInput,
  type VoiceSettingsDto,
  type VoiceSettingsUpdateInput,
} from '@pstn-twilio/shared';
import twilio from 'twilio';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TwilioService } from '../twilio/twilio.service';

import {
  VoiceAppContext,
  mapBlocked,
  mapForwarding,
  mapVoiceSettings,
  type VoiceActor,
} from './voice-app.context';

const VOICE = 'Polly.Joanna';
const VERIFY_CODE_TTL_MS = 10 * 60_000;
const VERIFY_MAX_ATTEMPTS = 3;
const MAX_GREETING_BYTES = 1_500_000;

@Injectable()
export class VoiceAppSettingsService {
  private readonly logger = new Logger(VoiceAppSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilio: TwilioService,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
    private readonly ctx: VoiceAppContext,
  ) {}

  async getSettings(userId: string): Promise<VoiceSettingsDto> {
    const [settings, greeting] = await Promise.all([
      this.ctx.settings(userId),
      this.prisma.voicemailGreeting.findUnique({
        where: { userId },
        select: { durationMs: true, updatedAt: true },
      }),
    ]);
    return mapVoiceSettings(settings, greeting);
  }

  async updateSettings(
    actor: VoiceActor,
    input: VoiceSettingsUpdateInput,
  ): Promise<VoiceSettingsDto> {
    await this.ctx.settings(actor.userId);
    const data: Prisma.VoiceSettingsUpdateInput = { ...input } as Prisma.VoiceSettingsUpdateInput;
    if (input.doNotDisturbUntil !== undefined) {
      data.doNotDisturbUntil = input.doNotDisturbUntil ? new Date(input.doNotDisturbUntil) : null;
    }
    if (input.doNotDisturb === false) data.doNotDisturbUntil = null;
    if (input.greetingMode === 'recorded') {
      const greeting = await this.prisma.voicemailGreeting.findUnique({
        where: { userId: actor.userId },
        select: { userId: true },
      });
      if (!greeting) throw new BadRequestException('Record a greeting first.');
    }
    await this.prisma.voiceSettings.update({ where: { userId: actor.userId }, data });
    this.realtime.voiceAppSync(actor.userId, ['settings']);
    return this.getSettings(actor.userId);
  }

  async saveGreeting(
    actor: VoiceActor,
    input: VoiceGreetingUploadInput,
  ): Promise<VoiceSettingsDto> {
    const audio = Buffer.from(input.audioBase64, 'base64');
    if (audio.length > MAX_GREETING_BYTES)
      throw new BadRequestException('The greeting is too long.');
    if (
      audio.length < 44 ||
      audio.toString('ascii', 0, 4) !== 'RIFF' ||
      audio.toString('ascii', 8, 12) !== 'WAVE'
    ) {
      throw new BadRequestException('The greeting must be a WAV recording.');
    }
    // A new token per recording, so Twilio never plays a cached older greeting.
    const token = randomBytes(24).toString('base64url');
    await this.prisma.voicemailGreeting.upsert({
      where: { userId: actor.userId },
      update: { audio, contentType: input.contentType, durationMs: input.durationMs, token },
      create: {
        userId: actor.userId,
        audio,
        contentType: input.contentType,
        durationMs: input.durationMs,
        token,
      },
    });
    await this.ctx.settings(actor.userId);
    await this.prisma.voiceSettings.update({
      where: { userId: actor.userId },
      data: { greetingMode: 'recorded' },
    });
    this.realtime.voiceAppSync(actor.userId, ['settings']);
    return this.getSettings(actor.userId);
  }

  async deleteGreeting(actor: VoiceActor): Promise<VoiceSettingsDto> {
    await this.prisma.voicemailGreeting.deleteMany({ where: { userId: actor.userId } });
    const settings = await this.ctx.settings(actor.userId);
    if (settings.greetingMode === 'recorded') {
      await this.prisma.voiceSettings.update({
        where: { userId: actor.userId },
        data: { greetingMode: 'default' },
      });
    }
    this.realtime.voiceAppSync(actor.userId, ['settings']);
    return this.getSettings(actor.userId);
  }

  async greetingAudio(userId: string): Promise<{ audio: Buffer; contentType: string }> {
    const greeting = await this.prisma.voicemailGreeting.findUnique({ where: { userId } });
    if (!greeting) throw new NotFoundException('No recorded greeting');
    return { audio: Buffer.from(greeting.audio), contentType: greeting.contentType };
  }

  /** For Twilio <Play>; the token is the only credential. */
  async greetingByToken(token: string): Promise<{ audio: Buffer; contentType: string }> {
    const clean = token.replace(/\.wav$/, '');
    const greeting = await this.prisma.voicemailGreeting.findUnique({ where: { token: clean } });
    if (!greeting) throw new NotFoundException();
    return { audio: Buffer.from(greeting.audio), contentType: greeting.contentType };
  }

  async listBlocked(userId: string): Promise<BlockedNumberDto[]> {
    const rows = await this.prisma.blockedNumber.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(mapBlocked);
  }

  async block(actor: VoiceActor, e164: string): Promise<BlockedNumberDto> {
    const own = await this.ctx.numbers(actor.userId);
    if (own.some((n) => n.phoneNumberE164 === e164)) {
      throw new BadRequestException("You can't block your own number.");
    }
    const row = await this.prisma.blockedNumber.upsert({
      where: { userId_e164: { userId: actor.userId, e164 } },
      update: {},
      create: { userId: actor.userId, e164 },
    });
    await this.audit.log({
      userId: actor.userId,
      action: 'voice.number_blocked',
      entityType: 'BlockedNumber',
      entityId: row.id,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      metadata: { e164 },
    });
    this.realtime.voiceAppSync(actor.userId, ['blocked', 'messages', 'calls']);
    return mapBlocked(row);
  }

  async unblock(actor: VoiceActor, e164: string): Promise<void> {
    await this.prisma.blockedNumber.deleteMany({ where: { userId: actor.userId, e164 } });
    this.realtime.voiceAppSync(actor.userId, ['blocked', 'messages', 'calls']);
  }

  async listForwarding(userId: string): Promise<ForwardingNumberDto[]> {
    const rows = await this.prisma.forwardingNumber.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(mapForwarding);
  }

  async addForwarding(
    actor: VoiceActor,
    input: ForwardingCreateInput,
  ): Promise<ForwardingNumberDto> {
    const own = await this.ctx.numbers(actor.userId);
    if (own.some((n) => n.phoneNumberE164 === input.number)) {
      throw new BadRequestException('Link a different phone, not your own number.');
    }
    const count = await this.prisma.forwardingNumber.count({ where: { userId: actor.userId } });
    if (count >= VOICE_FORWARDING_LIMIT) {
      throw new ConflictException(`You can link up to ${VOICE_FORWARDING_LIMIT} phones.`);
    }
    try {
      const row = await this.prisma.forwardingNumber.create({
        data: { userId: actor.userId, e164: input.number, label: input.label, enabled: false },
      });
      this.realtime.voiceAppSync(actor.userId, ['forwarding']);
      return mapForwarding(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('That phone is already linked.');
      }
      throw err;
    }
  }

  async updateForwarding(
    actor: VoiceActor,
    id: string,
    input: ForwardingUpdateInput,
  ): Promise<ForwardingNumberDto> {
    const row = await this.ownForwarding(actor.userId, id);
    if (input.enabled && !row.verifiedAt) {
      throw new BadRequestException('Verify this phone before it can ring.');
    }
    const updated = await this.prisma.forwardingNumber.update({
      where: { id },
      data: { label: input.label, enabled: input.enabled },
    });
    this.realtime.voiceAppSync(actor.userId, ['forwarding']);
    return mapForwarding(updated);
  }

  async removeForwarding(actor: VoiceActor, id: string): Promise<void> {
    await this.ownForwarding(actor.userId, id);
    await this.prisma.forwardingNumber.delete({ where: { id } });
    this.realtime.voiceAppSync(actor.userId, ['forwarding']);
  }

  /** Calls the linked phone, which asks for the 2-digit code shown on screen. */
  async startVerification(actor: VoiceActor, id: string): Promise<ForwardingVerificationDto> {
    const row = await this.ownForwarding(actor.userId, id);
    const from = await this.ctx.primaryNumber(actor.userId, 'voice');
    const code = String(randomInt(10, 100));
    const base = this.twilio.webhookBaseUrl;
    await this.prisma.forwardingNumber.update({
      where: { id },
      data: {
        verifyCodeHash: hashCode(id, code),
        verifyExpiresAt: new Date(Date.now() + VERIFY_CODE_TTL_MS),
        verifyStatus: 'calling',
        verifyCallSid: null,
      },
    });
    let callSid: string;
    try {
      const call = await this.twilio.client.api.v2010
        .accounts(this.twilio.accountSid)
        .calls.create({
          to: row.e164,
          from: from.phoneNumberE164,
          url: `${base}/webhooks/twilio/voice-app/verify?fid=${id}&attempt=1`,
          method: 'POST',
          statusCallback: `${base}/webhooks/twilio/voice-app/verify-status?fid=${id}`,
          statusCallbackMethod: 'POST',
          statusCallbackEvent: ['completed'],
          timeout: 30,
        });
      callSid = call.sid;
    } catch (err) {
      await this.prisma.forwardingNumber.update({
        where: { id },
        data: { verifyStatus: 'failed', verifyCodeHash: null },
      });
      this.realtime.voiceAppSync(actor.userId, ['forwarding']);
      const message = err instanceof Error ? err.message : 'unknown';
      this.logger.warn(`Verification call to ${row.e164} failed: ${message}`);
      throw new BadRequestException(`Couldn't call that phone: ${message}`);
    }
    const updated = await this.prisma.forwardingNumber.update({
      where: { id },
      data: { verifyCallSid: callSid },
    });
    await this.audit.log({
      userId: actor.userId,
      action: 'voice.forwarding_verification_started',
      entityType: 'ForwardingNumber',
      entityId: id,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      metadata: { e164: row.e164, callSid },
    });
    this.realtime.voiceAppSync(actor.userId, ['forwarding']);
    return { forwarding: mapForwarding(updated), code };
  }

  /** The verification call was answered: ask for the code. */
  async verifyPromptTwiml(id: string, attempt: number): Promise<string> {
    const row = await this.prisma.forwardingNumber.findUnique({ where: { id } });
    const response = new twilio.twiml.VoiceResponse();
    if (!row?.verifyCodeHash || !row.verifyExpiresAt || row.verifyExpiresAt < new Date()) {
      response.say(
        { voice: VOICE },
        'This verification has expired. Please start again in the app. Goodbye.',
      );
      response.hangup();
      return response.toString();
    }
    const gather = response.gather({
      numDigits: 2,
      timeout: 10,
      action: `${this.twilio.webhookBaseUrl}/webhooks/twilio/voice-app/verify-check?fid=${id}&attempt=${attempt}`,
      method: 'POST',
    });
    gather.say(
      { voice: VOICE },
      attempt === 1
        ? 'Hello. This call links this phone to your Voice number. Enter the 2 digit code shown on your screen.'
        : 'Enter the 2 digit code shown on your screen.',
    );
    response.say({ voice: VOICE }, "We didn't get a code. Goodbye.");
    response.hangup();
    return response.toString();
  }

  async verifyCheckTwiml(id: string, attempt: number, digits: string | undefined): Promise<string> {
    const row = await this.prisma.forwardingNumber.findUnique({ where: { id } });
    const response = new twilio.twiml.VoiceResponse();
    if (!row?.verifyCodeHash || !row.verifyExpiresAt || row.verifyExpiresAt < new Date()) {
      response.say({ voice: VOICE }, 'This verification has expired. Goodbye.');
      response.hangup();
      return response.toString();
    }
    if (digits && hashCode(id, digits) === row.verifyCodeHash) {
      await this.prisma.forwardingNumber.update({
        where: { id },
        data: {
          verifiedAt: new Date(),
          enabled: true,
          verifyStatus: null,
          verifyCodeHash: null,
          verifyExpiresAt: null,
        },
      });
      this.realtime.voiceAppSync(row.userId, ['forwarding']);
      response.say(
        { voice: VOICE },
        'Thanks. This phone is now linked and will ring for your calls. Goodbye.',
      );
      response.hangup();
      return response.toString();
    }
    if (attempt >= VERIFY_MAX_ATTEMPTS) {
      await this.prisma.forwardingNumber.update({
        where: { id },
        data: { verifyStatus: 'wrong-code', verifyCodeHash: null },
      });
      this.realtime.voiceAppSync(row.userId, ['forwarding']);
      response.say(
        { voice: VOICE },
        "That code wasn't right. Please start again in the app. Goodbye.",
      );
      response.hangup();
      return response.toString();
    }
    response.say({ voice: VOICE }, "That code wasn't right.");
    response.redirect(
      { method: 'POST' },
      `${this.twilio.webhookBaseUrl}/webhooks/twilio/voice-app/verify?fid=${id}&attempt=${attempt + 1}`,
    );
    return response.toString();
  }

  /** The verification call ended; flag it if the phone still isn't verified. */
  async verifyCallEnded(id: string, callSid: string | undefined): Promise<void> {
    const row = await this.prisma.forwardingNumber.findUnique({ where: { id } });
    if (!row || row.verifiedAt || row.verifyStatus !== 'calling') return;
    if (callSid && row.verifyCallSid && row.verifyCallSid !== callSid) return;
    await this.prisma.forwardingNumber.update({
      where: { id },
      data: { verifyStatus: 'failed', verifyCodeHash: null },
    });
    this.realtime.voiceAppSync(row.userId, ['forwarding']);
  }

  private async ownForwarding(userId: string, id: string) {
    const row = await this.prisma.forwardingNumber.findUnique({ where: { id } });
    if (!row || row.userId !== userId) throw new NotFoundException('Linked phone not found');
    return row;
  }
}

function hashCode(id: string, code: string): string {
  return createHash('sha256').update(`${id}:${code}`).digest('hex');
}
