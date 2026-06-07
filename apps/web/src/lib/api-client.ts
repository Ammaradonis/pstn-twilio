import type {
  AuditLogDto,
  AvailableNumberDto,
  CallDto,
  DiagnosticReportDto,
  HealthStatusDto,
  NumberSearchInput,
  PaginatedDto,
  PhoneNumberDto,
  PurchaseNumberInput,
  SendMessageInput,
  SmsMessageDto,
  UserDto,
  VoicemailDto,
  VoiceTokenDto,
} from '@pstn-twilio/shared';

import { env } from './env';

const BASE_URL = env.VITE_API_BASE_URL;
const TOKEN_STORAGE_KEY = 'pstn-twilio.token';

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

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
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
    throw new ApiError(res.status, message, payload);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
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

  voice: {
    token: (numberId?: string) =>
      request<VoiceTokenDto>('/voice/token', { method: 'POST', body: { numberId } }),
    identity: (numberId?: string) =>
      request<{ identity: string }>('/voice/identity', {
        query: numberId ? { numberId } : undefined,
      }),
    deviceConfig: () => request<Record<string, unknown>>('/voice/device-config'),
    prepareOutbound: (selectedNumberId: string, destinationNumber: string) =>
      request<{
        selectedNumberId: string;
        selectedCallerId: string;
        destinationNumber: string;
        identity: string;
      }>('/calls/prepare-outbound', {
        method: 'POST',
        body: { selectedNumberId, destinationNumber },
      }),
  },

  diagnostics: {
    report: () => request<DiagnosticReportDto>('/diagnostics'),
    settings: () =>
      request<{
        webhooks: {
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
