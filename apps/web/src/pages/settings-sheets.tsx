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
  WAITING_RESEARCH: 'Waiting for email research',
  FORM_PREPARING: 'Preparing contact form',
  FORM_SENDING: 'Submitting contact form',
  SENDING: 'Sending',
  SENT: 'Sent',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  MANUAL: 'Contact form needs review',
  REPLIED: 'Replied, sequence stopped',
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

  const sequences = useQuery({
    queryKey: ['sheets', 'sequences'],
    queryFn: () => api.sheets.sequences(),
    enabled: isConnected && !status.data?.needsReconnect,
    staleTime: 5 * 60_000,
  });

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
  const [copied, setCopied] = useState<string | null>(null);
  // Contact-form schools: copy the rendered email and open their form.
  const sendViaForm = useMutation({
    mutationFn: async (id: string) => {
      const message = await api.sheets.followUpMessage(id);
      await navigator.clipboard.writeText(`${message.subject}

${message.body}`);
      if (message.contactFormUrl) window.open(message.contactFormUrl, '_blank', 'noopener');
      return id;
    },
    onSuccess: (id) => setCopied(id),
  });
  const markSent = useMutation({
    mutationFn: (id: string) => api.sheets.markFollowUpSent(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['sheets', 'follow-ups'] }),
  });

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
            {status.data?.needsReconnect ? (
              <div className="space-y-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <p>
                  Google no longer accepts the access saved for{' '}
                  <span className="font-mono text-xs">{status.data.email ?? 'this account'}</span>.
                  Status pushes stop working and follow-up emails wait (up to 3 days) until you
                  connect again.
                </p>
                {status.data.problem && <p className="text-xs">{status.data.problem}</p>}
                <button
                  type="button"
                  onClick={() => connect.mutate()}
                  disabled={connect.isPending}
                  className="rounded bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-60"
                >
                  {connect.isPending ? 'Opening Google…' : 'Reconnect Google'}
                </button>
              </div>
            ) : (
              <p className="text-sm text-emerald-700">
                Connected as{' '}
                <span className="font-mono text-xs">{status.data?.email ?? 'unknown'}</span>.
                Follow-up emails are sent from this address.
              </p>
            )}
            {!status.data?.needsReconnect && status.data?.problem && (
              <p className="text-xs text-amber-800">
                Google couldn&apos;t be reached just now: {status.data.problem}
              </p>
            )}
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
                The API is missing {status.data.missing.join(', ')}, so connecting will fail.
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

      {isConnected && !status.data?.needsReconnect && (
        <div className="space-y-2 rounded border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-700">Follow-up sequences</h2>
          <p className="text-xs text-slate-600">
            Each workbook has its own 72 emails. Calls pushed to any other spreadsheet go by the
            school&apos;s number: UK numbers get the UK emails, the rest get the US ones.
          </p>
          {sequences.isLoading && <p className="text-xs text-slate-400">Checking with Google…</p>}
          {sequences.isError && <p className="text-xs text-rose-700">{sequences.error.message}</p>}
          <ul className="space-y-2">
            {sequences.data?.map((w) => (
              <li key={w.region} className="text-xs">
                <p className="font-medium text-slate-800">
                  {w.expectedName} → {w.region} emails, demo line {w.demoNumber}
                </p>
                {w.matches ? (
                  <p className="text-emerald-700">
                    Tied to <span className="font-mono">{w.spreadsheetId}</span>, which Google names
                    &ldquo;{w.googleName}&rdquo;.
                  </p>
                ) : (
                  <p className="text-amber-800">
                    The ID <span className="font-mono">{w.spreadsheetId}</span>{' '}
                    {w.googleName
                      ? `is "${w.googleName}" in Google, not "${w.expectedName}".`
                      : `couldn't be found in Google${w.error ? ` (${w.error})` : ''}.`}{' '}
                    {w.suggestedId ? (
                      <>
                        &ldquo;{w.expectedName}&rdquo; is{' '}
                        <span className="font-mono">{w.suggestedId}</span>: set{' '}
                        <span className="font-mono">
                          {w.region === 'US' ? 'US_CONQUEST_SHEET_ID' : 'UK_OFFICIAL_SHEET_ID'}
                        </span>{' '}
                        to it on the API.
                      </>
                    ) : (
                      `No spreadsheet named "${w.expectedName}" was found either.`
                    )}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

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
                    {f.emailTo ?? (f.contactFormUrl ? 'Contact form' : 'Researching contact')}{' '}
                    <span className="font-normal text-slate-500">
                      ({f.emailTemplate}, email {f.sequenceStep} of 6, {f.sheetTitle} row{' '}
                      {f.rowIndex})
                    </span>
                  </p>
                  <p className="text-slate-500">
                    {EMAIL_STATUS_LABEL[f.emailStatus]}
                    {(f.emailStatus === 'PENDING' || f.emailStatus === 'MANUAL') && f.emailDueAt
                      ? ` ${f.emailStatus === 'MANUAL' ? 'from' : 'for'} ${new Date(f.emailDueAt).toLocaleString()}`
                      : ''}
                    {copied === f.id ? ' · message copied, paste it into the form' : ''}
                    {f.emailStatus === 'SENT' && f.emailSentAt
                      ? ` ${new Date(f.emailSentAt).toLocaleString()}`
                      : ''}
                    {f.emailError && f.emailStatus !== 'SENT' ? ` · ${f.emailError}` : ''}
                  </p>
                </div>
                {f.emailStatus === 'MANUAL' && (
                  <span className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => sendViaForm.mutate(f.id)}
                      disabled={sendViaForm.isPending}
                      className="rounded bg-indigo-600 px-2 py-1 font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
                    >
                      Copy message &amp; open form
                    </button>
                    <button
                      type="button"
                      onClick={() => markSent.mutate(f.id)}
                      disabled={markSent.isPending}
                      className="rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                    >
                      Mark sent
                    </button>
                  </span>
                )}
                {['PENDING', 'MANUAL', 'WAITING_RESEARCH', 'FORM_PREPARING'].includes(
                  f.emailStatus,
                ) && (
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
            Picking a tab on the Dial page starts the email finder on your PC: it researches every
            row without an email (the school&apos;s website, search results, public Facebook and
            Instagram snippets, martial-arts directories and federations) and fills the email,
            emailType, emailSource, decisionMaker and contactForm columns.
          </li>
          <li>
            Follow-up emails go to the address in the row&apos;s email column: a sequence of 6, on
            days 2, 4, 7, 10, 14 and 21 after the call, for the first status you picked that sends
            email. U.S. Conquest gets the US sequence (demo line (667) 220-6726), The Official UK
            the UK one in British wording (demo line 02045726501); a reply stops it. Booked a demo
            cancels it; Not available and Handles calls himself don&apos;t send email on their own.
            A school already emailed in the last 30 days isn&apos;t emailed again. Schools with only
            a contact form receive the same subject and body through that form after research is
            complete. Forms requiring sign-in, human verification, or unknown required answers
            appear here for review. Uncertain submissions are never repeated automatically.
          </li>
        </ul>
        <p className="text-xs text-slate-500">
          Sequences: <span className="font-mono">apps/api/templates/sequences/us/</span> and{' '}
          <span className="font-mono">apps/api/templates/sequences/uk/</span>{' '}
          {Object.values(TAG_EMAIL_TEMPLATE).join(', ')}. Placeholders:{' '}
          <span className="font-mono">
            {
              '{{school_name}} {{website}} {{rating}} {{review_count}} {{category}} {{street}} {{city}} {{state}} {{called_number}} {{my_number}} {{call_time}} {{call_note}}'
            }
          </span>
          .
        </p>
      </div>
    </section>
  );
}
