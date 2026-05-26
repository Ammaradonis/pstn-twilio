import { z } from 'zod';

import { normalizeDialablePhoneNumber } from '../phone';

/**
 * E.164: + followed by 1-15 digits, leading non-zero per ITU recommendation.
 */
export const e164Schema = z
  .string()
  .regex(/^\+[1-9]\d{1,14}$/, 'Must be E.164 (e.g. +14155552671)');

const dialablePhoneNumberSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  return normalizeDialablePhoneNumber(value) ?? value;
}, e164Schema);

export const isoCountrySchema = z
  .string()
  .length(2)
  .regex(/^[A-Z]{2}$/, 'Must be a 2-letter ISO 3166-1 alpha-2 country code');

export const numberTypeSchema = z.enum(['LOCAL', 'MOBILE', 'TOLL_FREE', 'UNKNOWN']);

// Query-string booleans arrive as 'true' | 'false' strings. z.coerce.boolean()
// would mis-coerce 'false' to true (Boolean('false') === true), so we preprocess.
const queryBoolean = z.preprocess((v) => {
  if (typeof v === 'string') {
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0' || v === '') return false;
  }
  return v;
}, z.boolean());

export const numberSearchSchema = z.object({
  country: isoCountrySchema,
  type: z.enum(['local', 'mobile', 'toll_free']).default('local'),
  areaCode: z
    .string()
    .regex(/^\d{3}$/, 'Area code must be exactly 3 digits')
    .optional(),
  contains: z
    .string()
    .max(20)
    .regex(/^[\dA-Z*%+$]*$/i, 'Allowed characters: digits, letters, *, %, +, $')
    .optional(),
  inRegion: z.string().max(50).optional(),
  inLocality: z.string().max(100).optional(),
  inPostalCode: z.string().max(20).optional(),
  smsEnabled: queryBoolean.optional(),
  voiceEnabled: queryBoolean.optional(),
  mmsEnabled: queryBoolean.optional(),
  excludeAddressRequired: queryBoolean.default(true),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const purchaseNumberSchema = z.object({
  phoneNumber: e164Schema,
  friendlyName: z.string().min(1).max(64).optional(),
});

export const sendMessageSchema = z.object({
  to: e164Schema,
  body: z.string().min(1).max(1600),
  mediaUrl: z.array(z.string().url()).max(10).optional(),
});

export const prepareOutboundCallSchema = z.object({
  selectedNumberId: z.string().uuid(),
  destinationNumber: dialablePhoneNumberSchema,
  callContextId: z.string().uuid().optional(),
});

export const voiceTokenRequestSchema = z.object({
  numberId: z.string().uuid().optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(256),
});

export type NumberSearchInput = z.infer<typeof numberSearchSchema>;
export type PurchaseNumberInput = z.infer<typeof purchaseNumberSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type PrepareOutboundCallInput = z.infer<typeof prepareOutboundCallSchema>;
export type VoiceTokenRequestInput = z.infer<typeof voiceTokenRequestSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
