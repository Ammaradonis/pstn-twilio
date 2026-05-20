import { useEffect } from 'react';
import { useParams } from 'react-router-dom';

import { useVoiceDevice } from '../hooks/use-voice-device';

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

export function AnswerPage() {
  const { numberId } = useParams<{ numberId: string }>();
  const voice = useVoiceDevice();

  useEffect(() => {
    void voice.init(numberId);
    // intentionally only re-run when numberId changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numberId]);

  return (
    <section className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">Answer incoming call · {numberId}</h1>
        <p className="mt-1 text-sm text-slate-600">
          Inbound PSTN calls to this number ring this browser tab. Keep it open to receive calls.
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
        {voice.identity && (
          <p className="mt-2 text-xs text-slate-500">
            Identity: <span className="font-mono">{voice.identity}</span>
          </p>
        )}
      </div>

      {!voice.browserSupported && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          Your browser does not support WebRTC microphone access. Use the latest Chrome, Edge, or
          Firefox to answer calls in the browser.
        </div>
      )}
      {voice.micPermission === 'denied' && (
        <div className="rounded border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800">
          Microphone access is blocked for this site. Allow microphone permissions in the browser to
          answer calls.
        </div>
      )}
      {voice.error && (
        <div className="rounded border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800">
          {voice.error}
        </div>
      )}

      {voice.incoming ? (
        <div className="rounded border border-emerald-300 bg-emerald-50 p-4">
          <h2 className="text-lg font-semibold text-emerald-900">Incoming call</h2>
          <p className="mt-1 text-sm text-emerald-900">
            From: <span className="font-mono">{voice.incoming.from ?? 'unknown'}</span>
          </p>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => voice.accept()}
              className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700"
            >
              Answer
            </button>
            <button
              onClick={() => voice.reject()}
              className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
            >
              Reject
            </button>
          </div>
        </div>
      ) : voice.active ? (
        <div className="rounded border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-700">Live call</h2>
          <p className="mt-1 text-xs text-slate-500">State: {voice.connectionState}</p>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => voice.toggleMute()}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm"
            >
              {voice.isMuted ? 'Unmute' : 'Mute'}
            </button>
            <button
              onClick={() => voice.hangup()}
              className="rounded bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-rose-700"
            >
              Hangup
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
          No incoming calls right now. This page must stay open to receive PSTN calls.
        </div>
      )}
    </section>
  );
}
