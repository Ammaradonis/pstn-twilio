/**
 * "Personalize" for the selected tab (Dial page).
 *
 * Reads what each row's school publishes about itself — its programmes, who
 * teaches them, the timetable, what is coming up, how long it has been running
 * — and stores it per row. Every status push after that carries three
 * sentences built from those facts for the status you picked, so the cell says
 * "Tuesday is your kids karate night" instead of nothing.
 *
 * A separate finder job from the address hunt and the social enrichment, and it
 * writes no sheet column: it only reads pages, and it reuses the address
 * finder's page cache, so a tab that has already been researched costs little.
 */

import type { EmailFinderStatusDto } from '@pstn-twilio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../lib/api-client';

interface Props {
  spreadsheetId: string;
  sheetTitle: string;
}

export function PersonalizeButton({ spreadsheetId, sheetTitle }: Props) {
  const queryClient = useQueryClient();
  const key = ['personalisation', spreadsheetId, sheetTitle];

  const start = useMutation({
    mutationFn: () => api.personalisation.start(spreadsheetId, sheetTitle),
    onSuccess: (data) => {
      queryClient.setQueryData(key, data);
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });

  const status = useQuery({
    queryKey: key,
    queryFn: () => api.personalisation.status(spreadsheetId, sheetTitle),
    // Poll only while a run is in flight, so an idle page is quiet.
    refetchInterval: (q) =>
      q.state.data?.status === 'RUNNING' ? 15_000 : q.state.data?.jobId ? 60_000 : false,
    enabled: start.isSuccess,
  });

  const toggle = useMutation({
    mutationFn: (action: 'pause' | 'resume') =>
      api.personalisation.setRunning(status.data!.jobId!, action),
    onSuccess: (data) => queryClient.setQueryData(key, data),
  });

  if (start.isError) {
    return (
      <p className="text-xs text-rose-700">
        Personalize: {start.error instanceof Error ? start.error.message : 'could not start'}
      </p>
    );
  }

  const s: EmailFinderStatusDto | undefined = status.data ?? start.data;
  const running = s?.status === 'RUNNING' && !!s.jobId && s.done < s.total;
  const pct = s && s.total ? Math.round((s.done / s.total) * 100) : 0;
  const withProfile = s?.withProfile ?? s?.found ?? 0;

  return (
    <div className="space-y-1 rounded border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p>
            <span className="font-medium">Personalize:</span>{' '}
            {!s || (!s.jobId && !start.isSuccess)
              ? 'reads each school\u2019s programmes, staff and timetable for the sentences in the Status cell.'
              : s.total === 0
                ? 'every row already has a profile.'
                : `${s.done.toLocaleString()} of ${s.total.toLocaleString()} rows read \u00b7 ${withProfile.toLocaleString()} with facts worth a sentence`}
          </p>
          {!!s?.jobId && s.total > 0 && (
            <p className="text-slate-500">
              Writes no column. A push after this carries three sentences built from these facts,
              picked by the status you choose.
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
            {start.isPending ? 'Starting…' : running ? 'Reading…' : 'Personalize'}
          </button>
        </div>
      </div>

      {!!s?.jobId && s.total > 0 && (
        <div className="h-1.5 overflow-hidden rounded bg-slate-200" aria-hidden="true">
          <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}

      {!!s?.jobId && s.done < s.total && (
        <p className={s.workerOnline ? 'text-emerald-700' : 'text-amber-700'}>
          {s.workerOnline
            ? 'Running on your PC in the background, from the pages the email finder already read.'
            : 'Waiting for the worker on your PC. Run workers\\email-finder\\start-email-finder.ps1.'}
        </p>
      )}
    </div>
  );
}
