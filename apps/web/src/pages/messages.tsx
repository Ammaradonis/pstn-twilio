import type { SmsMessageDto } from '@pstn-twilio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useRealtimeMessages } from '../hooks/use-realtime-messages';
import { api, ApiError } from '../lib/api-client';
import { formatDate, formatPhone } from '../lib/format';
import { useToast } from '../lib/toast';

export function MessagesPage() {
  const { numberId } = useParams<{ numberId: string }>();
  const { push } = useToast();
  const queryClient = useQueryClient();
  useRealtimeMessages(numberId);

  const numberQuery = useQuery({
    queryKey: ['numbers', numberId],
    queryFn: () => api.numbers.get(numberId!),
    enabled: Boolean(numberId),
  });

  const messagesQuery = useQuery({
    queryKey: ['messages', numberId],
    queryFn: () => api.messages.list(numberId!, { limit: 50 }),
    enabled: Boolean(numberId),
  });

  const [to, setTo] = useState('');
  const [body, setBody] = useState('');
  const [showRaw, setShowRaw] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: () => api.messages.send(numberId!, { to, body }),
    onSuccess: (message) => {
      queryClient.setQueryData(
        ['messages', numberId],
        (prev: { items: SmsMessageDto[] } | undefined) => {
          if (!prev) return prev;
          if (prev.items.some((m) => m.id === message.id)) return prev;
          return { ...prev, items: [message, ...prev.items] };
        },
      );
      setBody('');
      push({ tone: 'success', message: `Message sent to ${formatPhone(message.to)}.` });
    },
    onError: (err) => {
      const message =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      push({ tone: 'error', title: 'Send failed', message });
    },
  });

  const retry = useMutation({
    mutationFn: (id: string) => api.messages.retry(numberId!, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['messages', numberId] });
      push({ tone: 'success', message: 'Retry queued.' });
    },
    onError: (err) => {
      const message =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      push({ tone: 'error', title: 'Retry failed', message });
    },
  });

  const number = numberQuery.data;
  const items = messagesQuery.data?.items ?? [];
  const charCount = body.length;
  const charLimit = 1600;
  const ok = isE164(to) && body.length > 0 && body.length <= charLimit;

  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="text-sm text-slate-500">
            <Link to={`/numbers/${numberId}`} className="hover:underline">
              ← Number details
            </Link>
          </div>
          <h1 className="mt-1 text-2xl font-semibold">
            Inbox · {number ? formatPhone(number.phoneNumberE164) : numberId}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {number?.friendlyName ?? 'Loading…'}
            {number && !number.capabilities.sms && (
              <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                SMS not enabled on this number
              </span>
            )}
          </p>
        </div>
      </header>

      <ComposePanel
        to={to}
        setTo={setTo}
        body={body}
        setBody={setBody}
        canSend={ok && !send.isPending}
        submitting={send.isPending}
        error={send.error ? (send.error as ApiError).message : null}
        charCount={charCount}
        charLimit={charLimit}
        smsCapable={number?.capabilities.sms ?? true}
        onSend={() => send.mutate()}
      />

      {messagesQuery.isLoading && <p className="text-sm text-slate-500">Loading messages…</p>}

      {messagesQuery.isError && (
        <p className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {(messagesQuery.error as ApiError).message}
        </p>
      )}

      {!messagesQuery.isLoading && items.length === 0 && (
        <p className="rounded border border-slate-200 bg-white p-6 text-center text-sm text-slate-600">
          No messages yet. Outbound sends and inbound webhooks will appear here in real time.
        </p>
      )}

      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((m) => (
            <MessageRow
              key={m.id}
              message={m}
              showRaw={showRaw === m.id}
              onToggleRaw={() => setShowRaw(showRaw === m.id ? null : m.id)}
              onRetry={() => retry.mutate(m.id)}
              retrying={retry.isPending}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function isE164(value: string): boolean {
  return /^\+[1-9]\d{1,14}$/.test(value.trim());
}

interface ComposePanelProps {
  to: string;
  setTo: (v: string) => void;
  body: string;
  setBody: (v: string) => void;
  canSend: boolean;
  submitting: boolean;
  error: string | null;
  charCount: number;
  charLimit: number;
  smsCapable: boolean;
  onSend: () => void;
}

function ComposePanel({
  to,
  setTo,
  body,
  setBody,
  canSend,
  submitting,
  error,
  charCount,
  charLimit,
  smsCapable,
  onSend,
}: ComposePanelProps) {
  return (
    <div className="space-y-2 rounded border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Compose</h2>
      <div className="grid gap-2 md:grid-cols-[200px_1fr_auto]">
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="+15551234567"
          className="rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Message body…"
          rows={2}
          maxLength={charLimit}
          className="rounded border border-slate-300 px-2 py-1.5 text-sm"
        />
        <button
          onClick={onSend}
          disabled={!canSend || !smsCapable}
          className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {submitting ? 'Sending…' : 'Send'}
        </button>
      </div>
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>
          {charCount} / {charLimit}
        </span>
        <span>{to && !isE164(to) ? 'Destination must be E.164 (e.g. +14155552671)' : ''}</span>
      </div>
      <p className="text-[11px] leading-snug text-amber-700">
        You must have lawful consent from the recipient. Do not use this app for bulk SMS,
        unsolicited marketing, or to harvest/forward verification codes (OTPs). Messages and
        delivery receipts are stored for audit and visible to the authenticated owner only.
      </p>
      {error && (
        <p className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800">
          {error}
        </p>
      )}
    </div>
  );
}

interface MessageRowProps {
  message: SmsMessageDto;
  showRaw: boolean;
  onToggleRaw: () => void;
  onRetry: () => void;
  retrying: boolean;
}

function MessageRow({ message, showRaw, onToggleRaw, onRetry, retrying }: MessageRowProps) {
  const inbound = message.direction === 'INBOUND';
  return (
    <li
      className={`rounded border p-3 ${
        inbound ? 'border-slate-200 bg-white' : 'border-slate-200 bg-slate-50'
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-slate-500">
        <div>
          <span
            className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${
              inbound ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-800'
            }`}
          >
            {inbound ? 'inbound' : 'outbound'}
          </span>
          <span className="ml-2 font-mono">
            {inbound ? `from ${formatPhone(message.from)}` : `to ${formatPhone(message.to)}`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={message.status} />
          <span>{formatDate(message.createdAt)}</span>
        </div>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm text-slate-900">{message.body || '—'}</p>
      {message.mediaUrls.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs">
          {message.mediaUrls.map((url) => (
            <li key={url}>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-slate-700 underline"
              >
                Media attachment
              </a>
            </li>
          ))}
        </ul>
      )}
      {message.errorCode && (
        <p className="mt-2 text-xs text-rose-700">
          Twilio error {message.errorCode}: {message.errorMessage ?? '—'}
        </p>
      )}
      <div className="mt-2 flex items-center gap-3 text-xs">
        <button onClick={onToggleRaw} className="text-slate-600 underline">
          {showRaw ? 'Hide technical details' : 'Show technical details'}
        </button>
        {(message.status === 'FAILED' || message.status === 'UNDELIVERED') &&
          message.direction === 'OUTBOUND' && (
            <button
              onClick={onRetry}
              disabled={retrying}
              className="text-rose-700 underline disabled:opacity-50"
            >
              {retrying ? 'Retrying…' : 'Retry send'}
            </button>
          )}
      </div>
      {showRaw && (
        <pre className="mt-2 overflow-x-auto rounded bg-slate-900 p-2 text-[11px] text-slate-100">
          {JSON.stringify(message, null, 2)}
        </pre>
      )}
    </li>
  );
}

function StatusBadge({ status }: { status: SmsMessageDto['status'] }) {
  const color =
    status === 'DELIVERED' || status === 'SENT'
      ? 'bg-emerald-100 text-emerald-800'
      : status === 'FAILED' || status === 'UNDELIVERED'
        ? 'bg-rose-100 text-rose-800'
        : status === 'RECEIVED'
          ? 'bg-blue-100 text-blue-800'
          : 'bg-slate-100 text-slate-700';
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${color}`}>
      {status.toLowerCase()}
    </span>
  );
}
