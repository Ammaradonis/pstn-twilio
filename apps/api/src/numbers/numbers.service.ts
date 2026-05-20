import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PhoneNumber, UserRole, WhatsAppCompatibilityStatus } from '@prisma/client';
import type {
  AvailableNumberDto,
  NumberSearchInput,
  PhoneNumberDto,
  PurchaseNumberInput,
} from '@pstn-twilio/shared';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioService } from '../twilio/twilio.service';

import {
  inferAreaCode,
  inferNumberType,
  mapAvailableNumber,
  mapPhoneNumber,
} from './numbers.mapper';

interface ActorContext {
  userId: string;
  role: UserRole;
  ipAddress?: string;
  userAgent?: string;
}

interface UpdateNumberInput {
  friendlyName?: string;
  tags?: Record<string, unknown>;
  active?: boolean;
}

@Injectable()
export class NumbersService {
  private readonly logger = new Logger(NumbersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilio: TwilioService,
    private readonly audit: AuditService,
  ) {}

  async listCountries(): Promise<Array<{ countryCode: string; country: string; beta: boolean }>> {
    const countries = await this.twilio.client.availablePhoneNumbers.list();
    return countries.map((c) => ({
      countryCode: c.countryCode,
      country: c.country,
      beta: c.beta === true,
    }));
  }

  async searchAvailable(
    actor: ActorContext,
    input: NumberSearchInput,
  ): Promise<AvailableNumberDto[]> {
    const params: Record<string, unknown> = {
      pageSize: input.pageSize,
    };
    if (input.areaCode) params.areaCode = input.areaCode;
    if (input.contains) params.contains = input.contains;
    if (input.inRegion) params.inRegion = input.inRegion;
    if (input.inLocality) params.inLocality = input.inLocality;
    if (input.inPostalCode) params.inPostalCode = input.inPostalCode;
    if (input.smsEnabled !== undefined) params.smsEnabled = input.smsEnabled;
    if (input.voiceEnabled !== undefined) params.voiceEnabled = input.voiceEnabled;
    if (input.mmsEnabled !== undefined) params.mmsEnabled = input.mmsEnabled;
    if (input.excludeAddressRequired) params.excludeAllAddressRequired = true;

    const countryResource = this.twilio.client.availablePhoneNumbers(input.country);
    let raw: Array<Record<string, unknown>>;
    try {
      if (input.type === 'mobile') {
        raw = (await countryResource.mobile.list(params as never)) as never;
      } else if (input.type === 'toll_free') {
        raw = (await countryResource.tollFree.list(params as never)) as never;
      } else {
        raw = (await countryResource.local.list(params as never)) as never;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Twilio search failed';
      this.logger.warn(`Number search failed: ${message}`);
      throw new BadRequestException({
        statusCode: 400,
        error: 'TwilioSearchError',
        message,
      });
    }

    const results = raw.map((row) => mapAvailableNumber(row as never));

    await this.prisma.numberSearch.create({
      data: {
        userId: actor.userId,
        country: input.country,
        areaCode: input.areaCode ?? null,
        contains: input.contains ?? null,
        numberType: input.type,
        requiredSms: input.smsEnabled === true,
        requiredVoice: input.voiceEnabled === true,
        resultCount: results.length,
      },
    });

    return results;
  }

  async purchase(actor: ActorContext, input: PurchaseNumberInput): Promise<PhoneNumberDto> {
    const existing = await this.prisma.phoneNumber.findUnique({
      where: { phoneNumberE164: input.phoneNumber },
    });
    if (existing) {
      throw new ConflictException(`Number ${input.phoneNumber} is already provisioned`);
    }

    const webhooks = this.twilio.defaultWebhookUrls();

    let purchased;
    try {
      purchased = await this.twilio.client.incomingPhoneNumbers.create({
        phoneNumber: input.phoneNumber,
        friendlyName: input.friendlyName,
        voiceUrl: webhooks.voiceUrl,
        voiceFallbackUrl: webhooks.voiceFallbackUrl,
        voiceMethod: 'POST',
        statusCallback: webhooks.statusCallback,
        statusCallbackMethod: 'POST',
        smsUrl: webhooks.smsUrl,
        smsFallbackUrl: webhooks.smsFallbackUrl,
        smsMethod: 'POST',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Twilio purchase failed';
      this.logger.warn(`Number purchase failed: ${message}`);
      throw new BadRequestException({
        statusCode: 400,
        error: 'TwilioPurchaseError',
        message,
      });
    }

    const accountSid = purchased.accountSid ?? this.twilio.accountSid;
    await this.prisma.twilioAccount.upsert({
      where: { accountSid },
      update: {},
      create: { accountSid, friendlyName: 'Auto-imported', isDefault: false },
    });

    const caps = (purchased.capabilities ?? {}) as Record<string, boolean | undefined>;
    const row = await this.prisma.phoneNumber.create({
      data: {
        userId: actor.userId,
        twilioAccountSid: accountSid,
        twilioIncomingPhoneNumberSid: purchased.sid,
        phoneNumberE164: purchased.phoneNumber,
        friendlyName: purchased.friendlyName ?? input.friendlyName ?? purchased.phoneNumber,
        country:
          (purchased as unknown as { isoCountry?: string }).isoCountry ??
          this.twilio.defaultCountry,
        areaCode: inferAreaCode(purchased.phoneNumber),
        numberType: inferNumberType(undefined),
        capabilitiesVoice: caps.voice === true,
        capabilitiesSms: caps.SMS === true || caps.sms === true,
        capabilitiesMms: caps.MMS === true || caps.mms === true,
        whatsappCompatibilityStatus: WhatsAppCompatibilityStatus.NOT_GUARANTEED,
        voiceWebhookUrl: webhooks.voiceUrl,
        smsWebhookUrl: webhooks.smsUrl,
        statusCallbackUrl: webhooks.statusCallback,
        active: true,
      },
    });

    await this.audit.log({
      userId: actor.userId,
      action: 'number.purchased',
      entityType: 'PhoneNumber',
      entityId: row.id,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      metadata: { phoneNumber: row.phoneNumberE164, sid: row.twilioIncomingPhoneNumberSid },
    });

    return mapPhoneNumber(row);
  }

  async list(actor: ActorContext): Promise<PhoneNumberDto[]> {
    const where = actor.role === UserRole.OWNER ? {} : { userId: actor.userId };
    const rows = await this.prisma.phoneNumber.findMany({
      where: { ...where, releasedAt: null },
      orderBy: { purchasedAt: 'desc' },
    });
    return rows.map(mapPhoneNumber);
  }

  async getById(actor: ActorContext, id: string): Promise<PhoneNumberDto> {
    const row = await this.findOwned(actor, id);
    return mapPhoneNumber(row);
  }

  async update(actor: ActorContext, id: string, input: UpdateNumberInput): Promise<PhoneNumberDto> {
    const row = await this.findOwned(actor, id);

    if (input.friendlyName && input.friendlyName !== row.friendlyName) {
      try {
        await this.twilio.client
          .incomingPhoneNumbers(row.twilioIncomingPhoneNumberSid)
          .update({ friendlyName: input.friendlyName });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Twilio update failed';
        this.logger.warn(`Number rename failed: ${message}`);
      }
    }

    const updated = await this.prisma.phoneNumber.update({
      where: { id },
      data: {
        friendlyName: input.friendlyName ?? row.friendlyName,
        tags: input.tags !== undefined ? (input.tags as never) : (row.tags as never),
        active: input.active ?? row.active,
      },
    });

    await this.audit.log({
      userId: actor.userId,
      action: 'number.updated',
      entityType: 'PhoneNumber',
      entityId: id,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      metadata: { changes: input },
    });

    return mapPhoneNumber(updated);
  }

  async configureWebhooks(actor: ActorContext, id: string): Promise<PhoneNumberDto> {
    const row = await this.findOwned(actor, id);
    const webhooks = this.twilio.defaultWebhookUrls();

    try {
      await this.twilio.client.incomingPhoneNumbers(row.twilioIncomingPhoneNumberSid).update({
        voiceUrl: webhooks.voiceUrl,
        voiceFallbackUrl: webhooks.voiceFallbackUrl,
        voiceMethod: 'POST',
        statusCallback: webhooks.statusCallback,
        statusCallbackMethod: 'POST',
        smsUrl: webhooks.smsUrl,
        smsFallbackUrl: webhooks.smsFallbackUrl,
        smsMethod: 'POST',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Twilio webhook update failed';
      throw new BadRequestException({
        statusCode: 400,
        error: 'TwilioWebhookError',
        message,
      });
    }

    const updated = await this.prisma.phoneNumber.update({
      where: { id },
      data: {
        voiceWebhookUrl: webhooks.voiceUrl,
        smsWebhookUrl: webhooks.smsUrl,
        statusCallbackUrl: webhooks.statusCallback,
      },
    });

    await this.audit.log({
      userId: actor.userId,
      action: 'number.webhooks_configured',
      entityType: 'PhoneNumber',
      entityId: id,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      metadata: webhooks,
    });

    return mapPhoneNumber(updated);
  }

  async sync(actor: ActorContext, id: string): Promise<PhoneNumberDto> {
    const row = await this.findOwned(actor, id);

    let twilioNumber;
    try {
      twilioNumber = await this.twilio.client
        .incomingPhoneNumbers(row.twilioIncomingPhoneNumberSid)
        .fetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Twilio fetch failed';
      throw new BadRequestException({
        statusCode: 400,
        error: 'TwilioSyncError',
        message,
      });
    }

    const caps = (twilioNumber.capabilities ?? {}) as Record<string, boolean | undefined>;
    const updated = await this.prisma.phoneNumber.update({
      where: { id },
      data: {
        friendlyName: twilioNumber.friendlyName ?? row.friendlyName,
        country: (twilioNumber as unknown as { isoCountry?: string }).isoCountry ?? row.country,
        capabilitiesVoice: caps.voice === true,
        capabilitiesSms: caps.SMS === true || caps.sms === true,
        capabilitiesMms: caps.MMS === true || caps.mms === true,
        voiceWebhookUrl: twilioNumber.voiceUrl ?? row.voiceWebhookUrl,
        smsWebhookUrl: twilioNumber.smsUrl ?? row.smsWebhookUrl,
        statusCallbackUrl: twilioNumber.statusCallback ?? row.statusCallbackUrl,
      },
    });

    await this.audit.log({
      userId: actor.userId,
      action: 'number.synced',
      entityType: 'PhoneNumber',
      entityId: id,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return mapPhoneNumber(updated);
  }

  async release(actor: ActorContext, id: string): Promise<PhoneNumberDto> {
    const row = await this.findOwned(actor, id);
    if (row.releasedAt) {
      throw new ConflictException('Number already released');
    }

    try {
      await this.twilio.client.incomingPhoneNumbers(row.twilioIncomingPhoneNumberSid).remove();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Twilio release failed';
      throw new BadRequestException({
        statusCode: 400,
        error: 'TwilioReleaseError',
        message,
      });
    }

    const updated = await this.prisma.phoneNumber.update({
      where: { id },
      data: { active: false, releasedAt: new Date() },
    });

    await this.audit.log({
      userId: actor.userId,
      action: 'number.released',
      entityType: 'PhoneNumber',
      entityId: id,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      metadata: { phoneNumber: row.phoneNumberE164 },
    });

    return mapPhoneNumber(updated);
  }

  async deactivate(actor: ActorContext, id: string): Promise<PhoneNumberDto> {
    const row = await this.findOwned(actor, id);
    if (!row.active) return mapPhoneNumber(row);

    const updated = await this.prisma.phoneNumber.update({
      where: { id },
      data: { active: false },
    });

    await this.audit.log({
      userId: actor.userId,
      action: 'number.deactivated',
      entityType: 'PhoneNumber',
      entityId: id,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return mapPhoneNumber(updated);
  }

  private async findOwned(actor: ActorContext, id: string): Promise<PhoneNumber> {
    const row = await this.prisma.phoneNumber.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Number ${id} not found`);
    if (actor.role !== UserRole.OWNER && row.userId !== actor.userId) {
      throw new ForbiddenException('You do not own this number');
    }
    return row;
  }
}
