/**
 * Email finder notification, bottom left of the Dial page.
 *
 * One card at a time: each address the finder on the PC finds replaces the
 * previous card, with the exact address and how it was found (e.g. "Facebook
 * contact info via iPhone emulation (found via free Google search)"). It
 * arrives over the socket the moment the worker reports it; the tab's status
 * poll covers anything missed while the socket was down, and on load the
 * latest find is shown if it is recent. A card stays until a newer find
 * replaces it, it is dismissed, or 15 minutes pass (a "2 h ago" card used to
 * sit over the call log). During a call it sits above the call bar.
 */

import {
  WS_EVENTS,
  type EmailFinderFindDto,
  type WsEmailFinderFoundEvent,
} from '@pstn-twilio/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { useCallActive } from '../hooks/use-voice-device';
import { getSocket } from '../lib/realtime';

const DISMISSED_KEY = 'pstn-twilio.email-finder.dismissed';
// How long a find stays up; an older one isn't brought back on page load.
const SHOW_FOR_MS = 15 * 60_000;

const isFresh = (find: EmailFinderFindDto, now: number) =>
  now - Date.parse(find.foundAt) < SHOW_FOR_MS;

interface Props {
  spreadsheetId: string;
  sheetTitle: string;
  /** The tab's latest finds from the status poll, newest first. */
  recent?: EmailFinderFindDto[];
}

export function EmailFinderToasts({ spreadsheetId, sheetTitle, recent }: Props) {
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState<EmailFinderFindDto | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(readDismissed);
  const [now, setNow] = useState(() => Date.now());
  const known = useRef(new Set<string>());
  const inCall = useCallActive();

  function show(find: EmailFinderFindDto) {
    if (known.current.has(find.rowId)) return;
    known.current.add(find.rowId);
    // A find reported late (by the poll) never replaces a newer card.
    setCurrent((prev) =>
      prev && Date.parse(prev.foundAt) > Date.parse(find.foundAt) ? prev : find,
    );
    setNow(Date.now());
  }

  useEffect(() => {
    const socket = getSocket();
    function onFound(payload: WsEmailFinderFoundEvent) {
      show(payload.find);
      const { spreadsheetId: id, sheetTitle: title } = payload.find;
      void queryClient.invalidateQueries({ queryKey: ['email-finder', id, title] });
    }
    socket.on(WS_EVENTS.EMAIL_FINDER_FOUND, onFound);
    return () => {
      socket.off(WS_EVENTS.EMAIL_FINDER_FOUND, onFound);
    };
  }, [queryClient]);

  useEffect(() => {
    if (recent?.[0] && isFresh(recent[0], Date.now())) show(recent[0]);
  }, [recent]);

  // Keep "x min ago" current.
  useEffect(() => {
    if (!current) return;
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [current]);

  function dismiss(rowId: string) {
    setDismissed((prev) => {
      const next = new Set(prev).add(rowId);
      writeDismissed(next);
      return next;
    });
  }

  if (!current || dismissed.has(current.rowId) || !isFresh(current, now)) return null;

  return (
    <div
      aria-label="Email finder notifications"
      aria-live="polite"
      className={`fixed inset-x-2 z-40 sm:inset-x-auto sm:left-4 sm:w-[22rem] ${
        // Clear of the call bar at the bottom of the screen.
        inCall ? 'bottom-24' : 'bottom-2 sm:bottom-4'
      }`}
    >
      <FindNotice
        key={current.rowId}
        find={current}
        now={now}
        otherTab={current.spreadsheetId !== spreadsheetId || current.sheetTitle !== sheetTitle}
        onDismiss={() => dismiss(current.rowId)}
      />
    </div>
  );
}

function FindNotice({
  find,
  now,
  otherTab,
  onDismiss,
}: {
  find: EmailFinderFindDto;
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
      className={`border border-l-4 border-slate-300 border-l-emerald-500 bg-white p-3 text-sm text-slate-900 shadow-md transition duration-300 ${
        entered ? 'translate-x-0 opacity-100' : '-translate-x-4 opacity-0'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
          Email found ·{' '}
          <span className="font-normal normal-case text-slate-500">
            {ago(find.foundAt, now)}
            {otherTab && ` · tab "${find.sheetTitle}"`}
          </span>
          {find.method?.includes('Galaxy A20e') && (
            <span className="ml-1.5 border border-violet-300 bg-violet-50 px-1 py-px font-medium normal-case tracking-normal text-violet-700">
              via Galaxy A20e
            </span>
          )}
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
