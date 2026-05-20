import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { WhatsAppDisclaimer } from '../components/disclaimer';
import { api, ApiError } from '../lib/api-client';
import { capabilityBadge, formatDate, formatPhone } from '../lib/format';
import { useToast } from '../lib/toast';

export function NumberDetail() {
  const { numberId } = useParams<{ numberId: string }>();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { push } = useToast();
  const [editingName, setEditingName] = useState(false);
  const [friendlyName, setFriendlyName] = useState('');
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const numberQuery = useQuery({
    queryKey: ['numbers', numberId],
    queryFn: () => api.numbers.get(numberId!),
    enabled: Boolean(numberId),
  });

  function refetchAll() {
    queryClient.invalidateQueries({ queryKey: ['numbers'] });
    queryClient.invalidateQueries({ queryKey: ['numbers', numberId] });
  }

  function toastError(err: unknown) {
    const message =
      err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
    setActionError(message);
    push({ tone: 'error', title: 'Action failed', message });
  }

  const rename = useMutation({
    mutationFn: (name: string) => api.numbers.update(numberId!, { friendlyName: name }),
    onSuccess: () => {
      refetchAll();
      setEditingName(false);
      setActionError(null);
      push({ tone: 'success', message: 'Friendly name updated.' });
    },
    onError: toastError,
  });

  const sync = useMutation({
    mutationFn: () => api.numbers.sync(numberId!),
    onSuccess: () => {
      refetchAll();
      setActionError(null);
      push({ tone: 'success', message: 'Synced from Twilio.' });
    },
    onError: toastError,
  });

  const reconfigure = useMutation({
    mutationFn: () => api.numbers.configureWebhooks(numberId!),
    onSuccess: () => {
      refetchAll();
      setActionError(null);
      push({ tone: 'success', message: 'Webhooks reconfigured on Twilio.' });
    },
    onError: toastError,
  });

  const release = useMutation({
    mutationFn: () => api.numbers.release(numberId!),
    onSuccess: () => {
      refetchAll();
      setConfirmRelease(false);
      push({ tone: 'success', message: 'Number released on Twilio.' });
      navigate('/numbers');
    },
    onError: toastError,
  });

  const deactivate = useMutation({
    mutationFn: () => api.numbers.deactivate(numberId!),
    onSuccess: () => {
      refetchAll();
      setActionError(null);
      push({ tone: 'success', message: 'Number deactivated locally.' });
    },
    onError: toastError,
  });

  if (numberQuery.isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (numberQuery.isError) {
    return (
      <p className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
        {(numberQuery.error as ApiError).message}
      </p>
    );
  }

  const n = numberQuery.data;
  if (!n) return null;

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm text-slate-500">
            <Link to="/numbers" className="hover:underline">
              ← Numbers
            </Link>
          </div>
          <h1 className="mt-1 font-mono text-2xl font-semibold">
            {formatPhone(n.phoneNumberE164)}
          </h1>
          {editingName ? (
            <div className="mt-2 flex items-center gap-2">
              <input
                value={friendlyName || n.friendlyName}
                onChange={(e) => setFriendlyName(e.target.value)}
                maxLength={64}
                className="rounded border border-slate-300 px-2 py-1 text-sm"
              />
              <button
                onClick={() => rename.mutate(friendlyName || n.friendlyName)}
                disabled={rename.isPending}
                className="rounded bg-slate-900 px-3 py-1 text-xs font-medium text-white disabled:opacity-60"
              >
                {rename.isPending ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={() => {
                  setEditingName(false);
                  setFriendlyName('');
                }}
                className="rounded border border-slate-300 px-3 py-1 text-xs"
              >
                Cancel
              </button>
            </div>
          ) : (
            <p className="mt-1 text-sm text-slate-600">
              {n.friendlyName}{' '}
              <button
                onClick={() => {
                  setEditingName(true);
                  setFriendlyName(n.friendlyName);
                }}
                className="text-xs underline"
              >
                rename
              </button>
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            to={`/numbers/${n.id}/messages`}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm"
          >
            Inbox
          </Link>
          <Link
            to={`/numbers/${n.id}/calls`}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm"
          >
            Call log
          </Link>
          <Link
            to={`/numbers/${n.id}/answer`}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm"
          >
            Answer
          </Link>
          <Link
            to={`/numbers/${n.id}/dial`}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm"
          >
            Dial
          </Link>
        </div>
      </header>

      {actionError && (
        <p className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {actionError}
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <DetailCard title="Metadata">
          <Row label="Status">
            <span
              className={
                n.active
                  ? 'rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-800'
                  : 'rounded bg-slate-200 px-1.5 py-0.5 text-xs text-slate-700'
              }
            >
              {n.active ? 'active' : 'inactive'}
            </span>
          </Row>
          <Row label="Type">{n.numberType.replace('_', ' ').toLowerCase()}</Row>
          <Row label="Country">{n.country ?? '—'}</Row>
          <Row label="Region">{n.region ?? '—'}</Row>
          <Row label="Locality">{n.locality ?? '—'}</Row>
          <Row label="Area code">{n.areaCode ?? '—'}</Row>
          <Row label="Twilio SID">
            <span className="font-mono text-xs">{n.twilioIncomingPhoneNumberSid}</span>
          </Row>
          <Row label="Purchased">{formatDate(n.purchasedAt)}</Row>
          <Row label="Updated">{formatDate(n.updatedAt)}</Row>
        </DetailCard>

        <DetailCard title="Capabilities">
          <Row label="Voice">{capabilityBadge(n.capabilities.voice)}</Row>
          <Row label="SMS">{capabilityBadge(n.capabilities.sms)}</Row>
          <Row label="MMS">{capabilityBadge(n.capabilities.mms)}</Row>
          <div className="mt-3 border-t border-slate-100 pt-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              WhatsApp compatibility
            </p>
            <p className="mt-1 text-sm">
              {n.whatsappCompatibilityStatus.replace(/_/g, ' ').toLowerCase()}
            </p>
            <div className="mt-2">
              <WhatsAppDisclaimer />
            </div>
          </div>
        </DetailCard>

        <DetailCard title="Webhook configuration" className="md:col-span-2">
          <Row label="Voice URL">
            <span className="break-all font-mono text-xs">{n.voiceWebhookUrl ?? '—'}</span>
          </Row>
          <Row label="SMS URL">
            <span className="break-all font-mono text-xs">{n.smsWebhookUrl ?? '—'}</span>
          </Row>
          <Row label="Status callback">
            <span className="break-all font-mono text-xs">{n.statusCallbackUrl ?? '—'}</span>
          </Row>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => sync.mutate()}
              disabled={sync.isPending}
              className="rounded border border-slate-300 px-3 py-1.5 text-xs"
            >
              {sync.isPending ? 'Syncing…' : 'Sync from Twilio'}
            </button>
            <button
              onClick={() => reconfigure.mutate()}
              disabled={reconfigure.isPending}
              className="rounded border border-slate-300 px-3 py-1.5 text-xs"
            >
              {reconfigure.isPending ? 'Reconfiguring…' : 'Reconfigure webhooks'}
            </button>
          </div>
        </DetailCard>

        <DetailCard title="Lifecycle" className="md:col-span-2">
          <p className="text-sm text-slate-600">
            Deactivating hides the number from this app without releasing it from Twilio. Releasing
            removes the number from your Twilio account and stops billing for it. Both actions are
            audit-logged.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => deactivate.mutate()}
              disabled={deactivate.isPending || !n.active}
              className="rounded border border-slate-300 px-3 py-1.5 text-xs disabled:opacity-50"
            >
              {n.active ? 'Deactivate locally' : 'Already inactive'}
            </button>
            <button
              onClick={() => setConfirmRelease(true)}
              className="rounded border border-rose-300 bg-white px-3 py-1.5 text-xs text-rose-700 hover:bg-rose-50"
            >
              Release on Twilio…
            </button>
          </div>
        </DetailCard>
      </div>

      {confirmRelease && (
        <ConfirmRelease
          phoneNumber={n.phoneNumberE164}
          submitting={release.isPending}
          onCancel={() => setConfirmRelease(false)}
          onConfirm={() => release.mutate()}
        />
      )}
    </section>
  );
}

function DetailCard({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded border border-slate-200 bg-white p-4 ${className ?? ''}`}>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className="col-span-2">{children}</dd>
    </div>
  );
}

function ConfirmRelease({
  phoneNumber,
  submitting,
  onCancel,
  onConfirm,
}: {
  phoneNumber: string;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  const ok = typed.trim() === phoneNumber;
  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-md space-y-4 rounded bg-white p-6 shadow-lg">
        <h2 className="text-base font-semibold text-rose-700">Release this number?</h2>
        <p className="text-sm text-slate-700">
          Releasing <span className="font-mono">{phoneNumber}</span> removes it from your Twilio
          account. This is irreversible. Type the full number to confirm.
        </p>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={phoneNumber}
          className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
        />
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={submitting}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!ok || submitting}
            className="rounded bg-rose-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {submitting ? 'Releasing…' : 'Release on Twilio'}
          </button>
        </div>
      </div>
    </div>
  );
}
