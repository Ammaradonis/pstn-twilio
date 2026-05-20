import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { api } from '../lib/api-client';
import { formatPhone } from '../lib/format';
import { useSelectedNumberStore } from '../lib/selected-number-store';

export function NumberSwitcher() {
  const navigate = useNavigate();
  const params = useParams<{ numberId?: string }>();
  const { selectedNumberId, setSelectedNumberId } = useSelectedNumberStore();

  const numbersQuery = useQuery({
    queryKey: ['numbers'],
    queryFn: () => api.numbers.list(),
    staleTime: 30_000,
  });

  // Keep store in sync with URL when present.
  useEffect(() => {
    if (params.numberId && params.numberId !== selectedNumberId) {
      setSelectedNumberId(params.numberId);
    }
  }, [params.numberId, selectedNumberId, setSelectedNumberId]);

  const items = numbersQuery.data ?? [];
  const value = selectedNumberId ?? '';

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const id = e.target.value;
    setSelectedNumberId(id || null);
    if (!id) return;
    // Stay on same sub-route when switching number contextually
    const segments = window.location.pathname.split('/');
    if (segments[1] === 'numbers' && segments[2] && segments[3]) {
      navigate(`/numbers/${id}/${segments.slice(3).join('/')}`);
    } else {
      navigate(`/numbers/${id}`);
    }
  }

  if (numbersQuery.isLoading) {
    return <span className="text-xs text-slate-400">Loading numbers…</span>;
  }
  if (items.length === 0) {
    return (
      <span className="text-xs text-slate-500">
        No numbers yet —{' '}
        <a href="/numbers/new" className="underline">
          provision one
        </a>
      </span>
    );
  }

  return (
    <label className="flex items-center gap-2 text-xs text-slate-500">
      <span className="hidden sm:inline">Active number</span>
      <select
        value={value}
        onChange={handleChange}
        className="rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs focus:border-slate-500 focus:outline-none"
      >
        <option value="">Select…</option>
        {items.map((n) => (
          <option key={n.id} value={n.id}>
            {formatPhone(n.phoneNumberE164)} · {n.friendlyName}
          </option>
        ))}
      </select>
    </label>
  );
}
