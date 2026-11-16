import { z } from 'zod';

import { VOICEMAIL_DROP_MAX_MS } from '../dto/voicemail-drop.dto';

export const voicemailDropUploadSchema = z.object({
  // 8 kHz mono 16-bit WAV made in the browser, base64 encoded (~21 KB a second).
  audioBase64: z.string().min(100).max(3_000_000),
  contentType: z.literal('audio/wav'),
  durationMs: z.number().int().min(500).max(VOICEMAIL_DROP_MAX_MS),
});

export const voicemailDropCallSchema = z.object({
  // The browser's own leg of the outbound call (the parent call).
  callSid: z.string().regex(/^CA[0-9a-fA-F]{32}$/, 'Not a Twilio call SID'),
});

export type VoicemailDropUploadInput = z.infer<typeof voicemailDropUploadSchema>;
export type VoicemailDropCallInput = z.infer<typeof voicemailDropCallSchema>;
