import { useQuery } from '@tanstack/react-query';

import { api } from '../lib/api-client';

export function useApiHealth() {
  return useQuery({
    queryKey: ['health', 'liveness'],
    queryFn: () => api.health(),
    refetchInterval: 15_000,
    // Re-check as soon as the tab is visible or the network is back, rather
    // than holding a failure from while the tab was in the background until
    // the next interval.
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
    retry: 3,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 4_000),
    staleTime: 10_000,
  });
}
