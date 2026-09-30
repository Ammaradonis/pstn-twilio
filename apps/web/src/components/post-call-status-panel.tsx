/**
 * Post-call status panel on the Dial page, shown after an outbound call ends.
 *
 * Click as many statuses as apply; each shows its selection order. Clicking a
 * selected status removes it, and clicking it again puts it at the end, so the
 * order always reflects the latest choices. The first selected status that
 * sends email picks the 48-hour follow-up template. Push writes the statuses,
 * the custom explanation, the caller ID and the school's local hangup time into
 * the sheet row; the page stays put and a second push overwrites the cell.
 */

import {
  CALL_STATUS_TAGS,
  pickFollowUpTemplate,
  type CallStatusTag,
  type SheetsStatusDto,
} from '@pstn-twilio/shared';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '../lib/api-client';

interface PostCallStatusPanelProps {
  destinationE164: string;
  callerE164: string;
  /** ISO-8601 hangup time. */
  callEndedAt: string;
  spreadsheetId: string | null;
  sheetTitle: string | null;
  onDismiss: () => void;
}

// Numbers as locals write them: no country code.
function localNumber(e164: string): string {
  if (e164.startsWith('+44')) return `0${e164.slice(3)}`;
  if (e164.startsWith('+1')) return e164.slice(2);
  return e164.replace(/^\+/, '');
}

export function PostCallStatusPanel({
  destinationE164,
  callerE164,
  callEndedAt,
  spreadsheetId,
  sheetTitle,
  onDismiss,
}: PostCallStatusPanelProps) {
  const [selected, setSelected] = useState<CallStatusTag[]>([]);
  const [note, setNote] = useState('');
  const [pushed, setPushed] = useState<SheetsStatusDto | null>(null);

  const push = useMutation({
    mutationFn: () =>
      api.sheets.push({
        spreadsheetId: spreadsheetId!,
        sheetTitle: sheetTitle!,
        orderedTags: selected,
        customNote: note.trim() || undefined,
        destinationE164,
        callerE164,
        callEndedAt,
      }),
    onSuccess: setPushed,
  });

  const toggle = (tag: CallStatusTag) => {
    setSelected((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  };

  const followUp = selected.length > 0 ? pickFollowUpTemplate(selected) : null;
  const preview = [
    selected.join(', '),
    note.replace(/\s+/g, ' ').trim(),
    `from: ${localNumber(callerE164)}`,
    'time: (their local time)',
  ]
    .filter(Boolean)
    .join(', ');
  const noTarget = !spreadsheetId || !sheetTitle;
  const canPush = selected.length > 0 && !noTarget && !push.isPending;

  return (
    <section
      aria-label="Post-call status"
      className="space-y-3 rounded border border-indigo-200 bg-indigo-50 p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-indigo-900">
            How did the call to <span className="font-mono">{localNumber(destinationE164)}</span>{' '}
            go?
          </h2>
          <p className="text-xs text-indigo-600">
            Tap every status that applies. The number shows the order you picked them.
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs text-indigo-500 hover:text-indigo-700"
        >
          Dismiss
        </button>
      </div>

      {noTarget && (
        <p className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
          Pick a spreadsheet and tab under Sheet target before pushing.
        </p>
      )}

      <div
        className="grid grid-cols-2 gap-2 sm:grid-cols-3"
        role="group"
        aria-label="Call statuses"
      >
        {CALL_STATUS_TAGS.map((tag) => {
          const order = selected.indexOf(tag) + 1;
          return (
            <button
              key={tag}
              type="button"
              aria-pressed={order > 0}
              onClick={() => toggle(tag)}
              className={`relative min-h-11 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                order > 0
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'border border-indigo-200 bg-white text-indigo-800 hover:bg-indigo-100'
              }`}
            >
              {tag}
              {order > 0 && (
                <span
                  aria-hidden="true"
                  className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-indigo-400 bg-white text-[10px] font-bold text-indigo-700"
                >
                  {order}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div>
        <label htmlFor="post-call-note" className="mb-1 block text-xs font-medium text-indigo-800">
          Custom explanation{' '}
          <span className="font-normal text-indigo-500">
            (optional; goes into the cell and the follow-up email)
          </span>
        </label>
        <textarea
          id="post-call-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={1000}
          placeholder="e.g. owner is Coach Mike, back from a tournament next week"
          className="w-full resize-none rounded border border-indigo-200 px-2 py-1 text-sm focus:border-indigo-400 focus:outline-none"
        />
      </div>

      {selected.length > 0 && (
        <div className="space-y-1 rounded border border-indigo-100 bg-white px-3 py-2 text-xs text-slate-700">
          <p>
            <span className="font-medium">Cell:</span> {preview}
          </p>
          <p>
            <span className="font-medium">Follow-up email:</span>{' '}
            {followUp &&
              (followUp.template === null
                ? followUp.reason
                : `"${followUp.template}" template, 48 hours after the call (picked by "${followUp.tag}")`)}
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => push.mutate()}
          disabled={!canPush}
          className="min-h-11 rounded bg-indigo-600 px-5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {push.isPending ? 'Pushing…' : pushed ? 'Push again (overwrites)' : 'Push'}
        </button>
        {selected.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setSelected([]);
              setNote('');
            }}
            className="text-xs text-indigo-500 hover:text-indigo-700"
          >
            Clear
          </button>
        )}
      </div>

      {pushed && !push.isPending && !push.isError && (
        <div
          role="status"
          className="space-y-1 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900"
        >
          <p className="font-medium">
            Row {pushed.rowIndex} of {pushed.sheetTitle} updated:
          </p>
          <p className="font-mono">{pushed.cellValue}</p>
          <p>
            Time zone {pushed.timeZone}
            {pushed.timeZoneSource === 'guess' && (
              <span className="text-amber-700">
                {' '}
                (guessed from the state; add a ZIP to the address to be sure)
              </span>
            )}
          </p>
          <p>
            {pushed.emailStatus === 'PENDING' && pushed.emailDueAt
              ? `Follow-up email to ${pushed.emailTo} scheduled for ${new Date(pushed.emailDueAt).toLocaleString()}.`
              : pushed.emailNote}
          </p>
          {pushed.duplicateRows.length > 0 && (
            <p className="text-amber-700">
              This number is also on row{pushed.duplicateRows.length > 1 ? 's' : ''}{' '}
              {pushed.duplicateRows.join(', ')}; only row {pushed.rowIndex} was updated.
            </p>
          )}
        </div>
      )}

      {push.isError && (
        <p
          role="alert"
          className="rounded border border-rose-200 bg-rose-50 px-2 py-1 text-xs text-rose-700"
        >
          {push.error instanceof Error ? push.error.message : 'Push failed.'}
        </p>
      )}
    </section>
  );
}
