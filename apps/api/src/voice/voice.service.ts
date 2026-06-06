import { createHmac } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { normalizeDialablePhoneNumber, type VoiceTokenDto } from '@pstn-twilio/shared';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioService } from '../twilio/twilio.service';

const TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
const TOKEN_CLOCK_SKEW_SECONDS = 5 * 60;

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
      edge: ['ashburn', 'dublin', 'singapore'],
      logLevel: 1,
      closeProtection: true,
      enableImprovedSignalingErrorPrecision: true,
      tokenRefreshMs: 60_000,
    };
  }

  async prepareOutbound(
    actor: ActorContext,
    input: { selectedNumberId: string; destinationNumber: string },
  ): Promise<{
    selectedNumberId: string;
    selectedCallerId: string;
    destinationNumber: string;
    identity: string;
  }> {
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
    return {
      selectedNumberId: phoneNumber.id,
      selectedCallerId: phoneNumber.phoneNumberE164,
      destinationNumber,
      identity: this.twilio.voiceIdentity(actor.userId, phoneNumber.id),
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
    const iat = issuedNow - TOKEN_CLOCK_SKEW_SECONDS;
    const exp = iat + TOKEN_TTL_SECONDS;
    const payload = {
      jti: `${this.twilio.apiKeySid}-${iat}`,
      grants: {
        identity,
        voice: {
          incoming: { allow: true },
          outgoing: { application_sid: this.twilio.twimlAppSid },
        },
      },
      iat,
      exp,
      iss: this.twilio.apiKeySid,
      sub: this.twilio.accountSid,
    };

    return {
      token: signHs256TwilioJwt(payload, this.twilio.apiKeySecret),
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }
}

function signHs256TwilioJwt(payload: Record<string, unknown>, secret: string): string {
  const header = {
    alg: 'HS256',
    typ: 'JWT',
    cty: 'twilio-fpa;v=1',
  };
  const encodedHeader = encodeJwtPart(header);
  const encodedPayload = encodeJwtPart(payload);
  const signature = createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function encodeJwtPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
