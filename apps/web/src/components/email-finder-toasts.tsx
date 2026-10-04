/**
 * Email finder notifications, bottom left of the Dial page.
 *
 * Each address the finder on the PC finds arrives over the socket the moment
 * the worker reports it, with the exact address and how it was found (e.g.
 * "Facebook contact info via iPhone emulation (found via free Google search)").
 * The tab's status poll fills in anything missed while the socket was down,
 * and on load the latest find is shown. The newest notification stays until
 * dismissed; older ones fade after a minute.
 */

import {
  WS_EVENTS,
  type EmailFinderFindDto,
  type WsEmailFinderFoundEvent,
} from '@pstn-twilio/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { getSocket } from '../lib/realtime';

const OLDER_VISIBLE_MS = 60_000;
const MAX_VISIBLE = 3;
const DISMISSED_KEY = 'pstn-twilio.email-finder.dismissed';

interface Props {
  spreadsheetId: string;
  sheetTitle: string;
  /** The tab's latest finds from the status poll, newest first. */
  recent?: EmailFinderFindDto[];
}

interface Shown {
  find: EmailFinderFindDto;
  shownAt: number;
}

export function EmailFinderToasts({ spreadsheetId, sheetTitle, recent }: Props) {
  const queryClient = useQueryClient();
  const [shown, setShown] = useState<Shown[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(readDismissed);
  const [now, setNow] = useState(() => Date.now());
  const known = useRef(new Set<string>());
  const seeded = useRef(false);

  function add(finds: EmailFinderFindDto[]) {
    const fresh = finds.filter((f) => !known.current.has(f.rowId));
    if (fresh.length === 0) return;
    for (const f of fresh) known.current.add(f.rowId);
    const at = Date.now();
    setShown((prev) => [...fresh.map((find) => ({ find, shownAt: at })), ...prev].slice(0, 20));
    setNow(at);
  }

  useEffect(() => {
    const socket = getSocket();
    function onFound(payload: WsEmailFinderFoundEvent) {
      add([payload.find]);
      const { spreadsheetId: id, sheetTitle: title } = payload.find;
      void queryClient.invalidateQueries({ queryKey: ['email-finder', id, title] });
    }
    socket.on(WS_EVENTS.EMAIL_FINDER_FOUND, onFound);
    return () => {
      socket.off(WS_EVENTS.EMAIL_FINDER_FOUND, onFound);
    };
  }, [queryClient]);

  useEffect(() => {
    if (!recent) return;
    if (!seeded.current) {
      // On load only the latest find, not the tab's whole history.
      seeded.current = true;
      for (const f of recent.slice(1)) known.current.add(f.rowId);
      add(recent.slice(0, 1));
      return;
    }
    add(recent);
  }, [recent]);

  // Re-render so older notifications fade and "x min ago" stays current.
  useEffect(() => {
    if (shown.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [shown.length]);

  function dismiss(rowId: string) {
    setDismissed((prev) => {
      const next = new Set(prev).add(rowId);
      writeDismissed(next);
      return next;
    });
  }

  const visible = shown
    .filter((s) => !dismissed.has(s.find.rowId))
    .filter((s, i) => i === 0 || now - s.shownAt < OLDER_VISIBLE_MS)
    .slice(0, MAX_VISIBLE);
  if (visible.length === 0) return null;

  return (
    <div
      aria-label="Email finder notifications"
      aria-live="polite"
      className="fixed inset-x-2 bottom-2 z-40 flex flex-col-reverse gap-2 sm:inset-x-auto sm:bottom-4 sm:left-4 sm:w-[22rem]"
    >
      {visible.map((s, i) => (
        <FindNotice
          key={s.find.rowId}
          find={s.find}
          latest={i === 0}
          now={now}
          otherTab={s.find.spreadsheetId !== spreadsheetId || s.find.sheetTitle !== sheetTitle}
          onDismiss={() => dismiss(s.find.rowId)}
        />
      ))}
    </div>
  );
}

function FindNotice({
  find,
  latest,
  now,
  otherTab,
  onDismiss,
}: {
  find: EmailFinderFindDto;
  latest: boolean;
  now: number;
  otherTab: boolean;
  onDismiss: () => void;
}) {
  const [entered, setEntered] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(find.email);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: the address is selectable text.
    }
  }

  const facts = [
    find.emailType,
    find.confidence != null ? `${find.confidence}% confidence` : null,
  ].filter(Boolean);

  return (
    <div
      role="status"
      className={`border border-l-4 bg-white p-3 text-sm text-slate-900 shadow-md transition duration-300 ${
        latest ? 'border-slate-300 border-l-emerald-500' : 'border-slate-200 border-l-slate-300'
      } ${entered ? 'translate-x-0 opacity-100' : '-translate-x-4 opacity-0'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
          Email found ·{' '}
          <span className="font-normal normal-case text-slate-500">
            {ago(find.foundAt, now)}
            {otherTab && ` · tab "${find.sheetTitle}"`}
          </span>
        </p>
        <button
          type="button"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={onDismiss}
          className="shrink-0 text-xs text-slate-400 hover:text-slate-900"
        >
          ✕
        </button>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <p className="min-w-0 select-all break-all font-mono text-[13px] font-semibold">
          {find.email}
        </p>
        <button
          type="button"
          onClick={() => void copy()}
          className="shrink-0 border border-slate-300 px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-700">
        <span className="text-slate-500">Method:</span> {find.method ?? 'not recorded'}
      </p>
      <p className="mt-0.5 truncate text-xs text-slate-500" title={find.school}>
        {find.school}
        {facts.length > 0 && ` · ${facts.join(' · ')}`}
      </p>
      {find.sourceUrl && (
        <a
          href={find.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-0.5 block truncate text-xs text-sky-700 hover:underline"
          title={find.sourceUrl}
        >
          {find.sourceUrl.replace(/^https?:\/\/(www\.)?/, '')}
        </a>
      )}
    </div>
  );
}

function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}

function readDismissed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeDismissed(ids: Set<string>): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids].slice(-50)));
  } catch {
    // Private mode or storage blocked: dismissals last for this page only.
  }
}
