/**
 * "Enrich socials" for the selected sheet tab (Dial page).
 *
 * A separate job from the email finder: it hunts each row's Facebook, Instagram,
 * YouTube, X/Twitter, LinkedIn and TikTok profile URLs and writes them into those
 * columns, replacing whatever is there with the verified profile. The address
 * finder never touches those cells, so the two can run for one tab at once.
 *
 * Nothing starts until the button is pressed: selecting a tab does not spend
 * lookups on enrichment. The work runs on the PC (workers/email-finder), which
 * drives the Galaxy A20e for the profiles the web cannot confirm.
 */

import type { EmailFinderStatusDto } from '@pstn-twilio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../lib/api-client';

interface Props {
  spreadsheetId: string;
  sheetTitle: string;
}

export function SocialEnrichmentButton({ spreadsheetId, sheetTitle }: Props) {
  const queryClient = useQueryClient();
  const key = ['social-enrichment', spreadsheetId, sheetTitle];

  const start = useMutation({
    mutationFn: () => api.socialEnrichment.start(spreadsheetId, sheetTitle),
    onSuccess: (data) => {
      queryClient.setQueryData(key, data);
      // The panel now needs to poll this job.
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });

  const status = useQuery({
    queryKey: key,
    queryFn: () => api.socialEnrichment.status(spreadsheetId, sheetTitle),
    // Poll only while a run is in flight, so an idle page is quiet.
    refetchInterval: (q) =>
      q.state.data?.status === 'RUNNING' ? 15_000 : q.state.data?.jobId ? 60_000 : false,
    enabled: start.isSuccess,
  });

  const toggle = useMutation({
    mutationFn: (action: 'pause' | 'resume') =>
      api.socialEnrichment.setRunning(status.data!.jobId!, action),
    onSuccess: (data) => queryClient.setQueryData(key, data),
  });

  if (start.isError) {
    return (
      <p className="text-xs text-rose-700">
        Social enrichment: {start.error instanceof Error ? start.error.message : 'could not start'}
      </p>
    );
  }

  const s: EmailFinderStatusDto | undefined = status.data ?? start.data;
  const running = s?.status === 'RUNNING' && !!s.jobId && s.done < s.total;
  const pct = s && s.total ? Math.round((s.done / s.total) * 100) : 0;

  return (
    <div className="space-y-1 rounded border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p>
            <span className="font-medium">Social enrichment:</span>{' '}
            {!s || (!s.jobId && !start.isSuccess)
              ? 'fills Facebook, Instagram, YouTube, X, LinkedIn and TikTok for this tab.'
              : s.total === 0
                ? 'every row already has all its social columns filled.'
                : `${s.done.toLocaleString()} of ${s.total.toLocaleString()} rows checked · ${s.found.toLocaleString()} with a profile found`}
          </p>
          {!!s?.jobId && s.total > 0 && (
            <p className="text-slate-500">
              Found profiles replace what is in those cells. The email, phone and website columns
              are never touched.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {s?.jobId && (s.status === 'RUNNING' || s.status === 'PAUSED') && s.done < s.total && (
            <button
              type="button"
              onClick={() => toggle.mutate(s.status === 'RUNNING' ? 'pause' : 'resume')}
              disabled={toggle.isPending}
              className="rounded border border-slate-300 bg-white px-2 py-0.5 hover:bg-slate-100 disabled:opacity-60"
            >
              {s.status === 'RUNNING' ? 'Pause' : 'Resume'}
            </button>
          )}
          <button
            type="button"
            onClick={() => start.mutate()}
            disabled={start.isPending || running}
            className="rounded bg-slate-800 px-3 py-1 font-medium text-white hover:bg-slate-700 disabled:opacity-60"
          >
            {start.isPending ? 'Starting…' : running ? 'Enriching…' : 'Enrich socials'}
          </button>
        </div>
      </div>

      {!!s?.jobId && s.total > 0 && (
        <div className="h-1.5 overflow-hidden rounded bg-slate-200" aria-hidden="true">
          <div className="h-full bg-sky-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}

      {!!s?.jobId && s.done < s.total && (
        <p className={s.workerOnline ? 'text-emerald-700' : 'text-amber-700'}>
          {s.workerOnline
            ? 'Running on your PC in the background. The Galaxy A20e is used for the profiles the web cannot confirm.'
            : 'Waiting for the worker on your PC. Run workers\\email-finder\\start-email-finder.ps1.'}
        </p>
      )}

      {!!s?.issues?.length && (
        <details className="text-amber-800">
          <summary className="cursor-pointer">Rows that need attention</summary>
          <ul className="mt-1 space-y-1">
            {s.issues.map((issue, i) => (
              <li key={i}>
                {issue.school}: {issue.note}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
