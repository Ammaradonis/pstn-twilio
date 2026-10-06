import type {
  BlockedNumberDto,
  ContactDto,
  ContactImportResultDto,
  ForwardingNumberDto,
  ForwardingVerificationDto,
  PaginatedDto,
  SmsMessageDto,
  VoiceAppBootstrapDto,
  VoiceCallLogItemDto,
  VoiceConversationDto,
  VoiceDeviceDto,
  VoiceSettingsDto,
  VoiceThreadDto,
  VoiceUnreadDto,
  VoiceVoicemailDto,
} from '@pstn-twilio/shared';

import { request, requestBlob } from '../../lib/api-client';

export interface ContactInput {
  name: string;
  company?: string | null;
  email?: string | null;
  notes?: string | null;
  starred?: boolean;
  phones: Array<{ number: string; label?: string }>;
}

export type ContactImportItem = {
  name: string;
  company?: string;
  email?: string;
  phones: Array<{ number: string; label?: string }>;
};

const enc = encodeURIComponent;

export const voiceApi = {
  bootstrap: () => request<VoiceAppBootstrapDto>('/voice-app/bootstrap'),
  unread: () => request<VoiceUnreadDto>('/voice-app/unread'),
  markRead: (key: string) => request<void>('/voice-app/read', { method: 'POST', body: { key } }),

  calls: (opts: { cursor?: string; filter?: 'all' | 'missed'; limit?: number } = {}) =>
    request<PaginatedDto<VoiceCallLogItemDto>>('/voice-app/calls', { query: opts }),
  ringHere: (callSid: string) =>
    request<{ ringing: true }>(`/voice-app/calls/${enc(callSid)}/ring-here`, { method: 'POST' }),
  decline: (callSid: string) =>
    request<{ declined: true }>(`/voice-app/calls/${enc(callSid)}/decline`, { method: 'POST' }),
  answered: (callSid: string, deviceId: string) =>
    request<void>(`/voice-app/calls/${enc(callSid)}/answered`, {
      method: 'POST',
      body: { deviceId },
    }),

  voicemail: (opts: { cursor?: string; limit?: number } = {}) =>
    request<PaginatedDto<VoiceVoicemailDto>>('/voice-app/voicemail', { query: opts }),
  voicemailAudio: (id: string) => requestBlob(`/voice-app/voicemail/${enc(id)}/media`),
  voicemailHeard: (id: string) =>
    request<void>(`/voice-app/voicemail/${enc(id)}/heard`, { method: 'POST' }),

  conversations: () => request<VoiceConversationDto[]>('/voice-app/conversations'),
  thread: (counterpart: string, opts: { cursor?: string; limit?: number } = {}) =>
    request<VoiceThreadDto>(`/voice-app/conversations/${enc(counterpart)}`, { query: opts }),
  send: (to: string, body: string) =>
    request<SmsMessageDto>('/voice-app/messages', { method: 'POST', body: { to, body } }),

  settings: () => request<VoiceSettingsDto>('/voice-app/settings'),
  updateSettings: (patch: Partial<Omit<VoiceSettingsDto, 'recordedGreeting'>>) =>
    request<VoiceSettingsDto>('/voice-app/settings', { method: 'PATCH', body: patch }),
  saveGreeting: (audioBase64: string, durationMs: number) =>
    request<VoiceSettingsDto>('/voice-app/settings/greeting', {
      method: 'PUT',
      body: { audioBase64, contentType: 'audio/wav', durationMs },
      timeoutMs: 30_000,
    }),
  deleteGreeting: () =>
    request<VoiceSettingsDto>('/voice-app/settings/greeting', { method: 'DELETE' }),
  greetingAudio: () => requestBlob('/voice-app/settings/greeting/audio'),

  blocked: () => request<BlockedNumberDto[]>('/voice-app/blocked'),
  block: (number: string) =>
    request<BlockedNumberDto>('/voice-app/blocked', { method: 'POST', body: { number } }),
  unblock: (number: string) =>
    request<void>(`/voice-app/blocked/${enc(number)}`, { method: 'DELETE' }),

  forwarding: () => request<ForwardingNumberDto[]>('/voice-app/forwarding'),
  addForwarding: (number: string, label: string) =>
    request<ForwardingNumberDto>('/voice-app/forwarding', {
      method: 'POST',
      body: { number, label },
    }),
  updateForwarding: (id: string, patch: { label?: string; enabled?: boolean }) =>
    request<ForwardingNumberDto>(`/voice-app/forwarding/${enc(id)}`, {
      method: 'PATCH',
      body: patch,
    }),
  removeForwarding: (id: string) =>
    request<void>(`/voice-app/forwarding/${enc(id)}`, { method: 'DELETE' }),
  verifyForwarding: (id: string) =>
    request<ForwardingVerificationDto>(`/voice-app/forwarding/${enc(id)}/verify`, {
      method: 'POST',
      timeoutMs: 20_000,
    }),

  contacts: () => request<ContactDto[]>('/voice-app/contacts'),
  createContact: (input: ContactInput) =>
    request<ContactDto>('/voice-app/contacts', { method: 'POST', body: input }),
  updateContact: (id: string, input: ContactInput) =>
    request<ContactDto>(`/voice-app/contacts/${enc(id)}`, { method: 'PUT', body: input }),
  deleteContact: (id: string) =>
    request<void>(`/voice-app/contacts/${enc(id)}`, { method: 'DELETE' }),
  importContacts: (source: 'device' | 'vcard', contacts: ContactImportItem[]) =>
    request<ContactImportResultDto>('/voice-app/contacts/import', {
      method: 'POST',
      body: { source, contacts },
      timeoutMs: 60_000,
    }),

  devices: () => request<VoiceDeviceDto[]>('/voice-app/devices'),
  checkIn: (id: string, name: string, platform: string) =>
    request<void>(`/voice-app/devices/${enc(id)}`, { method: 'PUT', body: { name, platform } }),
  renameDevice: (id: string, name: string) =>
    request<void>(`/voice-app/devices/${enc(id)}`, { method: 'PATCH', body: { name } }),
  removeDevice: (id: string) =>
    request<void>(`/voice-app/devices/${enc(id)}`, { method: 'DELETE' }),
  subscribePush: (id: string, subscription: PushSubscriptionJSON) =>
    request<void>(`/voice-app/devices/${enc(id)}/push`, {
      method: 'PUT',
      body: { endpoint: subscription.endpoint, keys: subscription.keys },
    }),
  unsubscribePush: (id: string) =>
    request<void>(`/voice-app/devices/${enc(id)}/push`, { method: 'DELETE' }),
};
