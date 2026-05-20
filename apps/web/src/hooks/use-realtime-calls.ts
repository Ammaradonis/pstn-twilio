import type { CallDto, PaginatedDto, WsCallEvent } from '@pstn-twilio/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { getSocket } from '../lib/realtime';

const CALL_EVENTS = ['call.inbound.ringing', 'call.status.updated'] as const;

export function useRealtimeCalls(numberId: string | undefined): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!numberId) return;
    const socket = getSocket();

    function handleCall(payload: WsCallEvent) {
      if (payload.numberId !== numberId) return;
      queryClient.setQueryData<PaginatedDto<CallDto>>(['calls', numberId], (prev) => {
        if (!prev) return prev;
        const idx = prev.items.findIndex((c) => c.id === payload.call.id);
        if (idx >= 0) {
          const items = [...prev.items];
          items[idx] = payload.call;
          return { ...prev, items };
        }
        return { ...prev, items: [payload.call, ...prev.items] };
      });
    }

    const handlers = CALL_EVENTS.map((event) => {
      socket.on(event, handleCall);
      return { event, fn: handleCall };
    });

    return () => {
      for (const { event, fn } of handlers) socket.off(event, fn);
    };
  }, [numberId, queryClient]);
}
