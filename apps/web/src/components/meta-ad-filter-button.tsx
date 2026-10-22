/**
 * "Meta ad filter" for the selected sheet tab (Dial page).
 *
 * Copies the tab's rows whose school advertises on Meta into a new tab of the
 * SAME spreadsheet: "still advertising now" by default, or "advertised in the
 * past" from the dropdown. The evidence comes from the worker on the PC
 * (workers/meta-ads), which verifies the school's name and its Facebook page
 * against facebook.com/ads/library. Nothing here guesses a match, and the new
 * tab is rewritten on a second press rather than duplicated.
 */

import type {
  MetaAdFilterMode,
  MetaAdFilterResultDto,
  MetaAdsStatusDto,
} from '@pstn-twilio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '../lib/api-client';

interface Props {
  spreadsheetId: string;
  sheetTitle: string;
}

const MODE_LABEL: Record<MetaAdFilterMode, string> = {
  ACTIVE: 'Still advertising now',
  PAST: 'Advertised in the past',
};

/** "2h ago": enough to judge whether the list is still worth trusting. */
function since(iso: string | null): string {
  if (!iso) return 'never';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function summary(s: MetaAdsStatusDto): string {
  const parts = [
    `${s.active.toLocaleString()} advertising now`,
    `${s.past.toLocaleString()} have advertised`,
  ];
  if (s.both > 0) parts.push(`${s.both.toLocaleString()} in both lists`);
  return `${parts.join(' · ')} · last checked ${since(s.lastObservedAt)}`;
}

function outcome(r: MetaAdFilterResultDto): string {
  const verb = r.reused ? 'Updated' : 'Added';
  const rows = `${r.rows.toLocaleString()} of ${r.sourceRows.toLocaleString()} rows`;
  const bits = [`${verb} “${r.tabTitle}” with ${rows} ${MODE_LABEL[r.mode].toLowerCase()}.`];
  if (r.rows === 0) bits.push('No school in this tab matches that filter yet.');
  if (r.staleRows > 0)
    bits.push(
      `${r.staleRows.toLocaleString()} more matched only an older check, so they are not claimed as running now.`,
    );
  if (r.orphaned > 0)
    bits.push(
      `${r.orphaned.toLocaleString()} stored match${r.orphaned === 1 ? '' : 'es'} belong to rows that are no longer in this tab.`,
    );
  return bits.join(' ');
}

export function MetaAdFilterButton({ spreadsheetId, sheetTitle }: Props) {
  const queryClient = useQueryClient();
  // The default filter: who is still advertising now.
  const [mode, setMode] = useState<MetaAdFilterMode>('ACTIVE');
  const statusKey = ['meta-ads', spreadsheetId, sheetTitle] as const;

  const status = useQuery({
    queryKey: statusKey,
    queryFn: () => api.metaAds.status(spreadsheetId, sheetTitle),
    staleTime: 60_000,
    retry: false,
  });

  const run = useMutation({
    mutationFn: () => api.metaAds.filter(spreadsheetId, sheetTitle, mode),
    onSuccess: () => {
      // The new tab exists now: let the picker see it.
      void queryClient.invalidateQueries({ queryKey: ['sheets', 'tabs', spreadsheetId] });
      void queryClient.invalidateQueries({ queryKey: statusKey });
    },
  });

  const s = status.data;

  return (
    <div className="space-y-1 rounded border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-0.5">
          <p>
            <span className="font-medium">Meta ad filter:</span>{' '}
            {s && s.evidence > 0
              ? 'copies this tab’s rows whose school advertises on Meta into a new tab of this spreadsheet.'
              : 'checks this tab against the Meta Ad Library and copies the matching rows into a new tab of this spreadsheet.'}
          </p>
          {s && s.evidence > 0 && <p className="text-slate-500">{summary(s)}</p>}
          {s && s.evidence === 0 && (
            <p className="text-amber-700">
              No Meta matches reported for this tab yet. Run{' '}
              <code className="rounded bg-amber-50 px-1">workers\meta-ads\start.ps1</code> on your
              PC, then press again — the worker verifies every school&apos;s name and Facebook page
              before anything is copied.
            </p>
          )}
          {status.isError && (
            <p className="text-rose-700">
              Meta ad filter: {status.error instanceof Error ? status.error.message : 'unavailable'}
            </p>
          )}
          {run.isError && (
            <p className="text-rose-700">
              Meta ad filter: {run.error instanceof Error ? run.error.message : 'could not run'}
            </p>
          )}
          {run.data && <p className="text-emerald-700">{outcome(run.data)}</p>}
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="meta-ad-mode" className="sr-only">
            Meta ad filter
          </label>
          <select
            id="meta-ad-mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as MetaAdFilterMode)}
            className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs focus:border-slate-500 focus:outline-none"
          >
            <option value="ACTIVE">{MODE_LABEL.ACTIVE}</option>
            <option value="PAST">{MODE_LABEL.PAST}</option>
          </select>
          <button
            type="button"
            onClick={() => run.mutate()}
            disabled={run.isPending}
            className="rounded bg-slate-800 px-3 py-1 font-medium text-white hover:bg-slate-700 disabled:opacity-60"
          >
            {run.isPending ? 'Filtering…' : 'Meta ad filter'}
          </button>
        </div>
      </div>
    </div>
  );
}
