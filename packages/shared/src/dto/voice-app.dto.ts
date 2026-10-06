// The phone-style "voice" app: one person's number with linked phones,
// voicemail, contacts, blocking and sync across their devices.

import type { CallDirection, CallStatus, MessageStatus } from '../types/index';

import type { SmsMessageDto } from './index';

// Which web app a user signs in to.
export type UserExperience = 'console' | 'voice';

// Most personal or desk phones that can ring together with the app.
export const VOICE_FORWARDING_LIMIT = 6;
// Longest voicemail greeting the app records, in milliseconds.
export const VOICE_GREETING_MAX_MS = 60_000;

export type VoiceGreetingMode = 'default' | 'text' | 'recorded';

export interface VoiceAppNumberDto {
  id: string;
  e164: string;
  friendlyName: string;
  voice: boolean;
  sms: boolean;
}

export interface VoiceSettingsDto {
  ringDevices: boolean;
  screenCalls: boolean;
  ringSeconds: number;
  doNotDisturb: boolean;
  doNotDisturbUntil: string | null;
  voicemailEnabled: boolean;
  voicemailTranscribe: boolean;
  greetingMode: VoiceGreetingMode;
  greetingText: string | null;
  recordedGreeting: { durationMs: number; updatedAt: string } | null;
}

export type ForwardingVerifyStatus = 'calling' | 'failed' | 'wrong-code';

export interface ForwardingNumberDto {
  id: string;
  e164: string;
  label: string;
  enabled: boolean;
  verified: boolean;
  verifiedAt: string | null;
  verifyStatus: ForwardingVerifyStatus | null;
  createdAt: string;
}

// The code is shown on screen; the verification call asks for it.
export interface ForwardingVerificationDto {
  forwarding: ForwardingNumberDto;
  code: string;
}

export interface BlockedNumberDto {
  id: string;
  e164: string;
  createdAt: string;
}

export interface ContactPhoneDto {
  e164: string;
  label: string | null;
}

export type ContactSource = 'manual' | 'device' | 'vcard';

export interface ContactDto {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  notes: string | null;
  starred: boolean;
  source: ContactSource;
  phones: ContactPhoneDto[];
  createdAt: string;
  updatedAt: string;
}

export interface ContactImportResultDto {
  created: number;
  updated: number;
  skipped: number;
}

export interface VoiceDeviceDto {
  id: string;
  name: string;
  platform: string | null;
  lastSeenAt: string;
  online: boolean;
  notifications: boolean;
}

// answered: picked up in the app or on a linked phone. missed: rang out with no
// voicemail. voicemail: the caller left a message. outgoing: placed by the user.
// declined: the user turned it away, so the caller went to voicemail. blocked:
// the caller is on the block list and was rejected unanswered.
export type VoiceCallKind =
  | 'answered'
  | 'missed'
  | 'voicemail'
  | 'outgoing'
  | 'declined'
  | 'blocked';

export interface VoiceVoicemailDto {
  id: string;
  callId: string;
  from: string;
  to: string;
  durationSeconds: number | null;
  transcript: string | null;
  // in-progress | completed | failed (Twilio), or null when not requested.
  transcriptStatus: string | null;
  heard: boolean;
  ready: boolean;
  createdAt: string;
}

export interface VoiceCallLogItemDto {
  id: string;
  callSid: string | null;
  numberId: string | null;
  direction: CallDirection;
  // The other party's number.
  counterpart: string;
  kind: VoiceCallKind;
  status: CallStatus;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  // "app", "app:<deviceId>" or "phone:<e164>" for answered incoming calls.
  handledBy: string | null;
  voicemail: VoiceVoicemailDto | null;
}

export interface VoiceConversationDto {
  counterpart: string;
  numberId: string;
  last: {
    id: string;
    direction: CallDirection;
    body: string;
    status: MessageStatus;
    numMedia: number;
    createdAt: string;
  };
  unread: number;
}

export interface VoiceUnreadDto {
  missedCalls: number;
  voicemail: number;
  messages: number;
}

export interface VoiceAppBootstrapDto {
  user: { id: string; email: string };
  numbers: VoiceAppNumberDto[];
  identity: string;
  settings: VoiceSettingsDto;
  forwarding: ForwardingNumberDto[];
  blocked: BlockedNumberDto[];
  unread: VoiceUnreadDto;
  // Web Push application server key, or null when push is not configured.
  pushPublicKey: string | null;
}

export interface VoiceThreadDto {
  counterpart: string;
  messages: SmsMessageDto[];
  nextCursor: string | null;
}

export type VoiceAppSyncKind =
  | 'settings'
  | 'forwarding'
  | 'blocked'
  | 'contacts'
  | 'calls'
  | 'voicemail'
  | 'messages'
  | 'read'
  | 'devices';

// Something changed on another device or on the server; refetch these.
export interface WsVoiceAppSyncEvent {
  kinds: VoiceAppSyncKind[];
}

// An incoming call was answered; other devices stop ringing and say where.
export interface WsVoiceAppCallAnsweredEvent {
  callSid: string;
  handledBy: string;
  // Device or linked phone that took the call, for "Answered on …".
  where: string;
}
