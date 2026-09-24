import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import {
  normalizeDialablePhoneNumber,
  type OutboundCallPreparationDto,
  type VoiceTokenDto,
} from '@pstn-twilio/shared';
import twilio from 'twilio';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { TwilioService } from '../twilio/twilio.service';

const TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
const TOKEN_CLOCK_SKEW_SECONDS = 5 * 60;
// 5 minutes: covers slow-network Device.connect() negotiation, Twilio webhook
// latency spikes, and legitimate Twilio webhook retries without needing
// per-call intent refreshes.
const OUTBOUND_INTENT_TTL_MS = 5 * 60 * 1000;
// How long to cache a "this Twilio number is valid" result in Redis.
// 60 seconds removes the live REST call from the call hot-path while still
// detecting number deactivation within a minute.
const CALLER_ID_CACHE_TTL_SECONDS = 60;
// Cleanup interval for expired/consumed OutboundCallIntents.
// Runs every 30 minutes; deletes rows older than 24 hours to prevent the
// table from growing indefinitely.
const INTENT_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
const INTENT_CLEANUP_AGE_MS = 24 * 60 * 60 * 1000;

interface ActorContext {
  userId: string;
  role: UserRole;
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class VoiceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VoiceService.name);
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilio: TwilioService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  onModuleInit(): void {
    // Start the intent cleanup loop after a short delay so the first run does
    // not coincide with application startup DB pressure.
    this.cleanupTimer = setInterval(
      () => void this.purgeExpiredIntents(),
      INTENT_CLEANUP_INTERVAL_MS,
    );
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  private async purgeExpiredIntents(): Promise<void> {
    const cutoff = new Date(Date.now() - INTENT_CLEANUP_AGE_MS);
    try {
      const result = await this.prisma.outboundCallIntent.deleteMany({
        where: { expiresAt: { lt: cutoff } },
      });
      if (result.count > 0) {
        this.logger.log(`Purged ${result.count} expired OutboundCallIntent rows`);
      }
    } catch (err) {
      this.logger.warn(`Intent cleanup failed: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  async issueToken(actor: ActorContext, numberId?: string): Promise<VoiceTokenDto> {
    if (numberId) await this.assertOwnership(actor, numberId);
    const identity = this.twilio.voiceIdentity(actor.userId, numberId);
    await this.ensureVoiceIdentity(actor.userId, numberId, identity);

    const { token, expiresAt } = this.createVoiceAccessToken(identity);

    await this.audit.log({
      userId: actor.userId,
      action: 'voice.token_issued',
      entityType: 'VoiceIdentity',
      entityId: identity,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      metadata: numberId ? { numberId } : undefined,
    });

    return {
      token,
      identity,
      expiresAt,
    };
  }

  async getIdentity(actor: ActorContext, numberId?: string): Promise<{ identity: string }> {
    if (numberId) await this.assertOwnership(actor, numberId);
    return { identity: this.twilio.voiceIdentity(actor.userId, numberId) };
  }

  getDeviceConfig() {
    return {
      // Opus first: its forward error correction and jitter tolerance keep
      // audio from breaking up on lossy networks, where PCMU leaves gaps.
      codecPreferences: ['opus', 'pcmu'],
      edge: ['frankfurt', 'dublin', 'ashburn'],
      dscp: true,
      // Twilio Voice SDK levels are 0=trace, 1=debug, 2=info, 3=warn, 4=error.
      logLevel: 3,
      closeProtection: true,
      enableImprovedSignalingErrorPrecision: true,
      tokenRefreshMs: 60_000,
      maxCallSignalingTimeoutMs: 30_000,
    };
  }

  async prepareOutbound(
    actor: ActorContext,
    input: { selectedNumberId: string; destinationNumber: string; recordCall?: boolean },
  ): Promise<OutboundCallPreparationDto> {
    const phoneNumber = await this.assertOwnership(actor, input.selectedNumberId);
    if (!phoneNumber.capabilitiesVoice) {
      throw new BadRequestException('Selected number does not have voice capability');
    }
    if (!phoneNumber.active) {
      throw new BadRequestException('Selected number is inactive');
    }
    await this.assertTwilioCallerIdUsable(actor, phoneNumber);
    const destinationNumber = normalizeDialablePhoneNumber(input.destinationNumber);
    if (!destinationNumber) {
      throw new BadRequestException('Destination must be E.164');
    }
    const identity = this.twilio.voiceIdentity(actor.userId, phoneNumber.id);
    await this.ensureVoiceIdentity(actor.userId, phoneNumber.id, identity);
    const recordCall = input.recordCall ?? true;

    const intent = await this.prisma.outboundCallIntent.create({
      data: {
        userId: actor.userId,
        phoneNumberId: phoneNumber.id,
        identity,
        destinationE164: destinationNumber,
        selectedCallerId: phoneNumber.phoneNumberE164,
        expiresAt: new Date(Date.now() + OUTBOUND_INTENT_TTL_MS),
        recordCall,
      },
    });

    await this.audit.log({
      userId: actor.userId,
      action: 'voice.outbound_prepared',
      entityType: 'OutboundCallIntent',
      entityId: intent.id,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      metadata: {
        numberId: phoneNumber.id,
        destinationNumber,
        recordCall,
      },
    });

    return {
      outboundIntentId: intent.id,
      selectedNumberId: phoneNumber.id,
      selectedCallerId: phoneNumber.phoneNumberE164,
      destinationNumber,
      identity,
      expiresAt: intent.expiresAt.toISOString(),
      recordCall,
    };
  }

  private async assertOwnership(actor: ActorContext, numberId: string) {
    const number = await this.prisma.phoneNumber.findUnique({ where: { id: numberId } });
    if (!number) throw new NotFoundException(`Number ${numberId} not found`);
    if (actor.role !== UserRole.OWNER && number.userId !== actor.userId) {
      throw new ForbiddenException('You do not own this number');
    }
    return number;
  }

  private async assertTwilioCallerIdUsable(
    actor: ActorContext,
    phoneNumber: {
      id: string;
      twilioIncomingPhoneNumberSid: string;
      phoneNumberE164: string;
    },
  ): Promise<void> {
    // Fast path: skip the Twilio REST call for 60 seconds after a known-good
    // validation. This removes ~200 ms from every outbound call setup while
    // still detecting number deactivation within a minute.
    const cacheKey = `twilio:callerid:valid:${phoneNumber.id}`;
    try {
      const cached = await this.redis.client.get(cacheKey);
      if (cached === 'true') return;
    } catch {
      // Redis unavailable: fall through to live check.
    }

    try {
      const remote = await this.twilio.client.api.v2010
        .accounts(this.twilio.accountSid)
        .incomingPhoneNumbers(phoneNumber.twilioIncomingPhoneNumberSid)
        .fetch();
      if (remote.phoneNumber !== phoneNumber.phoneNumberE164) {
        throw new BadRequestException('Selected number no longer matches Twilio inventory');
      }

      const capabilities = (remote.capabilities ?? {}) as Record<string, boolean | undefined>;
      if (capabilities.voice !== true) {
        throw new BadRequestException('Selected number no longer has voice capability in Twilio');
      }

      // Cache the positive result. Fire-and-forget; a Redis failure here does
      // not affect the call—only the next call pays the live-check cost.
      this.redis.client
        .set(cacheKey, 'true', 'EX', CALLER_ID_CACHE_TTL_SECONDS)
        .catch(() => undefined);
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const status = (err as { status?: number; code?: number })?.status;
      const code = (err as { status?: number; code?: number })?.code;
      if (status === 404 || code === 20404) {
        // Evict any stale cache entry so the next attempt does not return a
        // false positive.
        this.redis.client.del(cacheKey).catch(() => undefined);
        await this.prisma.phoneNumber
          .update({ where: { id: phoneNumber.id }, data: { active: false } })
          .catch(() => undefined);
        await this.audit
          .log({
            userId: actor.userId,
            action: 'number.twilio_missing',
            entityType: 'PhoneNumber',
            entityId: phoneNumber.id,
            ipAddress: actor.ipAddress,
            userAgent: actor.userAgent,
            metadata: {
              phoneNumber: phoneNumber.phoneNumberE164,
              twilioIncomingPhoneNumberSid: phoneNumber.twilioIncomingPhoneNumberSid,
            },
          })
          .catch(() => undefined);
        throw new BadRequestException(
          'Selected number is no longer provisioned in Twilio. Sync Twilio numbers and choose an active number.',
        );
      }

      const message = err instanceof Error ? err.message : 'Twilio number validation failed';
      this.logger.warn(`Twilio caller ID validation failed: ${message}`);
      throw new BadRequestException(`Could not verify selected Twilio caller ID: ${message}`);
    }
  }

  private async ensureVoiceIdentity(
    userId: string,
    numberId: string | undefined,
    identity: string,
  ): Promise<void> {
    try {
      await this.prisma.voiceIdentity.upsert({
        where: { identity },
        update: {},
        create: {
          userId,
          phoneNumberId: numberId ?? null,
          identity,
          label: numberId ? `User ${userId} for number ${numberId}` : `User ${userId}`,
        },
      });
    } catch (err) {
      this.logger.debug(`Voice identity upsert race for ${identity}: ${(err as Error).message}`);
    }
  }

  private createVoiceAccessToken(identity: string): { token: string; expiresAt: string } {
    const issuedNow = Math.floor(Date.now() / 1000);
    const accessToken = new twilio.jwt.AccessToken(
      this.twilio.accountSid,
      this.twilio.apiKeySid,
      this.twilio.apiKeySecret,
      {
        identity,
        ttl: TOKEN_TTL_SECONDS,
        nbf: issuedNow - TOKEN_CLOCK_SKEW_SECONDS,
      },
    );
    accessToken.addGrant(
      new twilio.jwt.AccessToken.VoiceGrant({
        incomingAllow: true,
        outgoingApplicationSid: this.twilio.twimlAppSid,
      }),
    );

    const token = accessToken.toJwt();
    const payload = decodeJwtPart<{ exp?: number }>(token, 1);
    const exp = payload.exp ?? issuedNow + TOKEN_TTL_SECONDS;
    return {
      token,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }
}

function decodeJwtPart<T>(token: string, index: number): T {
  const part = token.split('.')[index];
  if (!part) throw new Error(`Missing JWT part ${index}`);
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
}
