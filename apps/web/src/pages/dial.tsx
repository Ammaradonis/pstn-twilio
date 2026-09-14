import {
  normalizeDialablePhoneNumber,
  type LastDialDto,
  type OutboundCallPreparationDto,
} from '@pstn-twilio/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';

import { useVoiceDevice } from '../hooks/use-voice-device';
import { api, ApiError } from '../lib/api-client';
import { formatDate, formatPhone } from '../lib/format';
import { watchRecordingDownload } from '../lib/recording-downloads';

const DIALPAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#', '+'] as const;
const RECORD_CALLS_STORAGE_KEY = 'pstn-twilio.record-calls';

// Calls were always recorded before this setting existed, so recording stays
// on until the user turns it off.
function readRecordCallsPreference(): boolean {
  try {
    return window.localStorage.getItem(RECORD_CALLS_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

function writeRecordCallsPreference(value: boolean): void {
  try {
    window.localStorage.setItem(RECORD_CALLS_STORAGE_KEY, String(value));
  } catch {
    // Not persisted; the toggle still applies to this page.
  }
}

function isMissingLastDialEndpointError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

function StatusPill({ label, ok, pending }: { label: string; ok: boolean; pending?: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        ok
          ? 'bg-emerald-100 text-emerald-700'
          : pending
            ? 'bg-amber-100 text-amber-800'
            : 'bg-slate-100 text-slate-600'
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
  const [sentTones, setSentTones] = useState('');
  const [repeatDialWarning, setRepeatDialWarning] = useState<LastDialDto | null>(null);
  const [recordCall, setRecordCall] = useState<boolean>(readRecordCallsPreference);
  const [activeCallRecorded, setActiveCallRecorded] = useState(false);
  const voice = useVoiceDevice();
  const inCallMode =
    voice.active ||
    voice.canSendDigits ||
    voice.connectionState === 'pending' ||
    voice.connectionState === 'ringing' ||
    voice.connectionState === 'open';
  const sendDtmfDigits = voice.sendDigits;

  function setDestinationFromInput(value: string) {
    setDestination(normalizeDialablePhoneNumber(value) ?? value.trim());
  }

  function appendDestinationKey(key: (typeof DIALPAD_KEYS)[number]) {
    if (key === '+') {
      setDestination((prev) => {
        const trimmed = prev.trim();
        return trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
      });
      return;
    }

    setDestination((prev) => normalizeDialablePhoneNumber(prev + key) ?? prev + key);
  }

  const sendDialpadTone = useCallback(
    (key: string) => {
      sendDtmfDigits(key);
      setSentTones((prev) => `${prev}${key}`.slice(-24));
    },
    [sendDtmfDigits],
  );

  function handleDialpadKey(key: (typeof DIALPAD_KEYS)[number]) {
    if (inCallMode) {
      if (key !== '+') {
        sendDialpadTone(key);
        setDestination((prev) => prev + key);
      }
      return;
    }

    appendDestinationKey(key);
  }

  useEffect(() => {
    void voice.init(numberId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numberId]);

  useEffect(() => {
    if (inCallMode) return;
    setSentTones('');
    setActiveCallRecorded(false);
  }, [inCallMode]);

  function toggleRecordCall() {
    setRecordCall((prev) => {
      writeRecordCallsPreference(!prev);
      return !prev;
    });
  }

  useEffect(() => {
    if (!inCallMode) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (!/^[0-9*#]$/.test(event.key)) return;
      event.preventDefault();
      sendDialpadTone(event.key);
      setDestination((prev) => prev + event.key);
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [inCallMode, sendDialpadTone]);

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

  async function placeCall(
    destinationNumber: string | null = normalizedDestination,
    opts: { skipRepeatWarning?: boolean } = {},
  ) {
    setPageError(null);
    if (!numberId) return;
    if (!destinationNumber) {
      setPageError('Enter a valid U.S. phone number, such as +1 530-441-9961.');
      return;
    }
    if (voice.micPermission === 'denied') {
      setPageError(
        'Microphone permission was denied (31401). Please allow microphone permissions in your browser settings (click the lock or tune icon next to the address bar) and try again.',
      );
      return;
    }
    if (voice.micPermission !== 'granted' && typeof voice.requestMicPermission === 'function') {
      const granted = await voice.requestMicPermission();
      if (!granted) {
        return;
      }
    }
    setSubmitting(true);
    try {
      if (!opts.skipRepeatWarning) {
        let lastDial: LastDialDto | null = null;
        try {
          lastDial = await api.calls.lastDial(numberId, destinationNumber);
        } catch (err) {
          if (!isMissingLastDialEndpointError(err)) throw err;
        }
        if (lastDial) {
          setRepeatDialWarning(lastDial);
          return;
        }
      }
      const prepared: { current: OutboundCallPreparationDto | null } = { current: null };
      const call = await voice.makeCall(numberId, destinationNumber, {
        recordCall,
        onPrepared: (p) => {
          prepared.current = p;
        },
      });
      // An API that predates the setting omits recordCall and always records.
      if (call && prepared.current && prepared.current.recordCall !== false) {
        setActiveCallRecorded(true);
        watchRecordingDownload({
          outboundIntentId: prepared.current.outboundIntentId,
          numberId,
          destination: prepared.current.destinationNumber,
          intentExpiresAt: prepared.current.expiresAt,
        });
      }
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

  async function confirmRepeatDial() {
    if (!repeatDialWarning) return;
    const destinationNumber = repeatDialWarning.destinationNumber;
    setRepeatDialWarning(null);
    await placeCall(destinationNumber, { skipRepeatWarning: true });
  }

  function cancelRepeatDial() {
    setRepeatDialWarning(null);
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
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <StatusPill
            label={voice.browserSupported ? 'WebRTC supported' : 'WebRTC unavailable'}
            ok={voice.browserSupported}
          />
          <StatusPill
            label={
              voice.registered
                ? 'Registered'
                : voice.reconnecting
                  ? 'Reconnecting…'
                  : 'Not registered'
            }
            ok={voice.registered}
            pending={voice.reconnecting}
          />
          {!voice.reconnecting && (
            <StatusPill label={voice.ready ? 'Ready' : 'Initializing…'} ok={voice.ready} />
          )}
          <StatusPill
            label={`Mic: ${voice.micPermission}`}
            ok={voice.micPermission === 'granted'}
          />
          {voice.micPermission !== 'granted' && voice.browserSupported && (
            <button
              type="button"
              onClick={() => void voice.requestMicPermission()}
              className="rounded border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-900 hover:bg-amber-100"
            >
              {voice.micPermission === 'denied'
                ? 'Re-check Microphone Permission'
                : 'Enable Microphone'}
            </button>
          )}
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
      {voice.micPermission === 'denied' && (
        <div className="rounded border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800">
          <p className="font-semibold">Microphone access is blocked (Twilio 31401)</p>
          <p className="mt-1 text-xs">
            The browser or user denied permissions to the microphone. To fix this:
          </p>
          <ol className="mt-1 list-decimal list-inside space-y-0.5 text-xs">
            <li>Click the lock or site settings icon in your browser address bar.</li>
            <li>
              Change the <strong>Microphone</strong> permission from Block to <strong>Allow</strong>
              .
            </li>
            <li>
              Click <strong>Re-check Microphone Permission</strong> above or refresh the page.
            </li>
          </ol>
        </div>
      )}
      {(pageError || voice.error) && voice.micPermission !== 'denied' && (
        <div className="rounded border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800">
          {pageError ?? voice.error}
        </div>
      )}

      <div className="rounded border border-slate-200 bg-white p-4">
        <label htmlFor="destination-number" className="text-sm text-slate-700">
          Destination (E.164)
        </label>
        <div className="mt-1 flex gap-2">
          <input
            id="destination-number"
            value={destination}
            onChange={(e) => setDestinationFromInput(e.target.value)}
            onPaste={(e) => {
              const normalized = normalizeDialablePhoneNumber(e.clipboardData.getData('text'));
              e.preventDefault();
              if (!normalized) {
                setPageError('Pasted text does not contain a dialable phone number.');
                return;
              }
              setPageError(null);
              setDestination(normalized);
            }}
            placeholder="+1 530-441-9961"
            inputMode="tel"
            readOnly={inCallMode}
            className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 font-mono text-sm focus:border-slate-500 focus:outline-none read-only:bg-slate-50"
          />
          <button
            type="button"
            onClick={handlePasteAndCall}
            disabled={submitting || inCallMode || voice.micPermission === 'denied'}
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
          {DIALPAD_KEYS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => handleDialpadKey(d)}
              disabled={inCallMode && d === '+'}
              className={`rounded border border-slate-200 px-3 py-2 text-base hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 ${
                d === '+' ? 'col-start-2' : ''
              }`}
            >
              {d}
            </button>
          ))}
        </div>
        {sentTones && (
          <p className="mt-2 text-xs text-slate-500">
            Tones: <span className="font-mono">{sentTones}</span>
          </p>
        )}

        <div className="mt-4 flex items-center justify-between gap-3 rounded border border-slate-200 px-3 py-2">
          <div className="min-w-0">
            <p id="record-call-label" className="text-sm font-medium text-slate-800">
              Record call
              {inCallMode && activeCallRecorded && (
                <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-700">
                  <span
                    className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose-600"
                    aria-hidden="true"
                  />
                  Recording
                </span>
              )}
            </p>
            <p id="record-call-hint" className="text-xs text-slate-500">
              {inCallMode
                ? activeCallRecorded
                  ? 'The MP3 downloads automatically after the call ends.'
                  : 'Changes apply to your next call.'
                : recordCall
                  ? 'The call is recorded and the MP3 downloads automatically when it ends.'
                  : 'The call will not be recorded.'}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={recordCall}
            aria-labelledby="record-call-label"
            aria-describedby="record-call-hint"
            onClick={toggleRecordCall}
            disabled={inCallMode || submitting}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 ${
              recordCall ? 'bg-rose-600' : 'bg-slate-300'
            }`}
          >
            <span
              aria-hidden="true"
              className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
                recordCall ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            onClick={handleCall}
            disabled={!valid || submitting || inCallMode || voice.micPermission === 'denied'}
            className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {inCallMode ? 'In call' : submitting ? 'Calling…' : 'Call'}
          </button>
          <button
            onClick={() => voice.toggleMute()}
            disabled={!inCallMode}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-60"
          >
            {voice.isMuted ? 'Unmute' : 'Mute'}
          </button>
          <button
            onClick={handleHangup}
            disabled={!inCallMode}
            className="rounded bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
          >
            Hangup
          </button>
          <button
            onClick={() => setDestination('')}
            disabled={destination.length === 0 || inCallMode}
            className="ml-auto rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-60"
          >
            Clear
          </button>
        </div>

        <p className="mt-3 text-xs text-slate-500">
          Live state: <span className="font-mono">{voice.connectionState}</span>
        </p>
      </div>

      {repeatDialWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="repeat-dial-title"
            className="w-full max-w-md rounded border border-amber-300 bg-white p-4 shadow-lg"
          >
            <h2 id="repeat-dial-title" className="text-base font-semibold text-slate-900">
              Warning: number dialed before
            </h2>
            <p className="mt-2 text-sm text-slate-700">
              You last dialed{' '}
              <span className="font-mono">{formatPhone(repeatDialWarning.destinationNumber)}</span>{' '}
              on <span className="font-medium">{formatDate(repeatDialWarning.lastDialedAt)}</span>.
              Do you want to call this number again?
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={cancelRepeatDial}
                disabled={submitting}
                className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-60"
              >
                No
              </button>
              <button
                type="button"
                onClick={() => void confirmRepeatDial()}
                disabled={submitting}
                className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
              >
                Yes
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
