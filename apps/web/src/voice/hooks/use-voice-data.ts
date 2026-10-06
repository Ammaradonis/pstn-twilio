import {
  WS_EVENTS,
  type ContactDto,
  type VoiceAppSyncKind,
  type WsSmsEvent,
} from '@pstn-twilio/shared';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import { getSocket } from '../../lib/realtime';
import { voiceApi } from '../lib/voice-api';

export const voiceKeys = {
  all: ['voice'] as const,
  bootstrap: ['voice', 'bootstrap'] as const,
  unread: ['voice', 'unread'] as const,
  calls: ['voice', 'calls'] as const,
  // Prefix-matches voiceKeys.calls, so invalidating "calls" refreshes every
  // filter without listing them.
  callsFor: (filter: 'all' | 'missed') =>
    filter === 'all' ? (['voice', 'calls'] as const) : (['voice', 'calls', filter] as const),
  voicemail: ['voice', 'voicemail'] as const,
  conversations: ['voice', 'conversations'] as const,
  thread: (counterpart: string) => ['voice', 'thread', counterpart] as const,
  threads: ['voice', 'thread'] as const,
  contacts: ['voice', 'contacts'] as const,
  settings: ['voice', 'settings'] as const,
  forwarding: ['voice', 'forwarding'] as const,
  blocked: ['voice', 'blocked'] as const,
  devices: ['voice', 'devices'] as const,
};

export function useBootstrap() {
  return useQuery({
    queryKey: voiceKeys.bootstrap,
    queryFn: voiceApi.bootstrap,
    staleTime: 5 * 60_000,
  });
}

export function useUnread() {
  return useQuery({ queryKey: voiceKeys.unread, queryFn: voiceApi.unread, staleTime: 30_000 });
}

export function useCallLog(filter: 'all' | 'missed' = 'all') {
  return useInfiniteQuery({
    queryKey: voiceKeys.callsFor(filter),
    queryFn: ({ pageParam }) => voiceApi.calls({ cursor: pageParam, limit: 50, filter }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 30_000,
  });
}

export function useVoicemail() {
  return useInfiniteQuery({
    queryKey: voiceKeys.voicemail,
    queryFn: ({ pageParam }) => voiceApi.voicemail({ cursor: pageParam, limit: 30 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 30_000,
  });
}

export function useConversations() {
  return useQuery({
    queryKey: voiceKeys.conversations,
    queryFn: voiceApi.conversations,
    staleTime: 30_000,
  });
}

export function useThread(counterpart: string) {
  return useInfiniteQuery({
    queryKey: voiceKeys.thread(counterpart),
    queryFn: ({ pageParam }) => voiceApi.thread(counterpart, { cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(counterpart),
  });
}

export function useContacts() {
  return useQuery({
    queryKey: voiceKeys.contacts,
    queryFn: voiceApi.contacts,
    staleTime: 5 * 60_000,
  });
}

export function useSettings() {
  return useQuery({ queryKey: voiceKeys.settings, queryFn: voiceApi.settings, staleTime: 60_000 });
}

export function useForwarding() {
  return useQuery({
    queryKey: voiceKeys.forwarding,
    queryFn: voiceApi.forwarding,
    staleTime: 60_000,
  });
}

export function useBlocked() {
  return useQuery({ queryKey: voiceKeys.blocked, queryFn: voiceApi.blocked, staleTime: 60_000 });
}

export function useDevices() {
  return useQuery({ queryKey: voiceKeys.devices, queryFn: voiceApi.devices, staleTime: 30_000 });
}

/** Contacts by phone number, for showing names instead of numbers everywhere. */
export function useContactLookup(): (e164: string | null | undefined) => ContactDto | undefined {
  const { data } = useContacts();
  const byNumber = useMemo(() => {
    const map = new Map<string, ContactDto>();
    for (const contact of data ?? []) {
      for (const phone of contact.phones) if (!map.has(phone.e164)) map.set(phone.e164, contact);
    }
    return map;
  }, [data]);
  return (e164) => (e164 ? byNumber.get(e164) : undefined);
}

export function useBlockedSet(): Set<string> {
  const { data } = useBlocked();
  return useMemo(() => new Set((data ?? []).map((b) => b.e164)), [data]);
}

const SYNC_KEYS: Record<VoiceAppSyncKind, ReadonlyArray<ReadonlyArray<string>>> = {
  settings: [voiceKeys.settings],
  forwarding: [voiceKeys.forwarding],
  blocked: [voiceKeys.blocked, voiceKeys.conversations, voiceKeys.unread],
  contacts: [voiceKeys.contacts],
  calls: [voiceKeys.calls, voiceKeys.unread],
  voicemail: [voiceKeys.voicemail, voiceKeys.calls, voiceKeys.unread],
  messages: [voiceKeys.conversations, voiceKeys.threads, voiceKeys.unread],
  read: [voiceKeys.unread, voiceKeys.conversations],
  devices: [voiceKeys.devices],
};

export function invalidateKinds(queryClient: QueryClient, kinds: VoiceAppSyncKind[]): void {
  const keys = new Set<string>();
  for (const kind of kinds) {
    for (const key of SYNC_KEYS[kind] ?? []) {
      const id = JSON.stringify(key);
      if (keys.has(id)) continue;
      keys.add(id);
      void queryClient.invalidateQueries({ queryKey: [...key] });
    }
  }
}

/**
 * Keeps every device in step: server events (calls, texts, changes made on
 * another device) and pushes that reach the service worker refresh the data
 * on screen. Coming back online refreshes everything.
 */
export function useVoiceSync(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const socket = getSocket();
    const onSync = (payload: { kinds?: VoiceAppSyncKind[] }) =>
      invalidateKinds(queryClient, payload.kinds ?? []);
    const onCall = () => invalidateKinds(queryClient, ['calls']);
    const onSms = (payload: WsSmsEvent) => {
      invalidateKinds(queryClient, ['messages']);
      const other =
        payload.message.direction === 'INBOUND' ? payload.message.from : payload.message.to;
      void queryClient.invalidateQueries({ queryKey: voiceKeys.thread(other) });
    };
    let connectedOnce = socket.connected;
    const onConnect = () => {
      // After a drop, catch up on anything missed while offline.
      if (connectedOnce) void queryClient.invalidateQueries({ queryKey: voiceKeys.all });
      connectedOnce = true;
    };
    socket.on(WS_EVENTS.VOICE_APP_SYNC, onSync);
    socket.on(WS_EVENTS.CALL_STATUS_UPDATED, onCall);
    socket.on(WS_EVENTS.CALL_INBOUND_RINGING, onCall);
    socket.on(WS_EVENTS.SMS_RECEIVED, onSms);
    socket.on(WS_EVENTS.SMS_SENT, onSms);
    socket.on(WS_EVENTS.SMS_STATUS_UPDATED, onSms);
    socket.on('connect', onConnect);

    const onWorkerMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; payload?: { type?: string } } | null;
      if (data?.type !== 'voice-push') return;
      const pushType = data.payload?.type;
      if (pushType === 'message') invalidateKinds(queryClient, ['messages']);
      else if (pushType === 'voicemail') invalidateKinds(queryClient, ['voicemail']);
      else invalidateKinds(queryClient, ['calls']);
    };
    navigator.serviceWorker?.addEventListener('message', onWorkerMessage);

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void queryClient.invalidateQueries({ queryKey: voiceKeys.unread });
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      socket.off(WS_EVENTS.VOICE_APP_SYNC, onSync);
      socket.off(WS_EVENTS.CALL_STATUS_UPDATED, onCall);
      socket.off(WS_EVENTS.CALL_INBOUND_RINGING, onCall);
      socket.off(WS_EVENTS.SMS_RECEIVED, onSms);
      socket.off(WS_EVENTS.SMS_SENT, onSms);
      socket.off(WS_EVENTS.SMS_STATUS_UPDATED, onSms);
      socket.off('connect', onConnect);
      navigator.serviceWorker?.removeEventListener('message', onWorkerMessage);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [queryClient]);
}
