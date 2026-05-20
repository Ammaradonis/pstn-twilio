import type { PaginatedDto, SmsMessageDto, WsSmsEvent } from '@pstn-twilio/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { getSocket } from '../lib/realtime';

const SMS_EVENTS = ['sms.received', 'sms.sent', 'sms.status.updated'] as const;

export function useRealtimeMessages(numberId: string | undefined): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!numberId) return;
    const socket = getSocket();

    function handleIncoming(event: string) {
      return (payload: WsSmsEvent) => {
        if (payload.numberId !== numberId) return;
        queryClient.setQueryData<PaginatedDto<SmsMessageDto>>(['messages', numberId], (prev) => {
          if (!prev) return prev;
          const existingIndex = prev.items.findIndex((m) => m.id === payload.message.id);
          if (existingIndex >= 0) {
            const items = [...prev.items];
            items[existingIndex] = payload.message;
            return { ...prev, items };
          }
          if (event === 'sms.status.updated') return prev;
          return { ...prev, items: [payload.message, ...prev.items] };
        });
      };
    }

    const handlers = SMS_EVENTS.map((event) => {
      const fn = handleIncoming(event);
      socket.on(event, fn);
      return { event, fn };
    });

    return () => {
      for (const { event, fn } of handlers) {
        socket.off(event, fn);
      }
    };
  }, [numberId, queryClient]);
}
