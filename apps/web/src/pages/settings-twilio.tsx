import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { api } from '../lib/api-client';
import { env } from '../lib/env';

function StatusRow({
  label,
  status,
  message,
}: {
  label: string;
  status: 'ok' | 'down' | 'loading';
  message?: string;
}) {
  const tone =
    status === 'ok'
      ? 'bg-emerald-100 text-emerald-800'
      : status === 'down'
        ? 'bg-rose-100 text-rose-800'
        : 'bg-slate-100 text-slate-700';
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 py-2 first:border-t-0">
      <span className="text-sm text-slate-700">{label}</span>
      <div className="flex items-center gap-2">
        {message && <span className="text-xs text-slate-500">{message}</span>}
        <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium uppercase ${tone}`}>
          {status}
        </span>
      </div>
    </div>
  );
}

export function SettingsTwilio() {
  const dbHealth = useQuery({ queryKey: ['health', 'db'], queryFn: () => api.health.db() });
  const redisHealth = useQuery({
    queryKey: ['health', 'redis'],
    queryFn: () => api.health.redis(),
  });
  const twilioHealth = useQuery({
    queryKey: ['health', 'twilio'],
    queryFn: () => api.health.twilio(),
  });
  const numbersQuery = useQuery({ queryKey: ['numbers'], queryFn: () => api.numbers.list() });

  const sample = useMemo(() => {
    const numbers = numbersQuery.data ?? [];
    return numbers.find((n) => n.voiceWebhookUrl) ?? numbers[0] ?? null;
  }, [numbersQuery.data]);

  const inferredBase = useMemo(() => {
    if (!sample?.voiceWebhookUrl) return null;
    try {
      return new URL(sample.voiceWebhookUrl).origin;
    } catch {
      return null;
    }
  }, [sample]);

  return (
    <section className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">Twilio configuration</h1>
        <p className="mt-1 text-sm text-slate-600">
          Credential validation, webhook base URL, and developer diagnostics. Secrets are never
          exposed to the browser; this page only reads health checks and metadata that the API has
          already chosen to expose.
        </p>
      </header>

      <div className="rounded border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Service health
        </h2>
        <div className="mt-2">
          <StatusRow
            label="Database connection"
            status={dbHealth.isLoading ? 'loading' : dbHealth.data?.status === 'ok' ? 'ok' : 'down'}
            message={dbHealth.data?.checks.db?.message}
          />
          <StatusRow
            label="Redis connection"
            status={
              redisHealth.isLoading ? 'loading' : redisHealth.data?.status === 'ok' ? 'ok' : 'down'
            }
            message={redisHealth.data?.checks.redis?.message}
          />
          <StatusRow
            label="Twilio credentials"
            status={
              twilioHealth.isLoading
                ? 'loading'
                : twilioHealth.data?.status === 'ok'
                  ? 'ok'
                  : 'down'
            }
            message={
              twilioHealth.data?.status === 'ok'
                ? 'Account is active'
                : twilioHealth.data?.checks.twilio?.message
            }
          />
        </div>
      </div>

      <div className="rounded border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Webhook configuration
        </h2>
        <p className="mt-2 text-xs text-slate-500">
          Inferred from the configuration of provisioned numbers. The TwiML App Voice URL must point
          at the API <span className="font-mono">/webhooks/twilio/voice/outbound</span> endpoint and
          Twilio numbers must be configured with the matching inbound URLs (the app does this
          automatically on purchase / reconfigure).
        </p>
        <dl className="mt-3 space-y-1 text-xs">
          <div className="flex justify-between gap-4">
            <dt className="text-slate-500">Webhook base URL</dt>
            <dd className="break-all font-mono text-slate-900">
              {inferredBase ?? 'unknown — provision a number first'}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-slate-500">Sample voice URL</dt>
            <dd className="break-all font-mono text-slate-900">{sample?.voiceWebhookUrl ?? '—'}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-slate-500">Sample SMS URL</dt>
            <dd className="break-all font-mono text-slate-900">{sample?.smsWebhookUrl ?? '—'}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-slate-500">Sample status URL</dt>
            <dd className="break-all font-mono text-slate-900">
              {sample?.statusCallbackUrl ?? '—'}
            </dd>
          </div>
        </dl>
        {inferredBase && !inferredBase.startsWith('https://') && (
          <p className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
            Webhook base URL is not HTTPS. Twilio rejects unsigned/insecure webhooks in production.
          </p>
        )}
      </div>

      <div className="rounded border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Frontend environment
        </h2>
        <dl className="mt-3 space-y-1 text-xs">
          <div className="flex justify-between gap-4">
            <dt className="text-slate-500">App name</dt>
            <dd className="font-mono text-slate-900">{env.VITE_APP_NAME}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-slate-500">API base URL</dt>
            <dd className="break-all font-mono text-slate-900">{env.VITE_API_BASE_URL}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-slate-500">WebSocket URL</dt>
            <dd className="break-all font-mono text-slate-900">{env.VITE_WS_URL}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
