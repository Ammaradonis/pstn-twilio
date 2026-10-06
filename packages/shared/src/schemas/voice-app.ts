import { z } from 'zod';

import { VOICE_GREETING_MAX_MS } from '../dto/voice-app.dto';
import { normalizeDialablePhoneNumber } from '../phone';

const e164 = z.string().regex(/^\+[1-9]\d{1,14}$/, 'Must be a phone number');

// Accepts what people type ("(415) 555-0100", "+44 20 …") and stores E.164.
export const voicePhoneNumberSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  return normalizeDialablePhoneNumber(value) ?? value.trim();
}, e164);

const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    z.string().trim().max(max).nullable().optional(),
  );

export const voiceSettingsUpdateSchema = z
  .object({
    ringDevices: z.boolean(),
    screenCalls: z.boolean(),
    ringSeconds: z.number().int().min(10).max(60),
    doNotDisturb: z.boolean(),
    doNotDisturbUntil: z.string().datetime().nullable(),
    voicemailEnabled: z.boolean(),
    voicemailTranscribe: z.boolean(),
    greetingMode: z.enum(['default', 'text', 'recorded']),
    greetingText: optionalText(500),
  })
  .partial();

export const voiceGreetingUploadSchema = z.object({
  // 8 kHz mono WAV recorded in the browser, base64 encoded.
  audioBase64: z.string().min(100).max(2_000_000),
  contentType: z.literal('audio/wav'),
  durationMs: z.number().int().min(500).max(VOICE_GREETING_MAX_MS),
});

export const forwardingCreateSchema = z.object({
  number: voicePhoneNumberSchema,
  label: z.string().trim().min(1).max(40),
});

export const forwardingUpdateSchema = z
  .object({
    label: z.string().trim().min(1).max(40),
    enabled: z.boolean(),
  })
  .partial();

export const blockNumberSchema = z.object({
  number: voicePhoneNumberSchema,
});

const contactPhoneInput = z.object({
  number: z.string().trim().min(1).max(40),
  label: z.string().trim().max(20).optional(),
});

export const contactUpsertSchema = z.object({
  name: z.string().trim().min(1).max(120),
  company: optionalText(120),
  email: optionalText(200),
  notes: optionalText(2000),
  starred: z.boolean().optional(),
  phones: z.array(contactPhoneInput).max(10).default([]),
});

export const contactImportSchema = z.object({
  source: z.enum(['device', 'vcard']),
  contacts: z
    .array(
      z.object({
        name: z.string().trim().max(120).default(''),
        company: z.string().trim().max(120).optional(),
        email: z.string().trim().max(200).optional(),
        phones: z.array(contactPhoneInput).max(10).default([]),
      }),
    )
    .max(5000),
});

export const voiceDeviceUpsertSchema = z.object({
  name: z.string().trim().min(1).max(60),
  platform: z.string().trim().max(40).optional(),
});

export const voicePushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(100),
  }),
});

export const voiceReadMarkerSchema = z.object({
  key: z.union([z.literal('calls'), z.string().regex(/^sms:\+[1-9]\d{1,14}$/)]),
});

export const voiceSendMessageSchema = z.object({
  to: voicePhoneNumberSchema,
  body: z.string().min(1).max(1600),
});

export const voiceCallAnsweredSchema = z.object({
  deviceId: z.string().min(8).max(64),
});

export type VoiceSettingsUpdateInput = z.infer<typeof voiceSettingsUpdateSchema>;
export type VoiceGreetingUploadInput = z.infer<typeof voiceGreetingUploadSchema>;
export type ForwardingCreateInput = z.infer<typeof forwardingCreateSchema>;
export type ForwardingUpdateInput = z.infer<typeof forwardingUpdateSchema>;
export type ContactUpsertInput = z.infer<typeof contactUpsertSchema>;
export type ContactImportInput = z.infer<typeof contactImportSchema>;
export type VoiceDeviceUpsertInput = z.infer<typeof voiceDeviceUpsertSchema>;
export type VoicePushSubscriptionInput = z.infer<typeof voicePushSubscriptionSchema>;
export type VoiceSendMessageInput = z.infer<typeof voiceSendMessageSchema>;
