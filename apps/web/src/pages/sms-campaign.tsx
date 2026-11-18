import {
  DEFAULT_SMS_CAMPAIGN_BODY,
  SMS_CAMPAIGN_HOURS,
  SMS_CAMPAIGN_SEND_GAP_MINUTES,
  renderCampaignText,
  smsSize,
  type SmsCampaignDto,
  type SmsCampaignSendDto,
  type SmsCampaignUpdateInput,
} from '@pstn-twilio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '../lib/api-client';
import { formatDate, formatPhone } from '../lib/format';

const CAMPAIGN_KEY = ['sms-campaign'] as const;
const TEST_NUMBER_KEY = 'pstn-twilio.sms-campaign.test-number';
// The preview shows what a lead with a typical name gets.
const PREVIEW_NAME = 'Lone Star Karate';

function readStoredTestNumber(): string {
  try {
    return window.localStorage.getItem(TEST_NUMBER_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeTestNumber(value: string): void {
  try {
    window.localStorage.setItem(TEST_NUMBER_KEY, value);
  } catch {
    // Remembering the number is a convenience only.
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hourLabel(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}${hour < 12 ? 'am' : 'pm'}`;
}

const HOURS = `${hourLabel(SMS_CAMPAIGN_HOURS.start)} to ${hourLabel(SMS_CAMPAIGN_HOURS.end)}`;

function statusLine(campaign: SmsCampaignDto): { text: string; tone: 'on' | 'off' | 'wait' } {
  if (!campaign.enabled) return { text: 'Paused. No texts go out.', tone: 'off' };
  if (campaign.sentLast24h >= campaign.dailyCap) {
    return {
      text: `Daily cap reached. Texting picks up again as the texts from 24 hours ago age out.`,
      tone: 'wait',
    };
  }
  if (campaign.waiting === 0) {
    return {
      text: 'Running, but no leads are waiting. Calls you push join the line 30 minutes after the call.',
      tone: 'wait',
    };
  }
  return {
    text: `Running. One text every ${SMS_CAMPAIGN_SEND_GAP_MINUTES} minutes, ${HOURS} in each lead's time zone, every day.`,
    tone: 'on',
  };
}

function result(send: SmsCampaignSendDto): { label: string; tone: string } {
  if (send.status === 'SENDING') return { label: 'Sending', tone: 'text-slate-600' };
  if (send.status === 'OPTED_OUT') return { label: 'Opted out', tone: 'text-amber-700' };
  if (send.status === 'FAILED') return { label: 'Refused', tone: 'text-rose-700' };
  if (send.delivery === 'DELIVERED') return { label: 'Delivered', tone: 'text-emerald-700' };
  if (send.delivery === 'UNDELIVERED' || send.delivery === 'FAILED') {
    return { label: 'Not delivered', tone: 'text-rose-700' };
  }
  return { label: 'Sent', tone: 'text-slate-700' };
}

export function SmsCampaignPage() {
  const queryClient = useQueryClient();
  const campaign = useQuery({
    queryKey: CAMPAIGN_KEY,
    queryFn: api.smsCampaign.get,
    refetchInterval: 30_000,
  });
  const data = campaign.data;

  // The edited text; null while it matches what's saved.
  const [draft, setDraft] = useState<string | null>(null);
  const [testTo, setTestTo] = useState(readStoredTestNumber);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const body = draft ?? data?.body ?? DEFAULT_SMS_CAMPAIGN_BODY;
  const dirty = draft !== null && draft !== data?.body;
  const preview = renderCampaignText(body, PREVIEW_NAME);
  const size = smsSize(preview);

  const update = useMutation({
    mutationFn: (input: SmsCampaignUpdateInput) => api.smsCampaign.update(input),
    onSuccess: (next) => {
      queryClient.setQueryData(CAMPAIGN_KEY, next);
      setDraft(null);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const test = useMutation({
    mutationFn: (to: string) => api.smsCampaign.test(to),
    onSuccess: (sent) => {
      storeTestNumber(testTo);
      setNotice(`Test text sent to ${formatPhone(sent.to)}. Check your phone.`);
    },
    onError: (err) => setError(`The test text didn't go out: ${errorMessage(err)}`),
  });

  function start() {
    if (!data) return;
    const ok = window.confirm(
      `Start the SMS campaign?\n\nUp to ${data.dailyCap} texts a day go out from ${formatPhone(
        data.from,
      )} to the ${data.waiting} leads waiting, plus every call you push from now on.`,
    );
    if (!ok) return;
    setError(null);
    setNotice(null);
    update.mutate(dirty ? { enabled: true, body } : { enabled: true });
  }

  function pause() {
    setError(null);
    setNotice(null);
    update.mutate({ enabled: false });
  }

  function saveText() {
    setError(null);
    setNotice(null);
    update.mutate({ body });
  }

  function sendTest() {
    setError(null);
    setNotice(null);
    test.mutate(testTo);
  }

  if (campaign.isLoading) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }
  if (campaign.isError || !data) {
    return (
      <p role="alert" className="text-sm text-rose-700">
        Could not load the SMS campaign: {errorMessage(campaign.error)}
      </p>
    );
  }

  const status = statusLine(data);
  const undelivered = data.totals.undelivered + data.totals.failed;

  return (
    <section className="max-w-4xl space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">SMS campaign</h1>
        <p className="mt-1 text-sm text-slate-600">
          One text per school you called, from {formatPhone(data.from)}. US numbers only. Out of
          service and booked schools are skipped, and nobody gets it twice. Up to {data.dailyCap} in
          any 24 hours, {HOURS} in each school&apos;s time zone, weekends included.
        </p>
      </header>

      <div className="rounded border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={`inline-flex items-center gap-2 text-sm font-medium ${
              status.tone === 'on'
                ? 'text-emerald-700'
                : status.tone === 'wait'
                  ? 'text-amber-700'
                  : 'text-slate-600'
            }`}
          >
            <span
              aria-hidden="true"
              className={`h-2.5 w-2.5 rounded-full ${
                status.tone === 'on'
                  ? 'bg-emerald-500'
                  : status.tone === 'wait'
                    ? 'bg-amber-500'
                    : 'bg-slate-400'
              }`}
            />
            {status.text}
          </span>
          <div className="ml-auto">
            {data.enabled ? (
              <button
                type="button"
                onClick={pause}
                disabled={update.isPending}
                className="rounded border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-60"
              >
                {update.isPending ? 'Pausing…' : 'Pause'}
              </button>
            ) : (
              <button
                type="button"
                onClick={start}
                disabled={update.isPending}
                className="rounded bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
              >
                {update.isPending ? 'Starting…' : 'Start campaign'}
              </button>
            )}
          </div>
        </div>

        {data.lastError && (
          <p role="alert" className="mt-3 rounded bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {data.lastError}
          </p>
        )}

        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Stat label="Last 24 hours" value={`${data.sentLast24h} / ${data.dailyCap}`} />
          <Stat label="Waiting" value={String(data.waiting)} />
          <Stat label="Delivered" value={String(data.totals.delivered)} />
          <Stat label="Not delivered" value={String(undelivered)} />
          <Stat label="Opted out" value={String(data.totals.optedOut)} />
        </dl>
      </div>

      <div className="rounded border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">The text</h2>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <div>
            <label htmlFor="sms-campaign-body" className="text-xs text-slate-500">
              {'{{school_name}}'} becomes the school&apos;s name, or &quot;there&quot; when it has
              none.
            </label>
            <textarea
              id="sms-campaign-body"
              value={body}
              onChange={(e) => setDraft(e.target.value)}
              rows={10}
              className="mt-1 w-full rounded border border-slate-300 p-2 font-mono text-sm"
            />
            <p className="mt-1 text-xs text-slate-500">
              {size.characters} characters · {size.segments} SMS per school
            </p>
            {size.encoding === 'UCS-2' && (
              <p className="mt-1 text-xs text-amber-700">
                A curly quote, dash or emoji makes every text cost more than double. Use plain
                quotes and hyphens.
              </p>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={saveText}
                disabled={!dirty || update.isPending}
                className="rounded bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-40"
              >
                Save text
              </button>
              {dirty && (
                <button
                  type="button"
                  onClick={() => setDraft(null)}
                  className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
                >
                  Undo changes
                </button>
              )}
              {body !== DEFAULT_SMS_CAMPAIGN_BODY && (
                <button
                  type="button"
                  onClick={() => setDraft(DEFAULT_SMS_CAMPAIGN_BODY)}
                  className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
                >
                  Use the original text
                </button>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-slate-500">What {PREVIEW_NAME} would get</p>
            <div
              data-testid="sms-preview"
              className="mt-1 whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm bg-slate-100 p-3 text-sm text-slate-900"
            >
              {preview}
            </div>
            <form
              className="mt-4 flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                sendTest();
              }}
            >
              <label className="flex flex-col text-xs text-slate-500">
                Text me a test
                <input
                  type="tel"
                  value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                  placeholder="(512) 555-0123"
                  className="mt-1 w-44 rounded border border-slate-300 px-2 py-1.5 text-sm text-slate-900"
                />
              </label>
              <button
                type="submit"
                disabled={!testTo.trim() || test.isPending}
                className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-40"
              >
                {test.isPending ? 'Sending…' : 'Send test'}
              </button>
            </form>
            <p className="mt-1 text-xs text-slate-500">
              Sends the saved text. Tests don&apos;t count toward the cap.
            </p>
          </div>
        </div>
      </div>

      {(error || notice) && (
        <p
          role={error ? 'alert' : 'status'}
          className={`text-sm ${error ? 'text-rose-700' : 'text-emerald-700'}`}
        >
          {error ?? notice}
        </p>
      )}

      <div className="rounded border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Latest texts
        </h2>
        {data.recent.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">Nothing sent yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-1 pr-3 font-medium">School</th>
                  <th className="py-1 pr-3 font-medium">Number</th>
                  <th className="py-1 pr-3 font-medium">Result</th>
                  <th className="py-1 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((send) => {
                  const r = result(send);
                  return (
                    <tr key={send.id} className="border-t border-slate-100 align-top">
                      <td className="py-1.5 pr-3">{send.schoolName ?? '—'}</td>
                      <td className="whitespace-nowrap py-1.5 pr-3">{formatPhone(send.to)}</td>
                      <td className="py-1.5 pr-3">
                        <span className={r.tone}>{r.label}</span>
                        {send.error && r.label !== 'Delivered' && (
                          <span className="block text-xs text-slate-500">{send.error}</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap py-1.5">{formatDate(send.sentAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-slate-50 px-3 py-2">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-lg font-semibold text-slate-900">{value}</dd>
    </div>
  );
}
