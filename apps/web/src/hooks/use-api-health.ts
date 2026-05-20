import { useQuery } from '@tanstack/react-query';

import { api } from '../lib/api-client';

export function useApiHealth() {
  return useQuery({
    queryKey: ['health', 'liveness'],
    queryFn: () => api.health(),
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
    retry: 1,
    staleTime: 10_000,
  });
}
