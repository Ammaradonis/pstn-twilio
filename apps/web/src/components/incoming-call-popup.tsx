/**
 * App-wide incoming call popup.
 *
 * Mounted once in the app layout, it keeps the voice device registered on
 * every page, so a call to any of the user's numbers rings wherever the app is
 * open (the Twilio SDK plays the ringtone) without going to the Answer page.
 * While a call rings it shows the caller with a green Answer and a red Hang up
 * button. Once answered it shrinks to a bar at the bottom with the caller, the
 * call time and Hang up.
 */

import { useEffect, useState } from 'react';

import { useVoiceDevice } from '../hooks/use-voice-device';
import { useBrowserRecordingStatus } from '../lib/browser-recordings';
import { formatPhone } from '../lib/format';

// Android vibrates with the ringtone. Chrome allows it once the app has been
// tapped at least once; otherwise the call still rings, just without buzzing.
const VIBRATE_MS = 800;
const VIBRATE_EVERY_MS = 1_600;

type AnsweredCall = { from: string; connectedAt: number | null };

function PhoneIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.01-.24c1.12.37 2.33.57 3.58.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.46.57 3.58a1 1 0 0 1-.25 1.01l-2.2 2.2z" />
    </svg>
  );
}

function HangUpIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.96.96 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.3 11.3 0 0 0-2.67-1.85 1 1 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z" />
    </svg>
  );
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function callerLabel(from: string | undefined): string {
  if (!from) return 'Unknown caller';
  // Withheld numbers reach the browser as e.g. "client:Anonymous".
  if (!/\d/.test(from)) return 'Unknown caller';
  return formatPhone(from);
}

export function IncomingCallPopup() {
  const voice = useVoiceDevice();
  const recording = useBrowserRecordingStatus();
  const recordingNow = recording?.direction === 'inbound' && recording.state === 'recording';
  const { init, destroy } = voice;
  const [answering, setAnswering] = useState(false);
  const [answered, setAnswered] = useState<AnsweredCall | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // One device for the whole signed-in app; leaving it (sign out) unregisters.
  useEffect(() => {
    void init();
    return () => destroy();
  }, [init, destroy]);

  const ringing = Boolean(voice.incoming);
  useEffect(() => {
    if (!ringing || typeof navigator.vibrate !== 'function') return;
    const buzz = () => {
      try {
        navigator.vibrate(VIBRATE_MS);
      } catch {
        /* not allowed before the first tap */
      }
    };
    buzz();
    const timer = setInterval(buzz, VIBRATE_EVERY_MS);
    return () => {
      clearInterval(timer);
      try {
        navigator.vibrate(0);
      } catch {
        /* ignore */
      }
    };
  }, [ringing]);

  // The bar belongs to the answered call only: it goes once that call ends.
  const connected = voice.active && voice.connectionState === 'open';
  useEffect(() => {
    if (!answered) return;
    if (!voice.active && !voice.incoming && !answering) {
      setAnswered(null);
      return;
    }
    if (connected && answered.connectedAt === null) {
      setAnswered({ ...answered, connectedAt: Date.now() });
    }
  }, [answered, answering, connected, voice.active, voice.incoming]);

  useEffect(() => {
    if (!answered?.connectedAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [answered?.connectedAt]);

  async function answer() {
    if (answering || !voice.incoming) return;
    setAnswering(true);
    try {
      if (voice.micPermission !== 'granted') {
        const granted = await voice.requestMicPermission();
        if (!granted) return;
      }
      setAnswered({ from: callerLabel(voice.incoming.from), connectedAt: null });
      await voice.accept();
    } finally {
      setAnswering(false);
    }
  }

  if (voice.incoming) {
    const micBlocked = voice.micPermission === 'denied';
    return (
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="incoming-call-title"
        aria-describedby="incoming-call-caller"
        className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/70 p-4 sm:items-center"
      >
        <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-2xl">
          <span className="mx-auto flex h-14 w-14 animate-pulse items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
            <PhoneIcon className="h-7 w-7" />
          </span>
          <h2 id="incoming-call-title" className="mt-3 text-sm font-medium text-slate-500">
            Incoming call
          </h2>
          <p
            id="incoming-call-caller"
            className="mt-1 break-words text-2xl font-semibold text-slate-900"
          >
            {callerLabel(voice.incoming.from)}
          </p>
          {voice.incoming.calledNumber && (
            <p className="mt-1 text-sm text-slate-500">
              to {formatPhone(voice.incoming.calledNumber)}
            </p>
          )}
          {micBlocked && (
            <p className="mt-3 text-xs text-rose-700">
              Microphone is blocked. Allow it in the site settings to answer.
            </p>
          )}
          {voice.error && !micBlocked && (
            <p className="mt-3 text-xs text-rose-700">{voice.error}</p>
          )}
          <div className="mt-6 flex justify-center gap-12">
            <button
              type="button"
              onClick={() => voice.reject()}
              className="flex flex-col items-center gap-2 text-sm font-medium text-slate-700"
            >
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-rose-600 text-white shadow-lg hover:bg-rose-700 active:bg-rose-800">
                <HangUpIcon className="h-8 w-8" />
              </span>
              Hang up
            </button>
            <button
              type="button"
              onClick={() => void answer()}
              disabled={answering || micBlocked}
              className="flex flex-col items-center gap-2 text-sm font-medium text-slate-700 disabled:opacity-50"
            >
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-600 text-white shadow-lg hover:bg-emerald-700 active:bg-emerald-800">
                <PhoneIcon className="h-8 w-8" />
              </span>
              {answering ? 'Answering…' : 'Answer'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (answered && voice.active) {
    return (
      <>
        <div aria-hidden="true" className="h-20" />
        <div className="fixed inset-x-0 bottom-0 z-40 p-3">
          <div
            role="status"
            className="mx-auto flex max-w-md items-center gap-3 rounded-2xl bg-slate-900 px-4 py-3 text-white shadow-2xl"
          >
            <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-400" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{answered.from}</p>
              <p className="text-xs text-slate-300">
                {answered.connectedAt ? formatElapsed(now - answered.connectedAt) : 'Connecting…'}
                {recordingNow && <span className="text-rose-300"> · Recording</span>}
              </p>
            </div>
            <button
              type="button"
              onClick={() => voice.hangup()}
              className="flex items-center gap-2 rounded-full bg-rose-600 px-4 py-2 text-sm font-semibold hover:bg-rose-700 active:bg-rose-800"
            >
              <HangUpIcon className="h-5 w-5" />
              Hang up
            </button>
          </div>
        </div>
      </>
    );
  }

  return null;
}
