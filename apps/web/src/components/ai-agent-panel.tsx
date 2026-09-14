import {
  findUsState,
  normalizeDialablePhoneNumber,
  timeZoneLabel,
  US_STATES,
  WS_EVENTS,
  type AiCallDto,
  type AiCallOutcome,
  type WsAiCallEvent,
} from '@pstn-twilio/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../lib/api-client';
import { formatPhone } from '../lib/format';
import { getSocket } from '../lib/realtime';

import { DtmfKeypad } from './dtmf-keypad';

const STATE_STORAGE_KEY = 'pstn-twilio.ai-target-state';
const CONFIG_KEY = ['ai-calls', 'config'] as const;
const LIST_KEY = ['ai-calls', 'list'] as const;

function readStoredState(fallback: string): string {
  try {
    return window.localStorage.getItem(STATE_STORAGE_KEY) ?? fallback;
  } catch {
    return fallback;
  }
}

function localTime(timeZone: string, now: Date): { text: string; hour: number } {
  const text = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(now);
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(now),
  );
  return { text, hour };
}

const OUTCOME_LABELS: Record<AiCallOutcome, string> = {
  booked: 'Booked',
  callback: 'Call back',
  not_interested: 'Not interested',
  gatekeeper: 'Reached staff',
  voicemail: 'Voicemail',
  no_answer: 'No answer',
  do_not_call: 'Do not call',
  failed: 'Failed',
  other: 'Ended',
};

function statusBadge(call: AiCallDto): { label: string; className: string } {
  if (call.outcome) {
    const tone =
      call.outcome === 'booked'
        ? 'bg-emerald-100 text-emerald-800'
        : call.outcome === 'failed' || call.outcome === 'do_not_call'
          ? 'bg-rose-100 text-rose-800'
          : call.outcome === 'callback'
            ? 'bg-amber-100 text-amber-800'
            : 'bg-slate-100 text-slate-700';
    return { label: OUTCOME_LABELS[call.outcome], className: tone };
  }
  const live: Record<AiCallDto['status'], string> = {
    QUEUED: 'Queued',
    RINGING: 'Ringing',
    IN_PROGRESS: 'On the call',
    FORWARDING: 'Forwarding',
    ENDED: 'Ended',
    FAILED: 'Failed',
  };
  return {
    label: live[call.status],
    className: call.status === 'FAILED' ? 'bg-rose-100 text-rose-800' : 'bg-sky-100 text-sky-800',
  };
}

function formatConsult(call: AiCallDto): string | null {
  if (!call.consultStartAt) return null;
  const when = new Intl.DateTimeFormat('en-US', {
    timeZone: call.timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(call.consultStartAt));
  return `${when} ${timeZoneLabel(call.timeZone)}`;
}

function useAiCallUpdates(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const socket = getSocket();
    const onUpdate = ({ aiCall }: WsAiCallEvent) => {
      queryClient.setQueryData<AiCallDto[]>(LIST_KEY, (prev) => {
        if (!prev) return prev;
        const index = prev.findIndex((c) => c.id === aiCall.id);
        if (index === -1) return [aiCall, ...prev];
        const next = [...prev];
        next[index] = aiCall;
        return next;
      });
    };
    socket.on(WS_EVENTS.AI_CALL_UPDATED, onUpdate);
    return () => {
      socket.off(WS_EVENTS.AI_CALL_UPDATED, onUpdate);
    };
  }, [queryClient]);
}

const LIVE_STATUSES: AiCallDto['status'][] = ['QUEUED', 'RINGING', 'IN_PROGRESS', 'FORWARDING'];

// Keys pressed here are relayed to the agent, which presses them on the call,
// e.g. to get past a phone menu it can't navigate on its own.
function AiCallKeypad({ callId }: { callId: string }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function press(keys: string) {
    setError(null);
    try {
      await api.aiCalls.pressKeys(callId, keys);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-50"
      >
        {open ? 'Hide keypad' : 'Keypad'}
      </button>
      {open && (
        <>
          <p className="mt-1 text-xs text-slate-500">
            The agent presses the keys you tap, for phone menus it can&apos;t get through.
          </p>
          <DtmfKeypad onDigit={(digit) => void press(digit)} />
        </>
      )}
      {error && <p className="mt-1 text-xs text-rose-700">{error}</p>}
    </div>
  );
}

// Starts Vapi AI agent calls to the number in the dialer and lists their results.
export function AiAgentPanel({ destination }: { destination: string | null }) {
  const queryClient = useQueryClient();
  const configQuery = useQuery({ queryKey: CONFIG_KEY, queryFn: () => api.aiCalls.config() });
  const callsQuery = useQuery({ queryKey: LIST_KEY, queryFn: () => api.aiCalls.list(10) });
  useAiCallUpdates();

  const config = configQuery.data;
  const [stateCode, setStateCode] = useState<string>(() =>
    readStoredState(config?.defaultStateCode ?? 'AL'),
  );
  const state = findUsState(stateCode) ?? findUsState('AL')!;
  const [timeZone, setTimeZone] = useState<string>(state.timeZones[0]!);
  const [now, setNow] = useState(() => new Date());
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A number the agent already called, waiting for "Call anyway".
  const [repeatNumber, setRepeatNumber] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setTimeZone(state.timeZones[0]!);
  }, [state]);

  useEffect(() => {
    setRepeatNumber(null);
    setError(null);
  }, [destination, stateCode]);

  const local = localTime(timeZone, now);
  const outsideWindow = local.hour < 8 || local.hour >= 21;
  const calls = useMemo(() => callsQuery.data ?? [], [callsQuery.data]);
  const previousCallTo = (number: string) =>
    calls.find((c) => c.customerNumber === number && c.direction === 'OUTBOUND');
  const repeatPreviousCall = repeatNumber ? previousCallTo(repeatNumber) : undefined;

  function chooseState(code: string) {
    setStateCode(code);
    try {
      window.localStorage.setItem(STATE_STORAGE_KEY, code);
    } catch {
      // Not persisted; the choice still applies on this page.
    }
  }

  async function startCall(number: string, { force = false } = {}) {
    if (previousCallTo(number) && !force) {
      setRepeatNumber(number);
      return;
    }
    setStarting(true);
    setError(null);
    setRepeatNumber(null);
    try {
      const call = await api.aiCalls.start({
        destinationNumber: number,
        stateCode: state.code,
        ...(state.timeZones.length > 1 ? { timeZone } : {}),
      });
      queryClient.setQueryData<AiCallDto[]>(LIST_KEY, (prev) => [
        call,
        ...(prev ?? []).filter((c) => c.id !== call.id),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  // Dials the number on the clipboard with the agent, without touching the
  // manual dialer above.
  async function pasteAndCall() {
    setError(null);
    setRepeatNumber(null);
    if (!navigator.clipboard?.readText) {
      setError('Clipboard access is unavailable in this browser.');
      return;
    }
    let pasted: string;
    try {
      pasted = await navigator.clipboard.readText();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Clipboard access was denied.');
      return;
    }
    const number = normalizeDialablePhoneNumber(pasted);
    if (!number) {
      setError('Clipboard does not contain a dialable phone number.');
      return;
    }
    await startCall(number);
  }

  const notReady = config && !config.ready;
  const cannotCall = starting || outsideWindow || !config?.ready;

  return (
    <div className="rounded border border-slate-200 bg-white p-4" aria-label="AI agent">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-700">AI agent</h2>
        {config?.callerNumber && (
          <span className="text-xs text-slate-500">
            Calls from <span className="font-mono">{formatPhone(config.callerNumber)}</span>
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-slate-500">
        The agent calls the number above and books a {config?.consultMinutes ?? 20}-minute Google
        Meet with you when the owner is interested.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-600">
          Target state
          <select
            value={state.code}
            onChange={(e) => chooseState(e.target.value)}
            className="mt-1 block rounded border border-slate-300 px-2 py-1 text-sm"
          >
            {US_STATES.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        {state.timeZones.length > 1 && (
          <label className="text-xs text-slate-600">
            Time zone
            <select
              value={timeZone}
              onChange={(e) => setTimeZone(e.target.value)}
              className="mt-1 block rounded border border-slate-300 px-2 py-1 text-sm"
            >
              {state.timeZones.map((tz) => (
                <option key={tz} value={tz}>
                  {timeZoneLabel(tz)}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          onClick={() => destination && void startCall(destination)}
          disabled={!destination || cannotCall}
          className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {starting ? 'Starting…' : 'Call with AI agent'}
        </button>
        <button
          type="button"
          onClick={() => void pasteAndCall()}
          disabled={cannotCall}
          aria-label="Paste and call with AI agent"
          title="Paste a phone number from the clipboard and call it with the AI agent"
          className="rounded border border-indigo-300 px-3 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Paste
        </button>
      </div>

      <p className={`mt-2 text-xs ${outsideWindow ? 'text-rose-700' : 'text-slate-500'}`}>
        It&apos;s {local.text} in {state.name} ({timeZoneLabel(timeZone)}).
        {outsideWindow ? ' The agent only calls between 8 AM and 9 PM local time.' : ''}
      </p>
      {repeatNumber && repeatPreviousCall && (
        <p className="mt-1 text-xs text-amber-800">
          The agent already called <span className="font-mono">{formatPhone(repeatNumber)}</span> on{' '}
          {new Date(repeatPreviousCall.createdAt).toLocaleDateString()}.{' '}
          <button
            type="button"
            onClick={() => void startCall(repeatNumber, { force: true })}
            disabled={cannotCall}
            className="font-medium underline disabled:opacity-60"
          >
            Call anyway
          </button>
        </p>
      )}
      {notReady && (
        <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          <p className="font-medium">Finish setup to start AI calls:</p>
          <ul className="mt-1 list-inside list-disc">
            {config.missing.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <Link to="/settings" className="mt-1 inline-block underline">
            Open Settings
          </Link>
        </div>
      )}
      {error && (
        <p className="mt-2 rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-800">
          {error}
        </p>
      )}

      {calls.length > 0 && (
        <ul className="mt-4 divide-y divide-slate-100" aria-label="Recent AI calls">
          {calls.map((call) => {
            const badge = statusBadge(call);
            const consult = formatConsult(call);
            return (
              <li key={call.id} className="py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">{formatPhone(call.customerNumber)}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}
                  >
                    {badge.label}
                  </span>
                  {call.direction === 'INBOUND' && (
                    <span className="text-xs text-slate-500">Called back</span>
                  )}
                  {call.schoolName && (
                    <span className="text-xs text-slate-600">{call.schoolName}</span>
                  )}
                  <span className="ml-auto text-xs text-slate-400">
                    {new Date(call.createdAt).toLocaleString()}
                  </span>
                </div>
                {consult && (
                  <p className="mt-1 text-xs text-emerald-800">
                    Consultation: {consult}
                    {call.contactName ? ` with ${call.contactName}` : ''}
                    {call.consultMeetUrl && (
                      <>
                        {' · '}
                        <a
                          href={call.consultMeetUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="underline"
                        >
                          Meet link
                        </a>
                      </>
                    )}
                  </p>
                )}
                {call.callbackTime && !consult && (
                  <p className="mt-1 text-xs text-amber-800">Call back: {call.callbackTime}</p>
                )}
                {LIVE_STATUSES.includes(call.status) && <AiCallKeypad callId={call.id} />}
                {call.summary && <p className="mt-1 text-xs text-slate-600">{call.summary}</p>}
                {call.recordingUrl && (
                  <a
                    href={call.recordingUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-block text-xs text-slate-600 underline"
                  >
                    Recording
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
