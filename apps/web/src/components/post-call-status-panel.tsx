/**
 * Call status panel on the Dial page. It opens when an outbound call starts, so
 * statuses and notes can be taken during the call, and stays the same panel
 * through hangup; Push unlocks once the call has ended. The draft is saved in
 * the browser, so neither the next call nor a page reload loses it.
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
import { useEffect, useId, useState } from 'react';

import { api } from '../lib/api-client';

interface PostCallStatusPanelProps {
  /** Stable for the call's whole life, so the panel never remounts mid-draft. */
  callId: string;
  destinationE164: string;
  callerE164: string;
  /** ISO-8601 hangup time; null while the call is still up. */
  callEndedAt: string | null;
  spreadsheetId: string | null;
  sheetTitle: string | null;
  onDismiss: () => void;
  /** True while the panel holds statuses or notes that have not been pushed. */
  onUnsavedChange?: (callId: string, unsaved: boolean) => void;
}

interface Draft {
  selected: CallStatusTag[];
  note: string;
  pushed: SheetsStatusDto | null;
  /** selected + note as last pushed, to tell whether there are unpushed edits. */
  pushedSignature: string | null;
}

const DRAFT_PREFIX = 'pstn-twilio.post-call.draft.';

export function postCallDraftKey(callId: string): string {
  return DRAFT_PREFIX + callId;
}

function readDraft(callId: string): Draft {
  try {
    const raw = window.localStorage.getItem(postCallDraftKey(callId));
    if (raw) {
      const d = JSON.parse(raw) as Partial<Draft>;
      return {
        selected: (d.selected ?? []).filter((t): t is CallStatusTag =>
          (CALL_STATUS_TAGS as readonly string[]).includes(t),
        ),
        note: typeof d.note === 'string' ? d.note : '',
        pushed: d.pushed ?? null,
        pushedSignature: d.pushedSignature ?? null,
      };
    }
  } catch {
    /* storage unavailable or corrupt: start empty */
  }
  return { selected: [], note: '', pushed: null, pushedSignature: null };
}

function signature(selected: CallStatusTag[], note: string): string {
  return JSON.stringify([selected, note.trim()]);
}

// Numbers as locals write them: no country code.
function localNumber(e164: string): string {
  if (e164.startsWith('+44')) return `0${e164.slice(3)}`;
  if (e164.startsWith('+1')) return e164.slice(2);
  return e164.replace(/^\+/, '');
}

export function PostCallStatusPanel({
  callId,
  destinationE164,
  callerE164,
  callEndedAt,
  spreadsheetId,
  sheetTitle,
  onDismiss,
  onUnsavedChange,
}: PostCallStatusPanelProps) {
  const [initial] = useState(() => readDraft(callId));
  const [selected, setSelected] = useState<CallStatusTag[]>(initial.selected);
  const [note, setNote] = useState(initial.note);
  const [pushed, setPushed] = useState<SheetsStatusDto | null>(initial.pushed);
  const [pushedSignature, setPushedSignature] = useState<string | null>(initial.pushedSignature);
  const noteId = useId();

  const hasWork = selected.length > 0 || note.trim() !== '';
  const unsaved = hasWork && signature(selected, note) !== pushedSignature;

  useEffect(() => {
    try {
      window.localStorage.setItem(
        postCallDraftKey(callId),
        JSON.stringify({ selected, note, pushed, pushedSignature } satisfies Draft),
      );
    } catch {
      /* the draft still lives in this page */
    }
  }, [callId, selected, note, pushed, pushedSignature]);

  useEffect(() => {
    onUnsavedChange?.(callId, unsaved);
  }, [callId, unsaved, onUnsavedChange]);

  const push = useMutation({
    mutationFn: (sent: { tags: CallStatusTag[]; note: string }) =>
      api.sheets.push({
        spreadsheetId: spreadsheetId!,
        sheetTitle: sheetTitle!,
        orderedTags: sent.tags,
        customNote: sent.note.trim() || undefined,
        destinationE164,
        callerE164,
        callEndedAt: callEndedAt!,
      }),
    onSuccess: (result, sent) => {
      setPushed(result);
      setPushedSignature(signature(sent.tags, sent.note));
    },
  });

  const dismiss = () => {
    if (unsaved && !window.confirm('Discard the statuses and notes you have not pushed?')) return;
    onDismiss();
  };

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
  const callOver = callEndedAt !== null;
  const canPush = callOver && selected.length > 0 && !noTarget && !push.isPending;

  return (
    <section
      aria-label="Post-call status"
      className="space-y-3 rounded border border-indigo-200 bg-indigo-50 p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-indigo-900">
            {callOver ? (
              <>
                How did the call to{' '}
                <span className="font-mono">{localNumber(destinationE164)}</span> go?
              </>
            ) : (
              <>
                Call to <span className="font-mono">{localNumber(destinationE164)}</span> in
                progress
              </>
            )}
          </h2>
          <p className="text-xs text-indigo-600">
            {callOver
              ? 'Tap every status that applies. The number shows the order you picked them.'
              : 'Take notes now; they are kept when you hang up. Push unlocks after the call.'}
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
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
        <label htmlFor={noteId} className="mb-1 block text-xs font-medium text-indigo-800">
          Custom explanation{' '}
          <span className="font-normal text-indigo-500">
            (optional; goes into the cell and the follow-up email)
          </span>
        </label>
        <textarea
          id={noteId}
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
          onClick={() => push.mutate({ tags: selected, note })}
          disabled={!canPush}
          className="min-h-11 rounded bg-indigo-600 px-5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {push.isPending ? 'Pushing…' : pushed ? 'Push again (overwrites)' : 'Push'}
        </button>
        {hasWork && (
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

      {pushed && unsaved && !push.isPending && (
        <p className="text-xs text-amber-700">
          Changed since the last push. Push again to update the sheet.
        </p>
      )}

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
