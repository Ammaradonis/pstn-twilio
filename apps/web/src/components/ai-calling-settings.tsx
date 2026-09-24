import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { api } from '../lib/api-client';
import { formatPhone } from '../lib/format';

const INBOUND_KEY = ['ai-calls', 'inbound'] as const;

// Incoming calls must be answered manually; outbound AI calls are independent.
function IncomingCallsToggle() {
  const queryClient = useQueryClient();
  const inboundQuery = useQuery({ queryKey: INBOUND_KEY, queryFn: () => api.aiCalls.inbound() });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = inboundQuery.data;

  async function setMode(mode: 'browser' | 'blocked') {
    setBusy(true);
    setError(null);
    try {
      queryClient.setQueryData(INBOUND_KEY, await api.aiCalls.setInbound(mode));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (inboundQuery.isError) {
    return (
      <p className="mt-3 text-xs text-rose-700">
        Couldn&apos;t load incoming call settings: {(inboundQuery.error as Error).message}
      </p>
    );
  }

  const description = !status
    ? 'Checking…'
    : status.mode === 'blocked'
      ? 'Blocked. Callers hear a busy signal and the agent never answers.'
      : status.mode === 'browser'
        ? 'Calls ring your browser. Only you can answer; voicemail is disabled.'
        : 'Routed somewhere else in Twilio. Choose an option to take control.';

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 text-sm">
      <div>
        <p className="text-slate-700">
          Incoming calls
          {status && (
            <>
              {' '}
              to <span className="font-mono text-xs">{formatPhone(status.phoneNumber)}</span>
            </>
          )}
        </p>
        <p className="text-xs text-slate-500">{description}</p>
        <p className="text-xs text-slate-500">Outbound AI calls work either way.</p>
      </div>
      {status && status.mode !== 'blocked' && (
        <button
          type="button"
          onClick={() => void setMode('blocked')}
          disabled={busy}
          className="rounded border border-rose-300 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50 disabled:opacity-60"
        >
          Block incoming calls
        </button>
      )}
      {status && status.mode !== 'browser' && (
        <button
          type="button"
          onClick={() => void setMode('browser')}
          disabled={busy}
          className="rounded bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-60"
        >
          Ring my browser
        </button>
      )}
      {error && <p className="w-full text-xs text-rose-700">{error}</p>}
    </div>
  );
}

// Google Calendar connection and remaining setup for the AI booking agent.
export function AiCallingSettings() {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const configQuery = useQuery({
    queryKey: ['ai-calls', 'config'],
    queryFn: () => api.aiCalls.config(),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const result = params.get('calendar');
  const reason = params.get('reason');
  const config = configQuery.data;

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.googleCalendar.connectUrl();
      window.location.assign(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      await api.googleCalendar.disconnect();
      await queryClient.invalidateQueries({ queryKey: ['ai-calls', 'config'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function dismissResult() {
    const next = new URLSearchParams(params);
    next.delete('calendar');
    next.delete('reason');
    setParams(next, { replace: true });
  }

  const serverSteps =
    config?.missing.filter((m) => !m.includes('Google Calendar in Settings')) ?? [];

  return (
    <div className="rounded border border-slate-200 bg-white p-4" aria-label="AI calling">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">AI calling</h2>

      {result === 'connected' && (
        <p className="mt-3 rounded border border-emerald-300 bg-emerald-50 p-2 text-sm text-emerald-800">
          Google Calendar connected.{' '}
          <button type="button" onClick={dismissResult} className="underline">
            Dismiss
          </button>
        </p>
      )}
      {result === 'error' && (
        <p className="mt-3 rounded border border-rose-300 bg-rose-50 p-2 text-sm text-rose-800">
          Google Calendar wasn&apos;t connected{reason ? `: ${reason}` : '.'}{' '}
          <button type="button" onClick={dismissResult} className="underline">
            Dismiss
          </button>
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
        <div>
          <p className="text-slate-700">Google Calendar</p>
          <p className="text-xs text-slate-500">
            {configQuery.isLoading
              ? 'Checking…'
              : config?.calendar.connected
                ? `Connected${config.calendar.email ? ` as ${config.calendar.email}` : ''}. The agent books consultations here.`
                : 'Not connected. The agent needs it to find open times and book consultations.'}
          </p>
        </div>
        {config?.calendar.connected ? (
          <button
            type="button"
            onClick={() => void disconnect()}
            disabled={busy}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-60"
          >
            Disconnect
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void connect()}
            disabled={busy || configQuery.isLoading}
            className="rounded bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-60"
          >
            Connect Google Calendar
          </button>
        )}
      </div>

      {serverSteps.length > 0 && (
        <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          <p className="font-medium">Server setup still needed:</p>
          <ul className="mt-1 list-inside list-disc">
            {serverSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </div>
      )}
      <IncomingCallsToggle />

      {config?.ready && (
        <p className="mt-3 text-xs text-emerald-700">Ready to place AI calls from the Dial page.</p>
      )}
      {error && <p className="mt-2 text-xs text-rose-700">{error}</p>}
    </div>
  );
}
