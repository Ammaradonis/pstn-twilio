/**
 * Email finder progress for the selected sheet tab (Dial page).
 *
 * Selecting a tab queues its rows that have no email yet; the worker on the
 * user's PC researches them in the background and fills the email,
 * emailType, emailSource, decisionMaker and contactForm columns. Calls are
 * never interrupted: the work happens on the PC, not in this page.
 */

import type { EmailFinderStatusDto } from '@pstn-twilio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { api } from '../lib/api-client';

interface Props {
  spreadsheetId: string;
  sheetTitle: string;
}

export function EmailFinderStatus({ spreadsheetId, sheetTitle }: Props) {
  const queryClient = useQueryClient();
  const key = ['email-finder', spreadsheetId, sheetTitle];

  const start = useMutation({
    mutationFn: () => api.emailFinder.start(spreadsheetId, sheetTitle),
    onSuccess: (data) => queryClient.setQueryData(key, data),
  });
  // Queue the tab whenever it is selected; the API skips rows already done.
  useEffect(() => {
    start.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spreadsheetId, sheetTitle]);

  const status = useQuery({
    queryKey: key,
    queryFn: () => api.emailFinder.status(spreadsheetId, sheetTitle),
    refetchInterval: (q) => (q.state.data?.status === 'RUNNING' ? 15_000 : 60_000),
    enabled: start.isSuccess || start.isError,
  });

  const toggle = useMutation({
    mutationFn: (action: 'pause' | 'resume') =>
      api.emailFinder.setRunning(status.data!.jobId!, action),
    onSuccess: (data) => queryClient.setQueryData(key, data),
  });

  if (start.isError) {
    return (
      <p className="text-xs text-rose-700">
        Email finder: {start.error instanceof Error ? start.error.message : 'could not start'}
      </p>
    );
  }
  const s: EmailFinderStatusDto | undefined = status.data ?? start.data;
  if (!s) return <p className="text-xs text-slate-400">Email finder: preparing this tab…</p>;

  const pct = s.total ? Math.round((s.done / s.total) * 100) : 100;
  return (
    <div className="space-y-1 rounded border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p>
          <span className="font-medium">Email finder:</span>{' '}
          {s.total === 0
            ? 'every row already has an email.'
            : `${s.done.toLocaleString()} of ${s.total.toLocaleString()} rows checked · ${s.found.toLocaleString()} emails · ${s.contactForms.toLocaleString()} contact forms only`}
          {s.alreadyHadEmail > 0 && ` · ${s.alreadyHadEmail.toLocaleString()} rows already had one`}
        </p>
        {s.jobId && (s.status === 'RUNNING' || s.status === 'PAUSED') && s.done < s.total && (
          <button
            type="button"
            onClick={() => toggle.mutate(s.status === 'RUNNING' ? 'pause' : 'resume')}
            disabled={toggle.isPending}
            className="rounded border border-slate-300 bg-white px-2 py-0.5 hover:bg-slate-100 disabled:opacity-60"
          >
            {s.status === 'RUNNING' ? 'Pause' : 'Resume'}
          </button>
        )}
      </div>
      {s.total > 0 && (
        <div className="h-1.5 overflow-hidden rounded bg-slate-200" aria-hidden="true">
          <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
      {s.done < s.total && s.status !== 'PAUSED' && (
        <p className={s.workerOnline ? 'text-emerald-700' : 'text-amber-700'}>
          {s.workerOnline
            ? 'Running on your PC in the background.'
            : 'Waiting for the email finder on your PC. It starts when you log in to Windows, or run workers\\email-finder\\start-email-finder.ps1.'}
        </p>
      )}
    </div>
  );
}
