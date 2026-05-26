import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { normalizeDialablePhoneNumber, type VoiceTokenDto } from '@pstn-twilio/shared';
import twilio from 'twilio';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioService } from '../twilio/twilio.service';

const TOKEN_TTL_SECONDS = 60 * 60; // 1 hour

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

    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const accessToken = new AccessToken(
      this.twilio.accountSid,
      this.twilio.apiKeySid,
      this.twilio.apiKeySecret,
      { identity, ttl: TOKEN_TTL_SECONDS },
    );
    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: this.twilio.twimlAppSid,
      incomingAllow: true,
    });
    accessToken.addGrant(voiceGrant);

    const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString();

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
      token: accessToken.toJwt(),
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
}
