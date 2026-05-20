'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.loginSchema =
  exports.voiceTokenRequestSchema =
  exports.prepareOutboundCallSchema =
  exports.sendMessageSchema =
  exports.purchaseNumberSchema =
  exports.numberSearchSchema =
  exports.numberTypeSchema =
  exports.isoCountrySchema =
  exports.e164Schema =
    void 0;
const zod_1 = require('zod');
/**
 * E.164: + followed by 1-15 digits, leading non-zero per ITU recommendation.
 */
exports.e164Schema = zod_1.z
  .string()
  .regex(/^\+[1-9]\d{1,14}$/, 'Must be E.164 (e.g. +14155552671)');
exports.isoCountrySchema = zod_1.z
  .string()
  .length(2)
  .regex(/^[A-Z]{2}$/, 'Must be a 2-letter ISO 3166-1 alpha-2 country code');
exports.numberTypeSchema = zod_1.z.enum(['LOCAL', 'MOBILE', 'TOLL_FREE', 'UNKNOWN']);
exports.numberSearchSchema = zod_1.z.object({
  country: exports.isoCountrySchema,
  type: zod_1.z.enum(['local', 'mobile', 'toll_free']).default('local'),
  areaCode: zod_1.z
    .string()
    .regex(/^\d{3}$/, 'Area code must be exactly 3 digits')
    .optional(),
  contains: zod_1.z
    .string()
    .max(20)
    .regex(/^[\dA-Z*%+$]*$/i, 'Allowed characters: digits, letters, *, %, +, $')
    .optional(),
  inRegion: zod_1.z.string().max(50).optional(),
  inLocality: zod_1.z.string().max(100).optional(),
  inPostalCode: zod_1.z.string().max(20).optional(),
  smsEnabled: zod_1.z.boolean().optional(),
  voiceEnabled: zod_1.z.boolean().optional(),
  mmsEnabled: zod_1.z.boolean().optional(),
  excludeAddressRequired: zod_1.z.boolean().default(true),
  pageSize: zod_1.z.coerce.number().int().min(1).max(50).default(20),
});
exports.purchaseNumberSchema = zod_1.z.object({
  phoneNumber: exports.e164Schema,
  friendlyName: zod_1.z.string().min(1).max(64).optional(),
});
exports.sendMessageSchema = zod_1.z.object({
  to: exports.e164Schema,
  body: zod_1.z.string().min(1).max(1600),
  mediaUrl: zod_1.z.array(zod_1.z.string().url()).max(10).optional(),
});
exports.prepareOutboundCallSchema = zod_1.z.object({
  selectedNumberId: zod_1.z.string().uuid(),
  destinationNumber: exports.e164Schema,
  callContextId: zod_1.z.string().uuid().optional(),
});
exports.voiceTokenRequestSchema = zod_1.z.object({
  numberId: zod_1.z.string().uuid().optional(),
});
exports.loginSchema = zod_1.z.object({
  email: zod_1.z.string().email(),
  password: zod_1.z.string().min(8).max(256),
});
//# sourceMappingURL=index.js.map
