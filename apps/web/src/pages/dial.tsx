import { normalizeDialablePhoneNumber } from '@pstn-twilio/shared';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';

import { useVoiceDevice } from '../hooks/use-voice-device';
import { api } from '../lib/api-client';

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

  function setDestinationFromInput(value: string) {
    setDestination(normalizeDialablePhoneNumber(value) ?? value.trim());
  }

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

  const normalizedDestination = useMemo(
    () => normalizeDialablePhoneNumber(destination),
    [destination],
  );
  const valid = normalizedDestination !== null;

  async function placeCall(destinationNumber: string | null = normalizedDestination) {
    setPageError(null);
    if (!numberId) return;
    if (!destinationNumber) {
      setPageError('Enter a valid U.S. phone number, such as +1 530-441-9961.');
      return;
    }
    setSubmitting(true);
    try {
      const prep = await api.voice.prepareOutbound(numberId, destinationNumber);
      await voice.makeCall(prep.selectedNumberId, prep.destinationNumber);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCall() {
    await placeCall();
  }

  async function handlePasteAndCall() {
    setPageError(null);
    setDestination('');
    if (!navigator.clipboard?.readText) {
      setPageError('Clipboard access is unavailable in this browser.');
      return;
    }

    try {
      const pasted = await navigator.clipboard.readText();
      const normalized = normalizeDialablePhoneNumber(pasted);
      if (!normalized) {
        setPageError('Clipboard does not contain a dialable phone number.');
        return;
      }
      setDestination(normalized);
      await placeCall(normalized);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : String(err));
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
        <div className="mt-1 flex gap-2">
          <input
            value={destination}
            onChange={(e) => setDestinationFromInput(e.target.value)}
            onPaste={(e) => {
              const normalized = normalizeDialablePhoneNumber(e.clipboardData.getData('text'));
              if (!normalized) return;
              e.preventDefault();
              setDestination(normalized);
            }}
            placeholder="+1 530-441-9961"
            inputMode="tel"
            className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 font-mono text-sm focus:border-slate-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={handlePasteAndCall}
            disabled={submitting || voice.active}
            title="Paste a phone number from the clipboard and call it"
            className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Paste
          </button>
        </div>
        {destination.length > 0 && !valid && (
          <p className="mt-1 text-xs text-rose-700">
            Enter a U.S. phone number such as <span className="font-mono">+1 530-441-9961</span> or{' '}
            <span className="font-mono">530-441-9961</span>.
          </p>
        )}

        <div className="mt-3 grid grid-cols-3 gap-2">
          {DIGITS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() =>
                setDestination((prev) => normalizeDialablePhoneNumber(prev + d) ?? prev + d)
              }
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
