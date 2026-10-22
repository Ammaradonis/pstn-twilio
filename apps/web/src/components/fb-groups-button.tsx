/**
 * "FB groups" for the Dial page.
 *
 * One click starts the rolling run the worker on this PC drives: it turns every
 * address in U.S. Conquest and The Official UK into localized group searches,
 * joins the groups that score as owner-facing, then likes, comments, replies,
 * follows and finally DMs the people it has real history with.
 *
 * Nothing happens until the button is pressed, and pressing it while a run is
 * open resumes that run instead of starting a second one. Pause stops it at the
 * end of the current batch; Stop closes the run for good.
 */

import type { FbGroupsStage, FbGroupsStatusDto } from '@pstn-twilio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { api } from '../lib/api-client';

const KEY = ['fb-groups', 'status'] as const;

const STAGE_LABEL: Record<FbGroupsStage, string> = {
  SEARCH: 'finding groups',
  JOIN: 'joining groups',
  ENGAGE: 'liking, commenting and following',
  OUTREACH: 'sending DMs',
};

function summary(s: FbGroupsStatusDto): string {
  const bits = [
    `${s.searches.toLocaleString()} search${s.searches === 1 ? '' : 'es'}`,
    `${s.groupsFound.toLocaleString()} group${s.groupsFound === 1 ? '' : 's'} found`,
    `${s.joined.toLocaleString()} joined`,
  ];
  if (s.likes) bits.push(`${s.likes.toLocaleString()} likes`);
  if (s.comments) bits.push(`${s.comments.toLocaleString()} comments`);
  if (s.replies) bits.push(`${s.replies.toLocaleString()} replies`);
  if (s.follows) bits.push(`${s.follows.toLocaleString()} follows`);
  if (s.dms) bits.push(`${s.dms.toLocaleString()} DM${s.dms === 1 ? '' : 's'}`);
  return bits.join(' · ');
}

export function FbGroupsButton() {
  const queryClient = useQueryClient();

  const status = useQuery({
    queryKey: KEY,
    queryFn: () => api.fbGroups.status(),
    // Poll only while running, and slowly once it has a run to show.
    refetchInterval: (q) =>
      q.state.data?.status === 'RUNNING' ? 15_000 : q.state.data?.runId ? 60_000 : false,
  });

  const start = useMutation({
    mutationFn: () => api.fbGroups.start(),
    onSuccess: (data) => queryClient.setQueryData(KEY, data),
  });

  const toggle = useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'cancel') =>
      api.fbGroups.setRunning(status.data!.runId!, action),
    onSuccess: (data) => queryClient.setQueryData(KEY, data),
  });

  // A run that starts somewhere else (another tab) should show up here too.
  useEffect(() => {
    if (status.data?.status === 'RUNNING')
      void queryClient.invalidateQueries({ queryKey: ['fb-groups'] });
  }, [status.data?.status, queryClient]);

  if (start.isError) {
    return (
      <p className="text-xs text-rose-700">
        Facebook groups: {start.error instanceof Error ? start.error.message : 'could not start'}
      </p>
    );
  }

  const s: FbGroupsStatusDto | undefined = status.data ?? start.data;
  const running = s?.status === 'RUNNING';
  const paused = s?.status === 'PAUSED';
  const open = running || paused;

  return (
    <div className="space-y-1 rounded border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-0.5">
          <p>
            <span className="font-medium">Facebook groups:</span>{' '}
            {!s?.runId
              ? 'finds owner groups from every address in U.S. Conquest and The Official UK, joins them, then likes, comments, replies, follows and DMs slowly.'
              : running
                ? `${STAGE_LABEL[s.stage ?? 'SEARCH']}… ${summary(s)}`
                : paused
                  ? `Paused — ${summary(s)}`
                  : s.status === 'CANCELLED'
                    ? `Stopped — ${summary(s)}`
                    : `Finished — ${summary(s)}`}
          </p>
          {!!s?.plan && (
            <p className="text-slate-500">
              {s.plan.covered.toLocaleString()} of {s.plan.addresses.toLocaleString()} addresses
              covered by {s.plan.searches.toLocaleString()} searches
              {s.plan.uncovered > 0
                ? ` · ${s.plan.uncovered.toLocaleString()} uncovered`
                : ' · none uncovered'}
            </p>
          )}
          {!!s?.note && <p className="text-slate-500">{s.note}</p>}
          {!!s?.reviewQueued && (
            <p className="text-amber-700">
              {s.reviewQueued.toLocaleString()} item
              {s.reviewQueued === 1 ? '' : 's'} waiting for you in the review queue.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {s?.runId && open && (
            <button
              type="button"
              onClick={() => toggle.mutate(running ? 'pause' : 'resume')}
              disabled={toggle.isPending}
              className="rounded border border-slate-300 bg-white px-2 py-0.5 hover:bg-slate-100 disabled:opacity-60"
            >
              {running ? 'Pause' : 'Resume'}
            </button>
          )}
          {s?.runId && open && (
            <button
              type="button"
              onClick={() => toggle.mutate('cancel')}
              disabled={toggle.isPending}
              className="rounded border border-slate-300 bg-white px-2 py-0.5 text-slate-600 hover:bg-slate-100 disabled:opacity-60"
            >
              Stop
            </button>
          )}
          <button
            type="button"
            onClick={() => start.mutate()}
            disabled={start.isPending || running}
            className="rounded bg-slate-800 px-3 py-1 font-medium text-white hover:bg-slate-700 disabled:opacity-60"
          >
            {start.isPending
              ? 'Starting…'
              : running
                ? 'Running…'
                : open
                  ? 'Resume run'
                  : 'FB groups'}
          </button>
        </div>
      </div>

      {!!s?.runId && open && !s.workerOnline && (
        <p className="text-amber-700">
          Waiting for the worker on your PC. Run{' '}
          <code className="rounded bg-amber-50 px-1">
            workers\email-finder\start-email-finder.ps1
          </code>
          .
        </p>
      )}
      {!!s?.runId && open && s.workerOnline && (
        <p className="text-emerald-700">
          Running on your PC. The Galaxy is used for the groups, the comments and the DMs, inside
          the worker&apos;s caps and quiet hours.
        </p>
      )}
    </div>
  );
}
