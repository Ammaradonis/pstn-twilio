import type {
  AiCallDto,
  AiCallingConfigDto,
  AiInboundMode,
  AiInboundStatusDto,
  StartAiCallInput,
  AuditLogDto,
  AvailableNumberDto,
  CallDto,
  DiagnosticReportDto,
  HealthStatusDto,
  LastDialDto,
  NumberSearchInput,
  OutboundCallAnalyticsDto,
  OutboundCallPreparationDto,
  PaginatedDto,
  PhoneNumberDto,
  PurchaseNumberInput,
  RecordingPreferenceDto,
  SendMessageInput,
  SmsMessageDto,
  UserDto,
  VoicemailDto,
  VoiceTokenDto,
} from '@pstn-twilio/shared';

import { env } from './env';

const BASE_URL = env.VITE_API_BASE_URL;
const TOKEN_STORAGE_KEY = 'pstn-twilio.token';
export const AUTH_EXPIRED_EVENT = 'pstn-twilio.auth-expired';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  if (token) {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } else {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

function handleAuthFailure(status: number): void {
  if (status !== 401) return;
  setToken(null);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
  }
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly payload?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function buildQuery(query: RequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE_URL}${path}${buildQuery(opts.query)}`, {
    method: opts.method ?? 'GET',
    credentials: 'include',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (!res.ok) {
    let payload: unknown = null;
    let message = `${opts.method ?? 'GET'} ${path} failed: ${res.status}`;
    try {
      payload = await res.json();
      const m = (payload as { message?: unknown })?.message;
      if (typeof m === 'string') message = m;
      else if (Array.isArray(m) && typeof m[0] === 'string') message = m[0];
    } catch {
      // empty/non-json body — keep default message
    }
    handleAuthFailure(res.status);
    throw new ApiError(res.status, message, payload);
  }

  if (res.status === 204) return undefined as T;
  // NestJS sends a handler's `null` as a 200 with an empty body.
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

async function requestBlob(path: string): Promise<Blob> {
  const headers: Record<string, string> = { Accept: 'audio/mpeg' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'GET',
    credentials: 'include',
    headers,
  });

  if (!res.ok) {
    let message = `GET ${path} failed: ${res.status}`;
    try {
      const payload = await res.json();
      const m = (payload as { message?: unknown })?.message;
      if (typeof m === 'string') message = m;
      else if (Array.isArray(m) && typeof m[0] === 'string') message = m[0];
    } catch {
      // empty/non-json body — keep default message
    }
    handleAuthFailure(res.status);
    throw new ApiError(res.status, message);
  }

  return res.blob();
}

export interface CountryOption {
  countryCode: string;
  country: string;
  beta: boolean;
}

export interface LoginResponse {
  token: string;
  user: UserDto;
}

export const api = {
  health: Object.assign(() => request<HealthStatusDto>('/health'), {
    db: () => request<HealthStatusDto>('/health/db'),
    redis: () => request<HealthStatusDto>('/health/redis'),
    twilio: () => request<HealthStatusDto>('/health/twilio'),
  }),

  auth: {
    login: (email: string, password: string) =>
      request<LoginResponse>('/auth/login', { method: 'POST', body: { email, password } }),
    me: () => request<UserDto>('/auth/me'),
    logout: () => request<{ message: string }>('/auth/logout', { method: 'POST' }),
    changePassword: (oldPassword: string, newPassword: string) =>
      request<{ message: string }>('/auth/change-password', {
        method: 'POST',
        body: { oldPassword, newPassword },
      }),
  },

  numbers: {
    countries: () => request<CountryOption[]>('/phone-number-options/countries'),
    search: (input: Partial<NumberSearchInput>) =>
      request<AvailableNumberDto[]>('/numbers/available', { query: input as never }),
    purchase: (input: PurchaseNumberInput) =>
      request<PhoneNumberDto>('/numbers/purchase', { method: 'POST', body: input }),
    list: () => request<PhoneNumberDto[]>('/numbers'),
    get: (id: string) => request<PhoneNumberDto>(`/numbers/${id}`),
    update: (id: string, input: { friendlyName?: string; active?: boolean }) =>
      request<PhoneNumberDto>(`/numbers/${id}`, { method: 'PATCH', body: input }),
    configureWebhooks: (id: string) =>
      request<PhoneNumberDto>(`/numbers/${id}/configure-webhooks`, { method: 'POST' }),
    sync: (id: string) => request<PhoneNumberDto>(`/numbers/${id}/sync`, { method: 'POST' }),
    release: (id: string) => request<PhoneNumberDto>(`/numbers/${id}/release`, { method: 'POST' }),
    deactivate: (id: string) =>
      request<PhoneNumberDto>(`/numbers/${id}/deactivate`, { method: 'POST' }),
  },

  messages: {
    list: (numberId: string, opts?: { cursor?: string; limit?: number }) =>
      request<PaginatedDto<SmsMessageDto>>(`/numbers/${numberId}/messages`, {
        query: { cursor: opts?.cursor, limit: opts?.limit },
      }),
    get: (numberId: string, messageId: string) =>
      request<SmsMessageDto>(`/numbers/${numberId}/messages/${messageId}`),
    send: (numberId: string, input: SendMessageInput) =>
      request<SmsMessageDto>(`/numbers/${numberId}/messages`, { method: 'POST', body: input }),
    retry: (numberId: string, messageId: string) =>
      request<SmsMessageDto>(`/numbers/${numberId}/messages/${messageId}/retry`, {
        method: 'POST',
      }),
    search: (input: {
      query?: string;
      from?: string;
      to?: string;
      direction?: 'INBOUND' | 'OUTBOUND';
      limit?: number;
    }) => request<SmsMessageDto[]>('/messages/search', { query: input }),
  },

  calls: {
    list: (
      numberId: string,
      opts?: {
        cursor?: string;
        limit?: number;
        direction?: string;
        status?: string;
        since?: string;
      },
    ) =>
      request<PaginatedDto<CallDto>>(`/numbers/${numberId}/calls`, {
        query: opts as never,
      }),
    get: (numberId: string, callId: string) =>
      request<CallDto>(`/numbers/${numberId}/calls/${callId}`),
    // Null until Twilio has picked up the call placed from this outbound intent.
    byOutboundIntent: (numberId: string, outboundIntentId: string) =>
      request<CallDto | null>(`/numbers/${numberId}/outbound-intents/${outboundIntentId}/call`),
    lastDial: (numberId: string, destination: string) =>
      request<LastDialDto | null>(`/numbers/${numberId}/last-dial`, {
        query: { destination },
      }),
    outboundAnalytics: (numberId: string, days = 30) =>
      request<OutboundCallAnalyticsDto>(`/numbers/${numberId}/calls/analytics`, {
        query: { days },
      }),
    hangup: (callId: string) => request<CallDto>(`/calls/${callId}/hangup`, { method: 'POST' }),
    recordingMedia: (numberId: string, callId: string, recordingId: string) =>
      requestBlob(`/numbers/${numberId}/calls/${callId}/recordings/${recordingId}/media`),
    addNote: (callId: string, note: string) =>
      request<{ callId: string; note: string; createdAt: string }>(`/calls/${callId}/notes`, {
        method: 'POST',
        body: { note },
      }),
  },

  voicemail: {
    list: (opts?: { cursor?: string; limit?: number }) =>
      request<PaginatedDto<VoicemailDto>>('/voicemail', {
        query: { cursor: opts?.cursor, limit: opts?.limit },
      }),
    media: (recordingId: string) => requestBlob(`/voicemail/${recordingId}/media`),
  },

  aiCalls: {
    config: () => request<AiCallingConfigDto>('/ai-calls/config'),
    list: (limit = 10) => request<AiCallDto[]>('/ai-calls', { query: { limit } }),
    get: (id: string) => request<AiCallDto>(`/ai-calls/${id}`),
    start: (input: StartAiCallInput) =>
      request<AiCallDto>('/ai-calls', { method: 'POST', body: input }),
    inbound: () => request<AiInboundStatusDto>('/ai-calls/inbound'),
    setInbound: (mode: AiInboundMode) =>
      request<AiInboundStatusDto>('/ai-calls/inbound', { method: 'PUT', body: { mode } }),
    queue: () => request<AiCallDto[]>('/ai-calls/queue'),
    removeFromQueue: (id: string) => request<void>(`/ai-calls/${id}`, { method: 'DELETE' }),
    clearQueue: () => request<{ removed: number }>('/ai-calls/queue', { method: 'DELETE' }),
    recording: (id: string) => requestBlob(`/ai-calls/${id}/recording`),
    pressKeys: (id: string, keys: string) =>
      request<{ sent: true }>(`/ai-calls/${id}/keypad`, { method: 'POST', body: { keys } }),
  },

  googleCalendar: {
    connectUrl: () => request<{ url: string }>('/integrations/google-calendar/connect-url'),
    disconnect: () => request<void>('/integrations/google-calendar', { method: 'DELETE' }),
  },

  voice: {
    recordingPreference: (numberId: string) =>
      request<RecordingPreferenceDto>(`/voice/numbers/${numberId}/recording-preference`),
    setRecordingPreference: (numberId: string, recordCall: boolean) =>
      request<RecordingPreferenceDto>(`/voice/numbers/${numberId}/recording-preference`, {
        method: 'PUT',
        body: { recordCall },
      }),
    token: (numberId?: string) =>
      request<VoiceTokenDto>('/voice/token', { method: 'POST', body: { numberId } }),
    identity: (numberId?: string) =>
      request<{ identity: string }>('/voice/identity', {
        query: numberId ? { numberId } : undefined,
      }),
    deviceConfig: () => request<Record<string, unknown>>('/voice/device-config'),
    prepareOutbound: (selectedNumberId: string, destinationNumber: string, recordCall?: boolean) =>
      request<OutboundCallPreparationDto>('/calls/prepare-outbound', {
        method: 'POST',
        body: { selectedNumberId, destinationNumber, recordCall },
      }),
  },

  diagnostics: {
    report: () => request<DiagnosticReportDto>('/diagnostics'),
    settings: () =>
      request<{
        webhooks: {
          outboundVoiceUrl: string;
          outboundVoiceFallbackUrl: string;
          voiceUrl: string;
          voiceFallbackUrl: string;
          statusCallback: string;
          smsUrl: string;
          smsFallbackUrl: string;
        };
        defaultCountry: string;
        twilioAccountSid: string;
        webhookBaseUrl: string;
      }>('/settings'),
    validateTwilio: () => request<{ status: 'ok' | 'down' }>('/settings/twilio/validate'),
    syncTwilio: () =>
      request<{ status: 'ok' | 'down' }>('/settings/twilio/sync', { method: 'POST' }),
  },

  auditLogs: {
    list: (opts?: { cursor?: string; limit?: number; action?: string; entityType?: string }) =>
      request<PaginatedDto<AuditLogDto>>('/audit-logs', {
        query: opts as never,
      }),
  },
};
