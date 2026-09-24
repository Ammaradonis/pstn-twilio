import { useEffect, useState } from 'react';

import { api } from '../lib/api-client';

export function InboundRecordingToggle({
  numberId,
  inCall,
}: {
  numberId: string;
  inCall: boolean;
}) {
  const [recordCall, setRecordCall] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setRecordCall(false);
    setError(null);
    api.voice
      .recordingPreference(numberId)
      .then((preference) => {
        if (cancelled) return;
        setRecordCall(preference.recordCall);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [numberId]);

  async function toggle() {
    setSaving(true);
    setError(null);
    try {
      const preference = await api.voice.setRecordingPreference(numberId, !recordCall);
      setRecordCall(preference.recordCall);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p id="inbound-record-label" className="text-sm font-medium text-slate-800">
            Record call
          </p>
          <p id="inbound-record-hint" className="text-xs text-slate-500">
            {!loaded
              ? 'Recording setting unavailable until loaded.'
              : recordCall
                ? 'Recording is on for answered incoming calls to this number.'
                : 'Incoming calls to this number are not recorded.'}{' '}
            Changes apply to calls that start ringing after you change this setting.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={recordCall}
          aria-labelledby="inbound-record-label"
          aria-describedby="inbound-record-hint"
          disabled={!loaded || saving || inCall}
          onClick={() => void toggle()}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full disabled:opacity-60 ${recordCall ? 'bg-rose-600' : 'bg-slate-300'}`}
        >
          <span
            aria-hidden="true"
            className={`inline-block h-5 w-5 rounded-full bg-white shadow ${recordCall ? 'translate-x-5' : 'translate-x-0.5'}`}
          />
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-rose-700">
          {error}
        </p>
      )}
    </div>
  );
}
