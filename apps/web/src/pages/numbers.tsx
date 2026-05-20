import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { WhatsAppDisclaimer } from '../components/disclaimer';
import { api, type ApiError } from '../lib/api-client';
import { capabilityBadge, formatPhone } from '../lib/format';

export function Numbers() {
  const [filter, setFilter] = useState('');

  const numbersQuery = useQuery({
    queryKey: ['numbers'],
    queryFn: () => api.numbers.list(),
  });

  const filtered = useMemo(() => {
    if (!numbersQuery.data) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return numbersQuery.data;
    return numbersQuery.data.filter((n) => {
      return (
        n.phoneNumberE164.toLowerCase().includes(needle) ||
        n.friendlyName.toLowerCase().includes(needle) ||
        (n.locality?.toLowerCase().includes(needle) ?? false) ||
        (n.region?.toLowerCase().includes(needle) ?? false)
      );
    });
  }, [filter, numbersQuery.data]);

  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Numbers</h1>
          <p className="mt-1 text-sm text-slate-600">
            Twilio numbers provisioned through this app. Each is wired to the app&apos;s voice and
            SMS webhooks.
          </p>
        </div>
        <Link
          to="/numbers/new"
          className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
        >
          + New number
        </Link>
      </header>

      <WhatsAppDisclaimer />

      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter by number, name, locality, or region"
        className="w-full max-w-sm rounded border border-slate-300 px-2 py-1.5 text-sm"
      />

      {numbersQuery.isLoading && <p className="text-sm text-slate-500">Loading…</p>}

      {numbersQuery.isError && (
        <p className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {(numbersQuery.error as ApiError).message}
        </p>
      )}

      {numbersQuery.data && filtered.length === 0 && (
        <p className="rounded border border-slate-200 bg-white p-6 text-center text-sm text-slate-600">
          {numbersQuery.data.length === 0 ? (
            <>
              No numbers yet.{' '}
              <Link to="/numbers/new" className="underline">
                Provision one
              </Link>
              .
            </>
          ) : (
            'No numbers match this filter.'
          )}
        </p>
      )}

      {filtered.length > 0 && (
        <div className="overflow-x-auto rounded border border-slate-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">Number</th>
                <th className="px-3 py-2 text-left">Name</th>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-3 py-2 text-left">Country</th>
                <th className="px-3 py-2 text-center">Voice</th>
                <th className="px-3 py-2 text-center">SMS</th>
                <th className="px-3 py-2 text-center">MMS</th>
                <th className="px-3 py-2 text-left">Webhooks</th>
                <th className="px-3 py-2 text-left">WhatsApp</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((n) => {
                const webhooksOk =
                  Boolean(n.voiceWebhookUrl) &&
                  Boolean(n.smsWebhookUrl) &&
                  Boolean(n.statusCallbackUrl);
                return (
                  <tr key={n.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2 font-mono">
                      <Link to={`/numbers/${n.id}`} className="text-slate-900 hover:underline">
                        {formatPhone(n.phoneNumberE164)}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{n.friendlyName}</td>
                    <td className="px-3 py-2">{n.numberType.replace('_', ' ').toLowerCase()}</td>
                    <td className="px-3 py-2">{n.country ?? '—'}</td>
                    <td className="px-3 py-2 text-center">
                      {capabilityBadge(n.capabilities.voice)}
                    </td>
                    <td className="px-3 py-2 text-center">{capabilityBadge(n.capabilities.sms)}</td>
                    <td className="px-3 py-2 text-center">{capabilityBadge(n.capabilities.mms)}</td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          webhooksOk
                            ? 'rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] text-emerald-800'
                            : 'rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800'
                        }
                      >
                        {webhooksOk ? 'configured' : 'needs setup'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-[11px] text-slate-600">
                      {n.whatsappCompatibilityStatus.replace(/_/g, ' ').toLowerCase()}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          n.active
                            ? 'rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] text-emerald-800'
                            : 'rounded bg-slate-200 px-1.5 py-0.5 text-[11px] text-slate-700'
                        }
                      >
                        {n.active ? 'active' : 'inactive'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <div className="flex flex-wrap gap-2">
                        <Link to={`/numbers/${n.id}/messages`} className="text-slate-700 underline">
                          Inbox
                        </Link>
                        <Link to={`/numbers/${n.id}/calls`} className="text-slate-700 underline">
                          Calls
                        </Link>
                        <Link to={`/numbers/${n.id}/answer`} className="text-slate-700 underline">
                          Answer
                        </Link>
                        <Link to={`/numbers/${n.id}/dial`} className="text-slate-700 underline">
                          Dial
                        </Link>
                        <Link to={`/numbers/${n.id}`} className="text-slate-700 underline">
                          Settings
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
