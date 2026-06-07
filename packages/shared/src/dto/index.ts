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

export interface OutboundCallPreparationDto {
  outboundIntentId: string;
  selectedNumberId: string;
  selectedCallerId: string;
  destinationNumber: string;
  identity: string;
  expiresAt: string;
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
