import { NumberType, type PhoneNumber } from '@prisma/client';
import type { AvailableNumberDto, PhoneNumberDto } from '@pstn-twilio/shared';

type TwilioAvailableNumber = {
  phoneNumber: string;
  friendlyName?: string | null;
  locality?: string | null;
  region?: string | null;
  postalCode?: string | null;
  isoCountry: string;
  capabilities?: { voice?: boolean; SMS?: boolean; sms?: boolean; MMS?: boolean; mms?: boolean };
  addressRequirements?: string | null;
  beta?: boolean;
};

export function mapAvailableNumber(raw: TwilioAvailableNumber): AvailableNumberDto {
  const caps = raw.capabilities ?? {};
  const addressReq = (raw.addressRequirements ?? 'none').toLowerCase();
  const normalizedAddr: AvailableNumberDto['addressRequirements'] =
    addressReq === 'any' || addressReq === 'local' || addressReq === 'foreign'
      ? (addressReq as AvailableNumberDto['addressRequirements'])
      : 'none';

  return {
    phoneNumber: raw.phoneNumber,
    friendlyName: raw.friendlyName ?? raw.phoneNumber,
    locality: raw.locality ?? null,
    region: raw.region ?? null,
    postalCode: raw.postalCode ?? null,
    isoCountry: raw.isoCountry,
    capabilities: {
      voice: caps.voice === true,
      sms: caps.SMS === true || caps.sms === true,
      mms: caps.MMS === true || caps.mms === true,
    },
    addressRequirements: normalizedAddr,
    beta: raw.beta === true,
  };
}

export function inferAreaCode(e164: string): string | null {
  if (!e164.startsWith('+1')) return null;
  const digits = e164.slice(2);
  return digits.length >= 3 ? digits.slice(0, 3) : null;
}

export function inferNumberType(searchType: string | undefined): NumberType {
  switch (searchType) {
    case 'local':
      return NumberType.LOCAL;
    case 'mobile':
      return NumberType.MOBILE;
    case 'toll_free':
      return NumberType.TOLL_FREE;
    default:
      return NumberType.UNKNOWN;
  }
}

export function mapPhoneNumber(row: PhoneNumber): PhoneNumberDto {
  return {
    id: row.id,
    phoneNumberE164: row.phoneNumberE164,
    twilioIncomingPhoneNumberSid: row.twilioIncomingPhoneNumberSid,
    friendlyName: row.friendlyName ?? row.phoneNumberE164,
    country: row.country,
    region: row.region,
    locality: row.locality,
    postalCode: row.postalCode,
    areaCode: row.areaCode,
    numberType: row.numberType,
    capabilities: {
      voice: row.capabilitiesVoice,
      sms: row.capabilitiesSms,
      mms: row.capabilitiesMms,
    },
    whatsappCompatibilityStatus: row.whatsappCompatibilityStatus,
    voiceWebhookUrl: row.voiceWebhookUrl,
    smsWebhookUrl: row.smsWebhookUrl,
    statusCallbackUrl: row.statusCallbackUrl,
    active: row.active,
    purchasedAt: row.purchasedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
