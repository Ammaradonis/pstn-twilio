import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
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
import { TwilioService } from '../twilio/twilio.service';

const TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
const TOKEN_CLOCK_SKEW_SECONDS = 5 * 60;
const OUTBOUND_INTENT_TTL_MS = 2 * 60 * 1000;

interface ActorContext {
  userId: string;
  role: UserRole;
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilio: TwilioService,
    private readonly audit: AuditService,
  ) {}

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
      codecPreferences: ['opus', 'pcmu'],
      edge: ['frankfurt', 'dublin', 'ashburn'],
      logLevel: 1,
      closeProtection: true,
      enableImprovedSignalingErrorPrecision: true,
      tokenRefreshMs: 60_000,
    };
  }

  async prepareOutbound(
    actor: ActorContext,
    input: { selectedNumberId: string; destinationNumber: string },
  ): Promise<OutboundCallPreparationDto> {
    const phoneNumber = await this.assertOwnership(actor, input.selectedNumberId);
    if (!phoneNumber.capabilitiesVoice) {
      throw new BadRequestException('Selected number does not have voice capability');
    }
    if (!phoneNumber.active) {
      throw new BadRequestException('Selected number is inactive');
    }
    const destinationNumber = normalizeDialablePhoneNumber(input.destinationNumber);
    if (!destinationNumber) {
      throw new BadRequestException('Destination must be E.164');
    }
    const identity = this.twilio.voiceIdentity(actor.userId, phoneNumber.id);
    await this.ensureVoiceIdentity(actor.userId, phoneNumber.id, identity);

    const intent = await this.prisma.outboundCallIntent.create({
      data: {
        userId: actor.userId,
        phoneNumberId: phoneNumber.id,
        identity,
        destinationE164: destinationNumber,
        selectedCallerId: phoneNumber.phoneNumberE164,
        expiresAt: new Date(Date.now() + OUTBOUND_INTENT_TTL_MS),
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
      },
    });

    return {
      outboundIntentId: intent.id,
      selectedNumberId: phoneNumber.id,
      selectedCallerId: phoneNumber.phoneNumberE164,
      destinationNumber,
      identity,
      expiresAt: intent.expiresAt.toISOString(),
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
