import {
  AI_CALL_QUEUE_LIMIT,
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
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../lib/api-client';
import { saveBlob } from '../lib/download';
import { formatPhone } from '../lib/format';
import { getSocket } from '../lib/realtime';

import { DtmfKeypad } from './dtmf-keypad';

const STATE_STORAGE_KEY = 'pstn-twilio.ai-target-state';
const CONFIG_KEY = ['ai-calls', 'config'] as const;
const LIST_KEY = ['ai-calls', 'list'] as const;
const QUEUE_KEY = ['ai-calls', 'queue'] as const;
const QUEUE_PREVIEW = 5;

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
    WAITING: 'In queue',
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
      // A queued school starting its call leaves the queue.
      void queryClient.invalidateQueries({ queryKey: QUEUE_KEY });
      if (aiCall.status === 'WAITING') return;
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

// Plays or downloads a call recording as MP3 through the API (Vapi's own
// storage links are private).
function AiRecording({ call }: { call: AiCallDto }) {
  const [src, setSrc] = useState<string | null>(null);
  const [busy, setBusy] = useState<'play' | 'download' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blobRef = useRef<Blob | null>(null);

  useEffect(
    () => () => {
      if (src) URL.revokeObjectURL(src);
    },
    [src],
  );

  async function run(action: 'play' | 'download') {
    setBusy(action);
    setError(null);
    try {
      blobRef.current ??= await api.aiCalls.recording(call.id);
      if (action === 'play') {
        setSrc(URL.createObjectURL(blobRef.current));
      } else {
        const started = new Date(call.startedAt ?? call.createdAt);
        const pad = (n: number) => String(n).padStart(2, '0');
        saveBlob(
          blobRef.current,
          `ai-call-${call.customerNumber.replace(/\D/g, '')}-${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())}.mp3`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Recording unavailable');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-1">
      {src && <audio controls autoPlay src={src} className="h-8 w-64 max-w-full" />}
      <div className="flex gap-1">
        {!src && (
          <button
            type="button"
            onClick={() => void run('play')}
            disabled={busy !== null}
            className="rounded border border-slate-300 px-2 py-0.5 text-xs disabled:opacity-60"
          >
            {busy === 'play' ? 'Loading…' : 'Play recording'}
          </button>
        )}
        <button
          type="button"
          onClick={() => void run('download')}
          disabled={busy !== null}
          className="rounded border border-slate-300 px-2 py-0.5 text-xs disabled:opacity-60"
        >
          {busy === 'download' ? 'Downloading…' : 'Download MP3'}
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-rose-700">{error}</p>}
    </div>
  );
}

// Schools waiting for the agent to finish its current call.
function AiCallQueue({ waiting }: { waiting: AiCallDto[] }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = expanded ? waiting : waiting.slice(0, QUEUE_PREVIEW);

  async function change(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      await queryClient.invalidateQueries({ queryKey: QUEUE_KEY });
    }
  }

  return (
    <div className="mt-3 rounded border border-slate-200 p-2" aria-label="AI call queue">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-slate-700">
          Queue · {waiting.length} of {AI_CALL_QUEUE_LIMIT} waiting
        </p>
        <button
          type="button"
          onClick={() => void change(() => api.aiCalls.clearQueue())}
          className="text-xs text-rose-700 underline"
        >
          Clear queue
        </button>
      </div>
      <ol className="mt-1 space-y-0.5">
        {shown.map((call, index) => (
          <li key={call.id} className="flex items-center gap-2 text-xs text-slate-600">
            <span className="w-5 text-right text-slate-400">{index + 1}.</span>
            <span className="font-mono">{formatPhone(call.customerNumber)}</span>
            <span>{call.stateCode}</span>
            <button
              type="button"
              onClick={() => void change(() => api.aiCalls.removeFromQueue(call.id))}
              aria-label={`Remove ${formatPhone(call.customerNumber)} from the queue`}
              className="ml-auto text-slate-400 hover:text-slate-700"
            >
              ✕
            </button>
          </li>
        ))}
      </ol>
      {waiting.length > QUEUE_PREVIEW && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-xs text-slate-600 underline"
        >
          {expanded ? 'Show less' : `Show all ${waiting.length}`}
        </button>
      )}
      {error && <p className="mt-1 text-xs text-rose-700">{error}</p>}
    </div>
  );
}

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
  const queueQuery = useQuery({ queryKey: QUEUE_KEY, queryFn: () => api.aiCalls.queue() });
  const waiting = queueQuery.data ?? [];
  const [notice, setNotice] = useState<string | null>(null);
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
    setNotice(null);
    setRepeatNumber(null);
    try {
      const call = await api.aiCalls.start({
        destinationNumber: number,
        stateCode: state.code,
        ...(state.timeZones.length > 1 ? { timeZone } : {}),
      });
      if (call.status === 'WAITING') {
        const queue = await queryClient.fetchQuery({
          queryKey: QUEUE_KEY,
          queryFn: () => api.aiCalls.queue(),
        });
        const position = queue.findIndex((c) => c.id === call.id) + 1;
        setNotice(
          `The agent is on a call. ${formatPhone(number)} is #${position || queue.length} in the queue.`,
        );
      } else {
        queryClient.setQueryData<AiCallDto[]>(LIST_KEY, (prev) => [
          call,
          ...(prev ?? []).filter((c) => c.id !== call.id),
        ]);
      }
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
      {notice && !error && (
        <p className="mt-2 rounded border border-sky-200 bg-sky-50 p-2 text-xs text-sky-900">
          {notice}
        </p>
      )}
      {waiting.length > 0 && <AiCallQueue waiting={waiting} />}

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
                {call.hasRecording && <AiRecording call={call} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
