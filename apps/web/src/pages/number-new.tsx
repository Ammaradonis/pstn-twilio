import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { InventoryDisclaimer, WhatsAppDisclaimer } from '../components/disclaimer';
import { api, type ApiError } from '../lib/api-client';
import { formatPhone } from '../lib/format';

type SearchType = 'local' | 'mobile' | 'toll_free';

interface SearchForm {
  country: string;
  type: SearchType;
  areaCode: string;
  contains: string;
  inRegion: string;
  inLocality: string;
  inPostalCode: string;
  voiceEnabled: boolean;
  smsEnabled: boolean;
  mmsEnabled: boolean;
  excludeAddressRequired: boolean;
}

const DEFAULT_FORM: SearchForm = {
  country: 'US',
  type: 'local',
  areaCode: '',
  contains: '',
  inRegion: '',
  inLocality: '',
  inPostalCode: '',
  voiceEnabled: true,
  smsEnabled: true,
  mmsEnabled: false,
  excludeAddressRequired: true,
};

export function NumberNew() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState<SearchForm>(DEFAULT_FORM);
  const [searchKey, setSearchKey] = useState<string | null>(null);
  const [pendingPurchase, setPendingPurchase] = useState<string | null>(null);

  const countriesQuery = useQuery({
    queryKey: ['countries'],
    queryFn: () => api.numbers.countries(),
    staleTime: 60 * 60 * 1000,
  });

  const searchQuery = useQuery({
    queryKey: ['search', searchKey],
    enabled: Boolean(searchKey),
    queryFn: () =>
      api.numbers.search({
        country: form.country,
        type: form.type,
        areaCode: form.areaCode || undefined,
        contains: form.contains || undefined,
        inRegion: form.inRegion || undefined,
        inLocality: form.inLocality || undefined,
        inPostalCode: form.inPostalCode || undefined,
        voiceEnabled: form.voiceEnabled,
        smsEnabled: form.smsEnabled,
        mmsEnabled: form.mmsEnabled || undefined,
        excludeAddressRequired: form.excludeAddressRequired,
      }),
  });

  const purchase = useMutation({
    mutationFn: (phoneNumber: string) => api.numbers.purchase({ phoneNumber }),
    onSuccess: (number) => {
      queryClient.invalidateQueries({ queryKey: ['numbers'] });
      setPendingPurchase(null);
      navigate(`/numbers/${number.id}`);
    },
  });

  function handleSearch(event: React.FormEvent) {
    event.preventDefault();
    if (form.type === 'local' && form.country === 'US' && !form.areaCode && !form.inRegion) {
      // soft hint: NANP local search is more useful with area code
    }
    setSearchKey(`${Date.now()}`);
  }

  return (
    <section className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Search and purchase a Twilio number</h1>
        <p className="mt-2 text-sm text-slate-600">
          Provision a phone number from Twilio inventory. Numbers are immediately configured with
          this app&apos;s voice and SMS webhooks so inbound traffic reaches your browser.
        </p>
        <div className="mt-2 space-y-1">
          <InventoryDisclaimer />
          <WhatsAppDisclaimer />
        </div>
      </header>

      <form
        onSubmit={handleSearch}
        className="grid gap-4 rounded border border-slate-200 bg-white p-4 md:grid-cols-2"
      >
        <label className="text-sm">
          <span className="block text-slate-700">Country</span>
          <select
            value={form.country}
            onChange={(e) => setForm({ ...form, country: e.target.value })}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
          >
            {countriesQuery.data ? (
              countriesQuery.data.map((c) => (
                <option key={c.countryCode} value={c.countryCode}>
                  {c.country} ({c.countryCode}){c.beta ? ' • beta' : ''}
                </option>
              ))
            ) : (
              <option value="US">United States (US)</option>
            )}
          </select>
        </label>

        <label className="text-sm">
          <span className="block text-slate-700">Type</span>
          <select
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value as SearchType })}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
          >
            <option value="local">Local</option>
            <option value="mobile">Mobile</option>
            <option value="toll_free">Toll-Free</option>
          </select>
        </label>

        <label className="text-sm">
          <span className="block text-slate-700">Area code (NANP only, 3 digits)</span>
          <input
            value={form.areaCode}
            onChange={(e) => setForm({ ...form, areaCode: e.target.value })}
            maxLength={3}
            placeholder="415"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
          />
        </label>

        <label className="text-sm">
          <span className="block text-slate-700">Pattern (contains)</span>
          <input
            value={form.contains}
            onChange={(e) => setForm({ ...form, contains: e.target.value })}
            placeholder="LOVE or 1234"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
          />
        </label>

        <label className="text-sm">
          <span className="block text-slate-700">Region (state/province)</span>
          <input
            value={form.inRegion}
            onChange={(e) => setForm({ ...form, inRegion: e.target.value })}
            placeholder="CA"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
          />
        </label>

        <label className="text-sm">
          <span className="block text-slate-700">Locality (city)</span>
          <input
            value={form.inLocality}
            onChange={(e) => setForm({ ...form, inLocality: e.target.value })}
            placeholder="San Francisco"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
          />
        </label>

        <fieldset className="md:col-span-2">
          <legend className="text-sm text-slate-700">Required capabilities</legend>
          <div className="mt-1 flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.voiceEnabled}
                onChange={(e) => setForm({ ...form, voiceEnabled: e.target.checked })}
              />
              Voice
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.smsEnabled}
                onChange={(e) => setForm({ ...form, smsEnabled: e.target.checked })}
              />
              SMS
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.mmsEnabled}
                onChange={(e) => setForm({ ...form, mmsEnabled: e.target.checked })}
              />
              MMS
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.excludeAddressRequired}
                onChange={(e) => setForm({ ...form, excludeAddressRequired: e.target.checked })}
              />
              Hide numbers that require a regulatory address
            </label>
          </div>
        </fieldset>

        <div className="md:col-span-2">
          <button
            type="submit"
            disabled={searchQuery.isFetching}
            className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {searchQuery.isFetching ? 'Searching Twilio…' : 'Search Twilio inventory'}
          </button>
        </div>
      </form>

      {searchQuery.isError && (
        <p className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {(searchQuery.error as ApiError).message}
        </p>
      )}

      {searchQuery.data && (
        <div className="rounded border border-slate-200 bg-white">
          <header className="flex items-center justify-between border-b border-slate-200 px-4 py-2">
            <h2 className="text-sm font-medium">
              {searchQuery.data.length} number{searchQuery.data.length === 1 ? '' : 's'} available
            </h2>
            <p className="text-xs text-slate-500">
              Region: {form.country} · Type: {form.type}
            </p>
          </header>
          {searchQuery.data.length === 0 ? (
            <p className="p-4 text-sm text-slate-600">
              No results. Try a different area code, region, or remove the contains filter.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {searchQuery.data.map((n) => (
                <li key={n.phoneNumber} className="flex items-center justify-between px-4 py-3">
                  <div className="text-sm">
                    <div className="font-medium">{formatPhone(n.phoneNumber)}</div>
                    <div className="text-xs text-slate-500">
                      {[n.locality, n.region, n.isoCountry].filter(Boolean).join(', ') || '—'}
                      {' · '}
                      {n.capabilities.voice ? 'Voice' : ''}
                      {n.capabilities.sms ? ' SMS' : ''}
                      {n.capabilities.mms ? ' MMS' : ''}
                      {n.beta ? ' · beta' : ''}
                      {n.addressRequirements !== 'none'
                        ? ` · address required (${n.addressRequirements})`
                        : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => setPendingPurchase(n.phoneNumber)}
                    className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-slate-100"
                  >
                    Purchase
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {pendingPurchase && (
        <PurchaseConfirmModal
          phoneNumber={pendingPurchase}
          submitting={purchase.isPending}
          error={purchase.error ? (purchase.error as ApiError).message : null}
          onCancel={() => setPendingPurchase(null)}
          onConfirm={() => purchase.mutate(pendingPurchase)}
        />
      )}
    </section>
  );
}

interface PurchaseConfirmModalProps {
  phoneNumber: string;
  submitting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

function PurchaseConfirmModal({
  phoneNumber,
  submitting,
  error,
  onCancel,
  onConfirm,
}: PurchaseConfirmModalProps) {
  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-md space-y-4 rounded bg-white p-6 shadow-lg">
        <h2 className="text-base font-semibold">Confirm purchase</h2>
        <p className="text-sm text-slate-700">
          Twilio will provision <span className="font-mono">{formatPhone(phoneNumber)}</span> to
          your account and start billing for it. Webhooks for voice and SMS will be configured
          automatically.
        </p>
        <ul className="list-disc space-y-1 pl-5 text-xs text-slate-600">
          <li>The number will appear in your account and Twilio Console.</li>
          <li>You can release it at any time from the number detail page.</li>
          <li>WhatsApp compatibility is not guaranteed.</li>
        </ul>
        {error && (
          <p className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800">
            {error}
          </p>
        )}
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
            disabled={submitting}
            className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
          >
            {submitting ? 'Purchasing…' : 'Confirm purchase'}
          </button>
        </div>
      </div>
    </div>
  );
}
