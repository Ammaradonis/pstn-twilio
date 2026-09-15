import type {
  CallDirection,
  CallStatus,
  MessageDirection,
  MessageStatus,
  NumberType,
  PhoneNumberCapabilities,
  RecordingStatus,
  UserRole,
  WhatsAppCompatibilityStatus,
} from '../types/index';

export interface UserDto {
  id: string;
  email: string;
  role: UserRole;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AvailableNumberDto {
  phoneNumber: string;
  friendlyName: string;
  locality: string | null;
  region: string | null;
  postalCode: string | null;
  isoCountry: string;
  capabilities: PhoneNumberCapabilities;
  addressRequirements: 'none' | 'any' | 'local' | 'foreign';
  beta: boolean;
}

export interface PhoneNumberDto {
  id: string;
  phoneNumberE164: string;
  twilioIncomingPhoneNumberSid: string;
  friendlyName: string;
  country: string | null;
  region: string | null;
  locality: string | null;
  postalCode: string | null;
  areaCode: string | null;
  numberType: NumberType;
  capabilities: PhoneNumberCapabilities;
  whatsappCompatibilityStatus: WhatsAppCompatibilityStatus;
  voiceWebhookUrl: string | null;
  smsWebhookUrl: string | null;
  statusCallbackUrl: string | null;
  active: boolean;
  purchasedAt: string;
  updatedAt: string;
}

export interface SmsMessageDto {
  id: string;
  phoneNumberId: string;
  twilioMessageSid: string | null;
  direction: MessageDirection;
  from: string;
  to: string;
  body: string;
  status: MessageStatus;
  errorCode: string | null;
  errorMessage: string | null;
  numMedia: number;
  mediaUrls: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CallDto {
  id: string;
  phoneNumberId: string | null;
  twilioCallSid: string | null;
  direction: CallDirection;
  from: string;
  to: string;
  selectedCallerId: string | null;
  destination: string | null;
  status: CallStatus;
  durationSeconds: number | null;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  recordings: CallRecordingDto[];
}

export interface LastDialDto {
  callId: string;
  destinationNumber: string;
  lastDialedAt: string;
}

export interface CallRecordingDto {
  id: string;
  twilioCallSid: string;
  twilioRecordingSid: string;
  recordingUrl: string | null;
  status: RecordingStatus;
  durationSeconds: number | null;
  channels: number | null;
  source: string | null;
  track: string | null;
  startedAt: string | null;
  createdAt: string;
}

export interface VoicemailDto {
  id: string;
  callId: string;
  phoneNumberId: string;
  phoneNumberE164: string;
  phoneNumberFriendlyName: string | null;
  twilioCallSid: string;
  twilioRecordingSid: string;
  from: string;
  to: string;
  status: RecordingStatus;
  durationSeconds: number | null;
  startedAt: string | null;
  createdAt: string;
}

export interface VoiceTokenDto {
  token: string;
  identity: string;
  expiresAt: string;
}

// WAITING: in the app's queue, not yet sent to Vapi.
export type AiCallStatus =
  | 'WAITING'
  | 'QUEUED'
  | 'RINGING'
  | 'IN_PROGRESS'
  | 'FORWARDING'
  | 'ENDED'
  | 'FAILED';

// Most schools that can wait in the AI call queue at once.
export const AI_CALL_QUEUE_LIMIT = 100;

export type AiCallOutcome =
  | 'booked'
  | 'callback'
  | 'not_interested'
  | 'gatekeeper'
  | 'voicemail'
  | 'no_answer'
  | 'do_not_call'
  | 'failed'
  | 'other';

export interface AiCallDto {
  id: string;
  direction: 'OUTBOUND' | 'INBOUND';
  vapiCallId: string | null;
  customerNumber: string;
  stateCode: string;
  timeZone: string;
  status: AiCallStatus;
  outcome: AiCallOutcome | null;
  endedReason: string | null;
  summary: string | null;
  schoolName: string | null;
  contactName: string | null;
  contactEmail: string | null;
  consultStartAt: string | null;
  consultMeetUrl: string | null;
  callbackTime: string | null;
  // Download through GET /ai-calls/:id/recording; Vapi's storage links are private.
  hasRecording: boolean;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

// Incoming calls to the AI caller line: answered by the agent, or blocked
// with a busy signal. "other" means Twilio points somewhere else.
export type AiInboundMode = 'agent' | 'blocked';

export interface AiInboundStatusDto {
  phoneNumber: string;
  mode: AiInboundMode | 'other';
}

export interface AiCallingConfigDto {
  // Everything needed to place a call is configured.
  ready: boolean;
  // Human-readable setup steps still outstanding.
  missing: string[];
  callerNumber: string | null;
  defaultStateCode: string;
  consultMinutes: number;
  calendar: {
    connected: boolean;
    email: string | null;
  };
}

export interface OutboundCallPreparationDto {
  outboundIntentId: string;
  selectedNumberId: string;
  selectedCallerId: string;
  destinationNumber: string;
  identity: string;
  expiresAt: string;
  recordCall: boolean;
}

export interface HealthStatusDto {
  status: 'ok' | 'degraded' | 'down';
  checks: Record<string, { status: 'ok' | 'down'; message?: string }>;
  uptimeSeconds: number;
  timestamp: string;
}

export interface ApiErrorDto {
  statusCode: number;
  error: string;
  message: string;
  requestId?: string;
}

export interface PaginatedDto<T> {
  items: T[];
  nextCursor: string | null;
}

export interface AuditLogDto {
  id: string;
  userId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface DiagnosticCheckDto {
  status: 'ok' | 'down' | 'degraded';
  message?: string;
  durationMs?: number;
}

export interface DiagnosticReportDto {
  startedAt: string;
  uptimeSeconds: number;
  app: { name: string; version: string };
  environment: {
    nodeEnv: string;
    publicBaseUrl: string | null;
    webhookBaseUrl: string | null;
    webhookBaseIsHttps: boolean;
    corsOrigins: string[];
    defaultCountry: string | null;
  };
  checks: {
    api: DiagnosticCheckDto;
    db: DiagnosticCheckDto;
    redis: DiagnosticCheckDto;
    twilio: DiagnosticCheckDto;
  };
  webhooks: {
    total: number;
    last: {
      eventType: string;
      twilioSid: string | null;
      signatureValid: boolean;
      processedAt: string | null;
      createdAt: string;
    } | null;
    lastError: {
      eventType: string;
      twilioSid: string | null;
      createdAt: string;
    } | null;
  };
  overallStatus: 'ok' | 'down' | 'degraded';
}
