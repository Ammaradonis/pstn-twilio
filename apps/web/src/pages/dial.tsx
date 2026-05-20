import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';

import { useVoiceDevice } from '../hooks/use-voice-device';
import { api } from '../lib/api-client';

const E164_RE = /^\+[1-9]\d{1,14}$/;
const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'] as const;

function StatusPill({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        ok ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'
      }`}
    >
      {label}
    </span>
  );
}

export function DialPage() {
  const { numberId } = useParams<{ numberId: string }>();
  const [destination, setDestination] = useState('');
  const [callerId, setCallerId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const voice = useVoiceDevice();

  useEffect(() => {
    void voice.init(numberId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numberId]);

  useEffect(() => {
    if (!numberId) return;
    let cancelled = false;
    api.numbers
      .get(numberId)
      .then((n) => {
        if (!cancelled) setCallerId(n.phoneNumberE164);
      })
      .catch((err: unknown) => {
        if (!cancelled) setPageError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [numberId]);

  const valid = useMemo(() => E164_RE.test(destination), [destination]);

  async function handleCall() {
    setPageError(null);
    if (!numberId) return;
    if (!valid) {
      setPageError('Destination must be E.164 (e.g. +14155552671).');
      return;
    }
    if (!voice.registered) {
      setPageError('Voice device is not registered yet. Please wait.');
      return;
    }
    setSubmitting(true);
    try {
      const prep = await api.voice.prepareOutbound(numberId, destination);
      voice.makeCall(prep.selectedNumberId, prep.destinationNumber);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function handleHangup() {
    voice.hangup();
  }

  return (
    <section className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">Dial · {numberId}</h1>
        <p className="mt-1 text-sm text-slate-600">
          Place a PSTN call from your selected Twilio number. Caller ID is locked to this number and
          cannot be spoofed.
        </p>
      </header>

      <div className="rounded border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-700">Device readiness</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          <StatusPill
            label={voice.browserSupported ? 'WebRTC supported' : 'WebRTC unavailable'}
            ok={voice.browserSupported}
          />
          <StatusPill
            label={voice.registered ? 'Registered' : 'Not registered'}
            ok={voice.registered}
          />
          <StatusPill label={voice.ready ? 'Ready' : 'Initializing…'} ok={voice.ready} />
          <StatusPill
            label={`Mic: ${voice.micPermission}`}
            ok={voice.micPermission === 'granted'}
          />
        </div>
        {callerId && (
          <p className="mt-2 text-xs text-slate-500">
            Caller ID: <span className="font-mono">{callerId}</span>
          </p>
        )}
      </div>

      {!voice.browserSupported && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          Your browser does not support WebRTC. Use the latest Chrome, Edge, or Firefox.
        </div>
      )}
      {(pageError || voice.error) && (
        <div className="rounded border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800">
          {pageError ?? voice.error}
        </div>
      )}

      <div className="rounded border border-slate-200 bg-white p-4">
        <label className="text-sm text-slate-700">Destination (E.164)</label>
        <input
          value={destination}
          onChange={(e) => setDestination(e.target.value.trim())}
          placeholder="+14155552671"
          inputMode="tel"
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1 font-mono text-sm focus:border-slate-500 focus:outline-none"
        />
        {destination.length > 0 && !valid && (
          <p className="mt-1 text-xs text-rose-700">
            Enter an E.164 number with leading <span className="font-mono">+</span> and country
            code.
          </p>
        )}

        <div className="mt-3 grid grid-cols-3 gap-2">
          {DIGITS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDestination((prev) => prev + d)}
              className="rounded border border-slate-200 px-3 py-2 text-base hover:bg-slate-50"
            >
              {d}
            </button>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            onClick={handleCall}
            disabled={!valid || submitting || voice.active}
            className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {voice.active ? 'In call' : submitting ? 'Calling…' : 'Call'}
          </button>
          <button
            onClick={() => voice.toggleMute()}
            disabled={!voice.active}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-60"
          >
            {voice.isMuted ? 'Unmute' : 'Mute'}
          </button>
          <button
            onClick={handleHangup}
            disabled={!voice.active}
            className="rounded bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
          >
            Hangup
          </button>
          <button
            onClick={() => setDestination('')}
            disabled={destination.length === 0 || voice.active}
            className="ml-auto rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-60"
          >
            Clear
          </button>
        </div>

        <p className="mt-3 text-xs text-slate-500">
          Live state: <span className="font-mono">{voice.connectionState}</span>
        </p>
      </div>
    </section>
  );
}
