import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';

import { useSnackbar, errorMessage } from '../components/ui';
import { formatNumber } from '../lib/format';
import { voiceApi } from '../lib/voice-api';

import { invalidateKinds, useBlockedSet } from './use-voice-data';

/** Marks something read on every device once it has been on screen. */
export function useMarkRead(key: string | null, hasUnread: boolean): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!key || !hasUnread || document.visibilityState !== 'visible') return;
    const timer = setTimeout(() => {
      voiceApi
        .markRead(key)
        .then(() => invalidateKinds(queryClient, ['read']))
        .catch(() => undefined);
    }, 700);
    return () => clearTimeout(timer);
  }, [key, hasUnread, queryClient]);
}

export function useBlocking() {
  const queryClient = useQueryClient();
  const snackbar = useSnackbar();
  const blocked = useBlockedSet();

  const unblock = useCallback(
    async (e164: string) => {
      try {
        await voiceApi.unblock(e164);
        invalidateKinds(queryClient, ['blocked', 'messages', 'calls']);
        snackbar(`${formatNumber(e164)} unblocked`);
      } catch (err) {
        snackbar(errorMessage(err));
      }
    },
    [queryClient, snackbar],
  );

  const block = useCallback(
    async (e164: string) => {
      try {
        await voiceApi.block(e164);
        invalidateKinds(queryClient, ['blocked', 'messages', 'calls']);
        snackbar(`${formatNumber(e164)} blocked`, {
          label: 'Undo',
          onClick: () => void unblock(e164),
        });
      } catch (err) {
        snackbar(errorMessage(err));
      }
    },
    [queryClient, snackbar, unblock],
  );

  return { blocked, block, unblock, isBlocked: (e164: string) => blocked.has(e164) };
}
