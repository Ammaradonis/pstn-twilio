import type { CallDto, CallRecordingDto, PhoneNumberDto, VoicemailDto } from '@pstn-twilio/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { useApiHealth } from '../hooks/use-api-health';
import { api } from '../lib/api-client';
import { useAuthStore } from '../lib/auth-store';
import { formatDate, formatPhone } from '../lib/format';

function StatCard({
  title,
  value,
  hint,
  tone = 'default',
}: {
  title: string;
  value: string | number;
  hint?: string;
  tone?: 'default' | 'warn' | 'danger' | 'good';
}) {
  const ring =
    tone === 'warn'
      ? 'border-amber-200 bg-amber-50'
      : tone === 'danger'
        ? 'border-rose-200 bg-rose-50'
        : tone === 'good'
          ? 'border-emerald-200 bg-emerald-50'
          : 'border-slate-200 bg-white';
  return (
    <div className={`rounded border p-4 ${ring}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{title}</p>
      <p className="mt-1 text-2xl font-semibold text-slate-900">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-600">{hint}</p>}
    </div>
  );
}

function isWebhookOk(n: PhoneNumberDto) {
  return Boolean(n.voiceWebhookUrl) && Boolean(n.smsWebhookUrl) && Boolean(n.statusCallbackUrl);
}

export function Dashboard() {
  const user = useAuthStore((s) => s.user);
  const canAccessVoicemail = user?.role === 'OWNER' || user?.role === 'ADMIN';

  const numbersQuery = useQuery({
    queryKey: ['numbers'],
    queryFn: () => api.numbers.list(),
  });

  const recentInboundSms = useQuery({
    queryKey: ['messages', 'search', { direction: 'INBOUND', limit: 5 }],
    queryFn: () => api.messages.search({ direction: 'INBOUND', limit: 5 }),
  });

  const voicemailQuery = useQuery({
    queryKey: ['voicemail', { limit: 25 }],
    queryFn: () => api.voicemail.list({ limit: 25 }),
    enabled: canAccessVoicemail,
    refetchInterval: 60_000,
  });

  const apiHealth = useApiHealth();
  const dbHealth = useQuery({
    queryKey: ['health', 'db'],
    queryFn: () => api.health.db(),
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  });
  const redisHealth = useQuery({
    queryKey: ['health', 'redis'],
    queryFn: () => api.health.redis(),
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  });
  const twilioHealth = useQuery({
    queryKey: ['health', 'twilio'],
    queryFn: () => api.health.twilio(),
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });

  const numbers = useMemo(() => numbersQuery.data ?? [], [numbersQuery.data]);
  const activeNumbers = useMemo(() => numbers.filter((n) => n.active), [numbers]);
  const needsWebhookConfig = useMemo(() => numbers.filter((n) => !isWebhookOk(n)), [numbers]);

  const topNumberIds = activeNumbers.slice(0, 5).map((n) => n.id);
  const callsQueries = useQueries({
    queries: topNumberIds.map((id) => ({
      queryKey: ['calls', id, { limit: 3 }],
      queryFn: () => api.calls.list(id, { limit: 3 }),
      staleTime: 30_000,
    })),
  });
  const outboundRecordingQueries = useQueries({
    queries: numbers.map((n) => ({
      queryKey: ['calls', n.id, { direction: 'OUTBOUND', limit: 25 }],
      queryFn: () => api.calls.list(n.id, { direction: 'OUTBOUND', limit: 25 }),
      staleTime: 30_000,
    })),
  });
  const recentCalls = useMemo(() => {
    const items = callsQueries.flatMap((q) => q.data?.items ?? []);
    return items
      .slice()
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      .slice(0, 5);
  }, [callsQueries]);
  const outboundRecordings = useMemo<OutboundRecordingItem[]>(() => {
    return outboundRecordingQueries.flatMap((query, index) => {
      const number = numbers[index];
      if (!number) return [];
      return (query.data?.items ?? []).flatMap((call) =>
        call.recordings.map((recording) => ({ number, call, recording })),
      );
    });
  }, [numbers, outboundRecordingQueries]);
  const outboundRecordingsLoading =
    numbersQuery.isLoading || outboundRecordingQueries.some((q) => q.isLoading);

  const numberById = useMemo(() => {
    const map = new Map<string, PhoneNumberDto>();
    for (const n of numbers) map.set(n.id, n);
    return map;
  }, [numbers]);

  return (
    <section className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="mt-1 text-sm text-slate-600">
          Welcome back{user?.email ? `, ${user.email}` : ''}. Live overview of provisioned numbers,
          inbound activity, and system health.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Active numbers"
          value={numbersQuery.isLoading ? '…' : activeNumbers.length}
          hint={`${numbers.length} total provisioned`}
          tone="good"
        />
        <StatCard
          title="Need webhook config"
          value={numbersQuery.isLoading ? '…' : needsWebhookConfig.length}
          hint="Reconfigure from the number detail page"
          tone={needsWebhookConfig.length > 0 ? 'warn' : 'default'}
        />
        <StatCard
          title="Recent inbound SMS"
          value={recentInboundSms.isLoading ? '…' : (recentInboundSms.data?.length ?? 0)}
          hint="Last 5 across all numbers"
        />
        <StatCard
          title="Recent calls"
          value={recentCalls.length}
          hint={`Across top ${topNumberIds.length || 0} numbers`}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="API"
          value={apiHealth.data?.status ?? (apiHealth.isLoading ? '…' : 'down')}
          tone={apiHealth.data?.status === 'ok' ? 'good' : 'danger'}
        />
        <StatCard
          title="Database"
          value={dbHealth.data?.status ?? (dbHealth.isLoading ? '…' : 'down')}
          tone={dbHealth.data?.status === 'ok' ? 'good' : 'danger'}
        />
        <StatCard
          title="Redis"
          value={redisHealth.data?.status ?? (redisHealth.isLoading ? '…' : 'down')}
          tone={redisHealth.data?.status === 'ok' ? 'good' : 'danger'}
        />
        <StatCard
          title="Twilio credentials"
          value={twilioHealth.data?.status ?? (twilioHealth.isLoading ? '…' : 'down')}
          tone={twilioHealth.data?.status === 'ok' ? 'good' : 'warn'}
        />
      </div>

      {needsWebhookConfig.length > 0 && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-semibold">
            {needsWebhookConfig.length} number(s) need webhook configuration.
          </p>
          <ul className="mt-1 space-y-0.5 text-xs">
            {needsWebhookConfig.map((n) => (
              <li key={n.id}>
                <Link to={`/numbers/${n.id}`} className="font-mono underline">
                  {formatPhone(n.phoneNumberE164)}
                </Link>{' '}
                — {n.friendlyName}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded border border-amber-200 bg-amber-50 p-3 text-xs leading-snug text-amber-800">
        WhatsApp compatibility is not guaranteed. Some VoIP, toll-free, landline, or virtual numbers
        may be unsupported by WhatsApp/Meta. Eligibility depends on number type, country, account
        standing, and current WhatsApp/Meta policy.
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Recent inbound SMS
          </h2>
          {recentInboundSms.isLoading && <p className="mt-2 text-sm text-slate-500">Loading…</p>}
          {!recentInboundSms.isLoading && (recentInboundSms.data?.length ?? 0) === 0 && (
            <p className="mt-2 text-sm text-slate-500">No inbound SMS yet.</p>
          )}
          <ul className="mt-2 divide-y divide-slate-100">
            {(recentInboundSms.data ?? []).map((m) => (
              <li key={m.id} className="py-2 text-sm">
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span className="font-mono">from {formatPhone(m.from)}</span>
                  <span>{formatDate(m.createdAt)}</span>
                </div>
                <p className="mt-0.5 line-clamp-2 text-slate-900">{m.body || '—'}</p>
                <Link
                  to={`/numbers/${m.phoneNumberId}/messages`}
                  className="text-xs text-slate-600 underline"
                >
                  Open inbox
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Recent calls
          </h2>
          {recentCalls.length === 0 && (
            <p className="mt-2 text-sm text-slate-500">No recent calls.</p>
          )}
          <ul className="mt-2 divide-y divide-slate-100">
            {recentCalls.map((c) => {
              const n = c.phoneNumberId ? numberById.get(c.phoneNumberId) : null;
              return (
                <li key={c.id} className="py-2 text-sm">
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span>
                      {c.direction === 'INBOUND'
                        ? `${formatPhone(c.from)} → ${n ? formatPhone(n.phoneNumberE164) : c.to}`
                        : `${n ? formatPhone(n.phoneNumberE164) : c.from} → ${formatPhone(c.to)}`}
                    </span>
                    <span>{formatDate(c.startedAt)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between text-xs">
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-700">
                      {c.status.toLowerCase()}
                    </span>
                    {c.phoneNumberId && (
                      <Link
                        to={`/numbers/${c.phoneNumberId}/calls`}
                        className="text-slate-600 underline"
                      >
                        Open call log
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {canAccessVoicemail && (
        <VoicemailInbox
          items={voicemailQuery.data?.items ?? []}
          loading={voicemailQuery.isLoading}
        />
      )}

      <OutboundRecordingsByNumber
        numbers={numbers}
        items={outboundRecordings}
        loading={outboundRecordingsLoading}
      />
    </section>
  );
}

interface OutboundRecordingItem {
  number: PhoneNumberDto;
  call: CallDto;
  recording: CallRecordingDto;
}

function OutboundRecordingsByNumber({
  numbers,
  items,
  loading,
}: {
  numbers: PhoneNumberDto[];
  items: OutboundRecordingItem[];
  loading: boolean;
}) {
  const itemsByNumberId = useMemo(() => {
    const map = new Map<string, OutboundRecordingItem[]>();
    for (const item of items) {
      const bucket = map.get(item.number.id) ?? [];
      bucket.push(item);
      map.set(item.number.id, bucket);
    }
    for (const bucket of map.values()) {
      bucket.sort(
        (a, b) =>
          new Date(b.recording.createdAt).getTime() - new Date(a.recording.createdAt).getTime(),
      );
    }
    return map;
  }, [items]);

  return (
    <div className="rounded border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Outbound recordings
        </h2>
        <span className="text-xs text-slate-500">{items.length} recent</span>
      </div>

      {loading ? <p className="mt-2 text-sm text-slate-500">Loading…</p> : null}
      {!loading && numbers.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">No provisioned numbers yet.</p>
      ) : null}

      {numbers.length > 0 ? (
        <div className="mt-3 divide-y divide-slate-100">
          {numbers.map((number) => {
            const recordings = itemsByNumberId.get(number.id) ?? [];
            return (
              <section key={number.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <div className="font-mono text-sm">{formatPhone(number.phoneNumberE164)}</div>
                    <div className="text-xs text-slate-500">{number.friendlyName}</div>
                  </div>
                  <Link
                    to={`/numbers/${number.id}/calls`}
                    className="text-xs text-slate-600 underline"
                  >
                    Open call log
                  </Link>
                </div>

                {recordings.length === 0 ? (
                  <p className="mt-2 text-sm text-slate-500">No outbound recordings yet.</p>
                ) : (
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full table-auto border-collapse text-sm">
                      <thead>
                        <tr className="text-left text-xs text-slate-500">
                          <th className="px-3 py-2">To</th>
                          <th className="px-3 py-2">Recorded</th>
                          <th className="px-3 py-2">Duration</th>
                          <th className="px-3 py-2">Playback</th>
                        </tr>
                      </thead>
                      <tbody>
                        {recordings.map(({ call, recording }) => (
                          <tr key={recording.id} className="border-t border-slate-100">
                            <td className="px-3 py-2 font-mono">
                              {formatPhone(call.destination ?? call.to)}
                            </td>
                            <td className="px-3 py-2">{formatDate(recording.createdAt)}</td>
                            <td className="px-3 py-2">
                              {recording.durationSeconds !== null
                                ? `${recording.durationSeconds}s`
                                : recording.status}
                            </td>
                            <td className="px-3 py-2">
                              <OutboundRecordingAudio
                                numberId={number.id}
                                callId={call.id}
                                recording={recording}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function OutboundRecordingAudio({
  numberId,
  callId,
  recording,
}: {
  numberId: string;
  callId: string;
  recording: CallRecordingDto;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (src) URL.revokeObjectURL(src);
    };
  }, [src]);

  async function loadRecording() {
    setLoading(true);
    setError(null);
    try {
      const blob = await api.calls.recordingMedia(numberId, callId, recording.id);
      const url = URL.createObjectURL(blob);
      setSrc((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Recording unavailable');
    } finally {
      setLoading(false);
    }
  }

  if (recording.status !== 'COMPLETED') {
    return <span className="text-xs text-slate-500">{recording.status}</span>;
  }

  if (src) {
    return <audio controls preload="metadata" src={src} className="h-8 w-64 max-w-full" />;
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={loadRecording}
        disabled={loading}
        className="w-fit rounded border border-slate-300 px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? 'Loading…' : 'Play'}
      </button>
      {error ? <span className="max-w-48 text-xs text-red-600">{error}</span> : null}
    </div>
  );
}

function VoicemailInbox({ items, loading }: { items: VoicemailDto[]; loading: boolean }) {
  return (
    <div className="rounded border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Voicemail inbox
        </h2>
        <span className="text-xs text-slate-500">{items.length} recent</span>
      </div>

      {loading ? <p className="mt-2 text-sm text-slate-500">Loading…</p> : null}
      {!loading && items.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">No voicemail yet.</p>
      ) : null}

      {items.length > 0 ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full table-auto border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="px-3 py-2">Number</th>
                <th className="px-3 py-2">From</th>
                <th className="px-3 py-2">Received</th>
                <th className="px-3 py-2">Duration</th>
                <th className="px-3 py-2">Message</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">
                    <div className="font-mono">{formatPhone(item.phoneNumberE164)}</div>
                    {item.phoneNumberFriendlyName ? (
                      <div className="text-xs text-slate-500">{item.phoneNumberFriendlyName}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 font-mono">{formatPhone(item.from)}</td>
                  <td className="px-3 py-2">{formatDate(item.createdAt)}</td>
                  <td className="px-3 py-2">
                    {item.durationSeconds !== null ? `${item.durationSeconds}s` : item.status}
                  </td>
                  <td className="px-3 py-2">
                    <VoicemailAudio item={item} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function VoicemailAudio({ item }: { item: VoicemailDto }) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (src) URL.revokeObjectURL(src);
    };
  }, [src]);

  async function loadVoicemail() {
    setLoading(true);
    setError(null);
    try {
      const blob = await api.voicemail.media(item.id);
      const url = URL.createObjectURL(blob);
      setSrc((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Voicemail unavailable');
    } finally {
      setLoading(false);
    }
  }

  if (item.status !== 'COMPLETED') {
    return <span className="text-xs text-slate-500">{item.status}</span>;
  }

  if (src) {
    return <audio controls preload="metadata" src={src} className="h-8 w-64 max-w-full" />;
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={loadVoicemail}
        disabled={loading}
        className="w-fit rounded border border-slate-300 px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? 'Loading…' : 'Play'}
      </button>
      {error ? <span className="max-w-48 text-xs text-red-600">{error}</span> : null}
    </div>
  );
}
