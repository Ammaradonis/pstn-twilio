import type { DiagnosticCheckDto } from '@pstn-twilio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../lib/api-client';
import { useToast } from '../lib/toast';

function CheckRow({ label, check }: { label: string; check: DiagnosticCheckDto }) {
  const tone =
    check.status === 'ok'
      ? 'bg-emerald-100 text-emerald-800'
      : check.status === 'down'
        ? 'bg-rose-100 text-rose-800'
        : 'bg-amber-100 text-amber-800';
  return (
    <div className="flex items-start justify-between gap-3 border-t border-slate-100 py-2 first:border-t-0">
      <div>
        <p className="text-sm text-slate-700">{label}</p>
        {check.message && <p className="text-xs text-slate-500">{check.message}</p>}
      </div>
      <div className="flex items-center gap-2">
        {typeof check.durationMs === 'number' && (
          <span className="font-mono text-[11px] text-slate-500">{check.durationMs}ms</span>
        )}
        <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium uppercase ${tone}`}>
          {check.status}
        </span>
      </div>
    </div>
  );
}

export function SettingsDiagnostics() {
  const queryClient = useQueryClient();
  const { push } = useToast();
  const report = useQuery({
    queryKey: ['diagnostics', 'report'],
    queryFn: () => api.diagnostics.report(),
    refetchInterval: 15000,
  });
  const auditLogs = useQuery({
    queryKey: ['audit-logs', { limit: 25 }],
    queryFn: () => api.auditLogs.list({ limit: 25 }),
  });

  const syncMutation = useMutation({
    mutationFn: () => api.diagnostics.syncTwilio(),
    onSuccess: (data) => {
      push({
        tone: data.status === 'ok' ? 'success' : 'error',
        title: 'Twilio credential check',
        message: data.status === 'ok' ? 'Account is active.' : 'Credentials are invalid.',
      });
      queryClient.invalidateQueries({ queryKey: ['diagnostics', 'report'] });
      queryClient.invalidateQueries({ queryKey: ['health', 'twilio'] });
    },
    onError: (err) =>
      push({
        tone: 'error',
        title: 'Twilio check failed',
        message: err instanceof Error ? err.message : 'unknown',
      }),
  });

  const data = report.data;

  return (
    <section className="space-y-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Diagnostics</h1>
          <p className="mt-1 text-sm text-slate-600">
            Live health of the API, database, Redis, Twilio, and the webhook ingest pipeline.
            Refreshes every 15 seconds.
          </p>
        </div>
        <button
          type="button"
          className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
          onClick={() => syncMutation.mutate()}
          disabled={syncMutation.isPending}
        >
          {syncMutation.isPending ? 'Checking…' : 'Re-validate Twilio'}
        </button>
      </header>

      {data && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                Service health
              </h2>
              <span
                className={`rounded px-1.5 py-0.5 text-[11px] font-medium uppercase ${
                  data.overallStatus === 'ok'
                    ? 'bg-emerald-100 text-emerald-800'
                    : data.overallStatus === 'down'
                      ? 'bg-rose-100 text-rose-800'
                      : 'bg-amber-100 text-amber-800'
                }`}
              >
                {data.overallStatus}
              </span>
            </div>
            <div className="mt-2">
              <CheckRow label="API" check={data.checks.api} />
              <CheckRow label="Database" check={data.checks.db} />
              <CheckRow label="Redis" check={data.checks.redis} />
              <CheckRow label="Twilio credentials" check={data.checks.twilio} />
            </div>
          </div>

          <div className="rounded border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Environment
            </h2>
            <dl className="mt-3 space-y-1 text-xs">
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">App</dt>
                <dd className="font-mono text-slate-900">
                  {data.app.name}@{data.app.version}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Node env</dt>
                <dd className="font-mono text-slate-900">{data.environment.nodeEnv}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Uptime</dt>
                <dd className="font-mono text-slate-900">{data.uptimeSeconds}s</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Public base URL</dt>
                <dd className="break-all font-mono text-slate-900">
                  {data.environment.publicBaseUrl ?? '—'}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Webhook base URL</dt>
                <dd className="break-all font-mono text-slate-900">
                  {data.environment.webhookBaseUrl ?? '—'}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">CORS origins</dt>
                <dd className="break-all font-mono text-slate-900">
                  {data.environment.corsOrigins.join(', ') || '—'}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Default country</dt>
                <dd className="font-mono text-slate-900">
                  {data.environment.defaultCountry ?? '—'}
                </dd>
              </div>
            </dl>
            {!data.environment.webhookBaseIsHttps && (
              <p className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                Webhook base URL is not HTTPS. Twilio requires HTTPS for production webhooks.
              </p>
            )}
          </div>

          <div className="rounded border border-slate-200 bg-white p-4 md:col-span-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Webhook ingest
            </h2>
            <dl className="mt-3 space-y-1 text-xs">
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Total events stored</dt>
                <dd className="font-mono text-slate-900">{data.webhooks.total}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Last event</dt>
                <dd className="font-mono text-slate-900">
                  {data.webhooks.last
                    ? `${data.webhooks.last.eventType} @ ${data.webhooks.last.createdAt}`
                    : 'none yet'}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Last invalid signature</dt>
                <dd className="font-mono text-slate-900">
                  {data.webhooks.lastError
                    ? `${data.webhooks.lastError.eventType} @ ${data.webhooks.lastError.createdAt}`
                    : 'none'}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      )}

      <div className="rounded border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Recent audit log
        </h2>
        {auditLogs.isLoading && <p className="mt-2 text-sm text-slate-500">Loading…</p>}
        {auditLogs.data?.items.length === 0 && (
          <p className="mt-2 text-sm text-slate-500">No audit entries yet.</p>
        )}
        {auditLogs.data?.items.length ? (
          <div className="mt-2 overflow-x-auto">
            <table className="min-w-full text-left text-xs">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-1 pr-3 font-medium">When</th>
                  <th className="py-1 pr-3 font-medium">Action</th>
                  <th className="py-1 pr-3 font-medium">Entity</th>
                  <th className="py-1 pr-3 font-medium">IP</th>
                </tr>
              </thead>
              <tbody className="text-slate-700">
                {auditLogs.data.items.map((log) => (
                  <tr key={log.id} className="border-t border-slate-100">
                    <td className="py-1 pr-3 font-mono">{log.createdAt}</td>
                    <td className="py-1 pr-3">{log.action}</td>
                    <td className="py-1 pr-3 font-mono">
                      {log.entityType}
                      {log.entityId ? `:${log.entityId.slice(0, 8)}` : ''}
                    </td>
                    <td className="py-1 pr-3 font-mono">{log.ipAddress ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </section>
  );
}
