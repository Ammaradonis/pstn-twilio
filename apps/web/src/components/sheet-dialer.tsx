import { normalizeDialablePhoneNumber, type SheetDialRowDto } from '@pstn-twilio/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../lib/api-client';
import { formatPhone } from '../lib/format';

/** A row of the picked tab, with the number to dial (null when none is dialable). */
export interface SheetDialEntry extends SheetDialRowDto {
  e164: string | null;
}

const POSITION_PREFIX = 'pstn-twilio.sheet-dialer.position:';

function positionKey(spreadsheetId: string, sheetTitle: string): string {
  return `${POSITION_PREFIX}${spreadsheetId}:${sheetTitle}`;
}

function readPosition(spreadsheetId: string, sheetTitle: string): number | null {
  try {
    const value = Number(window.localStorage.getItem(positionKey(spreadsheetId, sheetTitle)));
    return Number.isInteger(value) && value > 1 ? value : null;
  } catch {
    return null;
  }
}

function writePosition(spreadsheetId: string, sheetTitle: string, row: number): void {
  try {
    window.localStorage.setItem(positionKey(spreadsheetId, sheetTitle), String(row));
  } catch {
    // Private mode: the position lasts until the page is closed.
  }
}

/**
 * The number to dial from a phone cell. A cell may list several numbers
 * ("512-555-0101 / 512-555-0102"); the first dialable one is used.
 */
export function dialableFromCell(cell: string, country: 'US' | 'GB'): string | null {
  const whole = normalizeDialablePhoneNumber(cell, country);
  if (whole) return whole;
  for (const piece of cell.split(/[/,;|\n]|\bor\b|\s{2,}/i)) {
    const number = piece.trim() && normalizeDialablePhoneNumber(piece, country);
    if (number) return number;
  }
  return null;
}

/** "Voicemail, note…, from: …" → "Voicemail": the first status the last call pushed. */
function statusLabel(status: string): string {
  return status.split(',')[0]!.trim().slice(0, 40);
}

interface SheetDialerProps {
  spreadsheetId: string | null;
  sheetTitle: string | null;
  dialingCountry: 'US' | 'GB';
  /** A call can be placed (number loaded, device up, microphone allowed, nothing being set up). */
  canDial: boolean;
  inCall: boolean;
  /** Calls the number; during a call the page hangs up first (Next only). */
  onDial: (e164: string, entry: SheetDialEntry) => void;
}

/**
 * Calls the picked tab's phone numbers one after another: Start (the first
 * row), Next (the row after the last one called) and Start from row (typed on
 * a keypad). The last row called is remembered per tab, so Next carries on
 * after a reload.
 */
export function SheetDialer({
  spreadsheetId,
  sheetTitle,
  dialingCountry,
  canDial,
  inCall,
  onDial,
}: SheetDialerProps) {
  const enabled = Boolean(spreadsheetId && sheetTitle);
  const list = useQuery({
    queryKey: ['sheets', 'dial-list', spreadsheetId, sheetTitle],
    queryFn: () => api.sheets.dialList(spreadsheetId!, sheetTitle!),
    enabled,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const [position, setPosition] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [keypadOpen, setKeypadOpen] = useState(false);

  useEffect(() => {
    setPosition(spreadsheetId && sheetTitle ? readPosition(spreadsheetId, sheetTitle) : null);
    setNotice(null);
    setKeypadOpen(false);
  }, [spreadsheetId, sheetTitle]);

  const entries = useMemo<SheetDialEntry[]>(
    () =>
      (list.data?.rows ?? []).map((row) => ({
        ...row,
        e164: dialableFromCell(row.phone, dialingCountry),
      })),
    [list.data, dialingCountry],
  );
  const dialable = useMemo(() => entries.filter((e) => e.e164), [entries]);
  const current = entries.find((e) => e.row === position) ?? null;
  const next =
    position === null ? (dialable[0] ?? null) : (dialable.find((e) => e.row > position) ?? null);
  const withStatus = entries.filter((e) => e.status).length;

  // Keep the row being called in view.
  const rowRefs = useRef(new Map<number, HTMLLIElement>());
  useEffect(() => {
    if (position !== null) rowRefs.current.get(position)?.scrollIntoView?.({ block: 'nearest' });
  }, [position, entries]);

  function dial(entry: SheetDialEntry, message: string | null = null) {
    if (!entry.e164 || !spreadsheetId || !sheetTitle) return;
    setPosition(entry.row);
    writePosition(spreadsheetId, sheetTitle, entry.row);
    setNotice(message);
    onDial(entry.e164, entry);
  }

  function start() {
    const first = dialable[0];
    if (first) dial(first);
  }

  function callNext() {
    if (next) dial(next);
    else setNotice(`That was the last number in ${sheetTitle}.`);
  }

  function startFromRow(row: number) {
    setKeypadOpen(false);
    const target = dialable.find((e) => e.row >= row);
    if (!target) {
      setNotice(`No phone number at or after row ${row} in ${sheetTitle}.`);
      return;
    }
    dial(
      target,
      target.row === row ? null : `Row ${row} has no number to dial, so row ${target.row} is next.`,
    );
  }

  if (!enabled) {
    return (
      <div className="rounded border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-700">Sheet dialer</h2>
        <p className="mt-1 text-sm text-slate-600">
          Pick a spreadsheet and tab under <strong>Sheet target</strong> below to load its phone
          numbers. Then Start, Next and Start from row call them for you.
        </p>
      </div>
    );
  }

  const busy = !canDial;
  const describe = (entry: SheetDialEntry) =>
    `Row ${entry.row}${entry.name ? ` · ${entry.name}` : ''} · ${formatPhone(entry.e164 ?? entry.phone)}`;

  return (
    <div className="rounded border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-700">
          Sheet dialer · <span className="font-normal">{sheetTitle}</span>
        </h2>
        <div className="flex items-center gap-3 text-xs text-slate-500">
          {list.data && (
            <span>
              {dialable.length.toLocaleString()} numbers
              {list.data.phoneColumn ? ` (column ${list.data.phoneColumn})` : ''}
              {withStatus > 0 && ` · ${withStatus.toLocaleString()} with a status`}
            </span>
          )}
          <button
            type="button"
            onClick={() => void list.refetch()}
            disabled={list.isFetching}
            className="rounded border border-slate-300 px-2 py-0.5 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            {list.isFetching ? 'Loading…' : 'Reload'}
          </button>
        </div>
      </div>

      {list.isLoading && <p className="mt-2 text-sm text-slate-500">Loading phone numbers…</p>}
      {list.isError && (
        <p role="alert" className="mt-2 text-sm text-rose-700">
          Could not load the phone numbers:{' '}
          {list.error instanceof Error ? list.error.message : String(list.error)}
        </p>
      )}
      {list.data && list.data.phoneColumn === null && (
        <p role="alert" className="mt-2 text-sm text-amber-800">
          Row 1 of {sheetTitle} has no phone column (for example &quot;phoneNumber&quot;).
        </p>
      )}

      {list.data && dialable.length > 0 && (
        <>
          <p className="mt-2 text-sm text-slate-700" aria-live="polite">
            {current ? (
              <>
                Last called: <span className="font-medium">{describe(current)}</span>
              </>
            ) : (
              'Nothing called from this tab yet.'
            )}
          </p>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={start}
              disabled={busy || inCall}
              className="rounded border border-emerald-600 px-3 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Start
            </button>
            <button
              type="button"
              onClick={() => setKeypadOpen(true)}
              disabled={busy || inCall}
              className="rounded border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Start from row…
            </button>
          </div>

          <button
            type="button"
            onClick={callNext}
            disabled={busy || !next}
            aria-label={
              next
                ? `${inCall ? 'Hang up and call next' : 'Next'}: ${describe(next)}`
                : 'Next: no more numbers'
            }
            className="mt-3 flex w-full flex-col items-center justify-center rounded-lg bg-emerald-600 px-4 py-6 text-white shadow hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="text-4xl font-bold tracking-wide">
              {inCall ? 'Hang up & next' : 'Next'}
            </span>
            <span className="mt-1 max-w-full truncate text-sm font-medium text-emerald-50">
              {next ? describe(next) : 'No more numbers in this tab'}
            </span>
          </button>

          {notice && (
            <p role="status" className="mt-2 text-sm text-amber-800">
              {notice}
            </p>
          )}

          <ol
            aria-label={`Phone numbers in ${sheetTitle}`}
            className="mt-3 max-h-72 divide-y divide-slate-100 overflow-y-auto rounded border border-slate-200 text-sm"
          >
            {entries.map((entry) => {
              const isCurrent = entry.row === position;
              const isNext = entry.row === next?.row;
              return (
                <li
                  key={entry.row}
                  ref={(el) => {
                    if (el) rowRefs.current.set(entry.row, el);
                    else rowRefs.current.delete(entry.row);
                  }}
                  aria-current={isCurrent ? 'true' : undefined}
                  className={`flex items-center gap-2 px-2 py-1.5 ${
                    isCurrent ? 'bg-emerald-50' : isNext ? 'bg-sky-50' : ''
                  } ${entry.e164 ? '' : 'text-slate-400'}`}
                >
                  <span className="w-12 shrink-0 text-right font-mono text-xs text-slate-500">
                    {entry.row}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{entry.name || '—'}</span>
                  {entry.status && (
                    <span
                      title={entry.status}
                      className="hidden max-w-[10rem] shrink-0 truncate rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 sm:inline"
                    >
                      {statusLabel(entry.status)}
                    </span>
                  )}
                  {isNext && (
                    <span className="shrink-0 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-800">
                      Next
                    </span>
                  )}
                  <span className="shrink-0 font-mono text-xs">
                    {entry.e164 ? formatPhone(entry.e164) : `${entry.phone} (not dialable)`}
                  </span>
                </li>
              );
            })}
          </ol>
        </>
      )}
      {list.data && list.data.phoneColumn !== null && dialable.length === 0 && (
        <p className="mt-2 text-sm text-slate-600">No dialable phone numbers in {sheetTitle}.</p>
      )}

      {keypadOpen && (
        <RowKeypad
          lastRow={entries[entries.length - 1]?.row ?? 2}
          onCancel={() => setKeypadOpen(false)}
          onSubmit={startFromRow}
        />
      )}
    </div>
  );
}

const ROW_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/** Keypad for "Start from row": type the sheet row number to call first. */
function RowKeypad({
  lastRow,
  onCancel,
  onSubmit,
}: {
  lastRow: number;
  onCancel: () => void;
  onSubmit: (row: number) => void;
}) {
  const [digits, setDigits] = useState('');
  const row = Number(digits);
  const valid = digits !== '' && row >= 2;

  const press = (digit: string) =>
    setDigits((prev) => (prev + digit).replace(/^0+/, '').slice(0, 6));
  const back = () => setDigits((prev) => prev.slice(0, -1));

  // The physical keyboard works too: digits, Backspace, Enter, Escape.
  const submitRef = useRef<() => void>(() => {});
  submitRef.current = () => {
    if (valid) onSubmit(row);
  };
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (/^[0-9]$/.test(event.key)) press(event.key);
      else if (event.key === 'Backspace') back();
      else if (event.key === 'Enter') submitRef.current();
      else if (event.key === 'Escape') onCancel();
      else return;
      event.preventDefault();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="row-keypad-title"
        className="w-full max-w-xs rounded border border-slate-200 bg-white p-4 shadow-lg"
      >
        <h2 id="row-keypad-title" className="text-base font-semibold text-slate-900">
          Start from row
        </h2>
        <p className="mt-1 text-xs text-slate-500">Rows 2 to {lastRow}. Row 1 is the header.</p>
        <output
          aria-label="Row number"
          className="mt-3 block h-12 rounded border border-slate-300 px-3 text-right font-mono text-3xl leading-[3rem] text-slate-900"
        >
          {digits || <span className="text-slate-300">row</span>}
        </output>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {ROW_KEYS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => press(d)}
              className="rounded border border-slate-200 py-3 text-xl hover:bg-slate-50"
            >
              {d}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setDigits('')}
            className="rounded border border-slate-200 py-3 text-sm hover:bg-slate-50"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => press('0')}
            className="rounded border border-slate-200 py-3 text-xl hover:bg-slate-50"
          >
            0
          </button>
          <button
            type="button"
            onClick={back}
            aria-label="Delete last digit"
            className="rounded border border-slate-200 py-3 text-xl hover:bg-slate-50"
          >
            ⌫
          </button>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => submitRef.current()}
            disabled={!valid}
            className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
          >
            {valid ? `Call row ${row}` : 'Call row'}
          </button>
        </div>
      </div>
    </div>
  );
}
