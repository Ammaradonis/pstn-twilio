/**
 * Settings → Google Sheets & Gmail: connect the Google account, check the
 * time zone resolver against "U.S. Conquest", and review or cancel the
 * scheduled follow-up emails.
 */

import { TAG_EMAIL_TEMPLATE, type SheetsEmailStatus } from '@pstn-twilio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { api } from '../lib/api-client';

const EMAIL_STATUS_LABEL: Record<SheetsEmailStatus, string> = {
  NONE: 'Not sent',
  PENDING: 'Scheduled',
  SENDING: 'Sending',
  SENT: 'Sent',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

export function SettingsSheets() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  // Read the OAuth result once, then clear it from the URL.
  const [oauthResult] = useState(() => ({
    connected: searchParams.get('connected') === '1',
    error: searchParams.get('error'),
  }));

  useEffect(() => {
    if (oauthResult.connected || oauthResult.error) {
      setSearchParams({}, { replace: true });
      void queryClient.invalidateQueries({ queryKey: ['sheets'] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const status = useQuery({
    queryKey: ['sheets', 'status'],
    queryFn: () => api.sheets.status(),
    staleTime: 30_000,
  });
  const isConnected = status.data?.connected ?? false;

  const followUps = useQuery({
    queryKey: ['sheets', 'follow-ups'],
    queryFn: () => api.sheets.followUps(),
    enabled: isConnected,
    refetchInterval: 60_000,
  });

  const connect = useMutation({
    mutationFn: () => api.sheets.connectUrl(),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
  });
  const disconnect = useMutation({
    mutationFn: () => api.sheets.disconnect(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['sheets'] }),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.sheets.cancelFollowUp(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['sheets', 'follow-ups'] }),
  });
  const tzCheck = useMutation({ mutationFn: () => api.sheets.timezoneCheck() });

  return (
    <section className="max-w-2xl space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">Google Sheets &amp; Gmail</h1>
        <p className="mt-1 text-sm text-slate-600">
          Push post-call statuses to your spreadsheets and send 48-hour follow-up emails from Gmail.
        </p>
      </header>

      {oauthResult.connected && (
        <div className="rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Google account connected.
        </div>
      )}
      {oauthResult.error && (
        <div className="rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          Connection failed: {oauthResult.error}
        </div>
      )}

      <div className="space-y-3 rounded border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-700">Connection</h2>
        {status.isLoading ? (
          <p className="text-sm text-slate-400">Checking…</p>
        ) : isConnected ? (
          <div className="space-y-2">
            <p className="text-sm text-emerald-700">
              Connected as{' '}
              <span className="font-mono text-xs">{status.data?.email ?? 'unknown'}</span>.
              Follow-up emails are sent from this address.
            </p>
            <button
              type="button"
              onClick={() => {
                if (
                  window.confirm('Disconnect Google? Scheduled follow-up emails are cancelled.')
                ) {
                  disconnect.mutate();
                }
              }}
              disabled={disconnect.isPending}
              className="rounded border border-rose-300 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-60"
            >
              {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-slate-600">
              Not connected. Sign in with the Google account that owns your spreadsheets and allow
              Sheets, the Drive file list and Gmail send.
            </p>
            {status.data && !status.data.configured && (
              <p className="text-xs text-amber-700">
                The API is missing its Google OAuth settings, so connecting will fail.
              </p>
            )}
            <button
              type="button"
              onClick={() => connect.mutate()}
              disabled={connect.isPending}
              className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
            >
              {connect.isPending ? 'Redirecting…' : 'Connect Google account'}
            </button>
            {connect.isError && <p className="text-xs text-rose-700">{connect.error.message}</p>}
          </div>
        )}
      </div>

      {isConnected && (
        <div className="space-y-2 rounded border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-700">Follow-up emails</h2>
          {followUps.data?.length === 0 && <p className="text-xs text-slate-500">None yet.</p>}
          <ul className="divide-y divide-slate-100">
            {followUps.data?.map((f) => (
              <li
                key={f.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-800">
                    {f.emailTo ?? '—'}{' '}
                    <span className="font-normal text-slate-500">
                      ({f.emailTemplate}, {f.sheetTitle} row {f.rowIndex})
                    </span>
                  </p>
                  <p className="text-slate-500">
                    {EMAIL_STATUS_LABEL[f.emailStatus]}
                    {f.emailStatus === 'PENDING' && f.emailDueAt
                      ? ` for ${new Date(f.emailDueAt).toLocaleString()}`
                      : ''}
                    {f.emailStatus === 'SENT' && f.emailSentAt
                      ? ` ${new Date(f.emailSentAt).toLocaleString()}`
                      : ''}
                    {f.emailError && f.emailStatus !== 'SENT' ? ` · ${f.emailError}` : ''}
                  </p>
                </div>
                {f.emailStatus === 'PENDING' && (
                  <button
                    type="button"
                    onClick={() => cancel.mutate(f.id)}
                    disabled={cancel.isPending}
                    className="rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                  >
                    Cancel
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {isConnected && (
        <div className="space-y-2 rounded border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-700">Time zones</h2>
          <p className="text-xs text-slate-600">
            The call time in the cell is the school&apos;s local time, worked out from the address
            in its row: the ZIP code first, then the city, then the state. Daylight saving changes
            are applied automatically. Checking reads every tab of U.S. Conquest, reports how each
            address resolves, and learns city time zones so addresses without a ZIP still come out
            right.
          </p>
          <button
            type="button"
            onClick={() => tzCheck.mutate()}
            disabled={tzCheck.isPending}
            className="rounded border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            {tzCheck.isPending ? 'Reading U.S. Conquest…' : 'Check against U.S. Conquest'}
          </button>
          {tzCheck.isError && <p className="text-xs text-rose-700">{tzCheck.error.message}</p>}
          {tzCheck.data && (
            <div className="space-y-1 text-xs text-slate-700">
              <p>
                {tzCheck.data.addresses.toLocaleString()} addresses in {tzCheck.data.tabs} tabs: by
                ZIP {tzCheck.data.bySource.zip}, by city {tzCheck.data.bySource.city}, by state{' '}
                {tzCheck.data.bySource.state}, guessed {tzCheck.data.bySource.guess}
                {tzCheck.data.bySource.none > 0 &&
                  `, rows without an address ${tzCheck.data.bySource.none}`}
                . Learned {tzCheck.data.learnedCities.toLocaleString()} cities.
              </p>
              {tzCheck.data.uncertain.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-amber-700">
                    {tzCheck.data.uncertain.length} addresses in split-zone states could only be
                    guessed
                  </summary>
                  <ul className="mt-1 space-y-0.5">
                    {tzCheck.data.uncertain.map((u) => (
                      <li key={`${u.tab}-${u.row}`}>
                        {u.tab} row {u.row}: {u.address} → {u.timeZone}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>
      )}

      <div className="space-y-2 rounded border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-700">How it works</h2>
        <ul className="list-inside list-disc space-y-1 text-xs text-slate-600">
          <li>
            On the Dial page, pick the spreadsheet and tab you are calling from. After each call a
            status panel opens.
          </li>
          <li>
            Tap every status that applies and add a custom explanation if you like, then Push. The
            row whose <span className="font-mono">phoneNumber</span> matches the dialled number gets
            a <span className="font-mono">Status</span> cell (the column is created if missing):{' '}
            <em>Voicemail, Not interested, from: 6672206726, time: 9:45am</em>. Pushing again
            overwrites it.
          </li>
          <li>
            Follow-up emails go to the address in the row&apos;s email column, 48 hours after the
            call, using the template of the first status you picked that sends email. Booked a demo
            cancels it; Not available and Handles calls himself don&apos;t send email on their own.
            A school already emailed in the last 30 days isn&apos;t emailed again.
          </li>
        </ul>
        <p className="text-xs text-slate-500">
          Templates: <span className="font-mono">apps/api/templates/cold-email/</span>{' '}
          {Object.values(TAG_EMAIL_TEMPLATE).join(', ')}. Placeholders:{' '}
          <span className="font-mono">
            {
              '{{schoolName}} {{customNote}} {{callerNumber}} {{phoneNumber}} {{callDay}} {{localTime}}'
            }
          </span>
          .
        </p>
      </div>
    </section>
  );
}
