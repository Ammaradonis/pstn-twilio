import { VOICEMAIL_DROP_MAX_MS, type VoicemailDropDto } from '@pstn-twilio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../lib/api-client';
import { formatClock, formatDate } from '../lib/format';
import {
  audioToWav,
  blobToBase64,
  startMicRecording,
  type MicRecording,
  type WavAudio,
} from '../lib/wav-audio';

// Shared with the Dial page, which enables "Drop voicemail" once a message exists.
const MESSAGE_KEY = ['voicemail-drop'] as const;
// The microphone picked for calls on the Dial page.
const MICROPHONE_STORAGE_KEY = 'pstn-twilio.microphone';
// A take whose loudest sample stays below this most likely heard nothing.
const QUIET_PEAK = 0.02;

type Take = WavAudio & { url: string; fileName?: string };

type Stage =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'recording'; startedAt: number }
  | { kind: 'processing' }
  | { kind: 'review'; take: Take };

function readStoredMicrophone(): string | undefined {
  try {
    return window.localStorage.getItem(MICROPHONE_STORAGE_KEY) || undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function micErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access is blocked. Allow it from the lock or tune icon next to the address bar, then try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone was found. Plug one in or pick another on the Dial page.';
  }
  if (typeof MediaRecorder === 'undefined') {
    return 'This browser cannot record audio. Upload an audio file instead.';
  }
  return `Could not start the microphone: ${errorMessage(err)}`;
}

function useObjectUrl(blob: Blob | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

export function VoicemailDropPage() {
  const queryClient = useQueryClient();
  const message = useQuery({ queryKey: MESSAGE_KEY, queryFn: api.voicemailDrop.get });
  const saved = message.data ?? null;
  const savedAudio = useQuery({
    queryKey: [...MESSAGE_KEY, 'audio', saved?.updatedAt],
    queryFn: api.voicemailDrop.audio,
    enabled: Boolean(saved),
    staleTime: Infinity,
  });
  const savedUrl = useObjectUrl(saved ? savedAudio.data : null);

  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const recordingRef = useRef<MicRecording | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (stage.kind !== 'recording') return;
    const timer = setInterval(() => setElapsedMs(Date.now() - stage.startedAt), 200);
    return () => clearInterval(timer);
  }, [stage]);

  // Leaving the page mid-recording releases the microphone.
  useEffect(() => () => recordingRef.current?.cancel(), []);

  const take = stage.kind === 'review' ? stage.take : null;
  useEffect(() => {
    if (!take) return;
    return () => URL.revokeObjectURL(take.url);
  }, [take]);

  async function review(source: Blob, fileName?: string) {
    const wav = await audioToWav(source, { tidy: true });
    if (wav.durationMs < 500) throw new Error('It is shorter than half a second.');
    if (wav.durationMs > VOICEMAIL_DROP_MAX_MS) {
      throw new Error(
        `It runs ${formatClock(wav.durationMs)}; the limit is ${formatClock(VOICEMAIL_DROP_MAX_MS)}.`,
      );
    }
    setStage({ kind: 'review', take: { ...wav, url: URL.createObjectURL(wav.blob), fileName } });
  }

  async function startRecording() {
    setError(null);
    setLevel(0);
    setElapsedMs(0);
    setStage({ kind: 'starting' });
    try {
      recordingRef.current = await startMicRecording({
        maxMs: VOICEMAIL_DROP_MAX_MS,
        deviceId: readStoredMicrophone(),
        onLevel: setLevel,
        onLimit: () => void stopRecording(),
      });
      setStage({ kind: 'recording', startedAt: Date.now() });
    } catch (err) {
      setStage({ kind: 'idle' });
      setError(micErrorMessage(err));
    }
  }

  async function stopRecording() {
    const recording = recordingRef.current;
    if (!recording) return;
    recordingRef.current = null;
    setStage({ kind: 'processing' });
    try {
      await review(await recording.stop());
    } catch (err) {
      setStage({ kind: 'idle' });
      setError(`Could not use that recording. ${errorMessage(err)}`);
    }
  }

  function cancelRecording() {
    recordingRef.current?.cancel();
    recordingRef.current = null;
    setStage({ kind: 'idle' });
  }

  async function onFileChosen(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(null);
    setStage({ kind: 'processing' });
    try {
      await review(file, file.name);
    } catch (err) {
      setStage({ kind: 'idle' });
      setError(`Could not use ${file.name}. ${errorMessage(err)}`);
    }
  }

  const save = useMutation({
    mutationFn: async (t: Take) =>
      api.voicemailDrop.save(await blobToBase64(t.blob), Math.round(t.durationMs)),
    onSuccess: (next: VoicemailDropDto, t) => {
      // The take is the saved audio; no need to download it again.
      queryClient.setQueryData([...MESSAGE_KEY, 'audio', next.updatedAt], t.blob);
      queryClient.setQueryData(MESSAGE_KEY, next);
      setStage({ kind: 'idle' });
    },
    onError: (err) => setError(`Could not save the message: ${errorMessage(err)}`),
  });

  const remove = useMutation({
    mutationFn: () => api.voicemailDrop.remove(),
    onSuccess: () => queryClient.setQueryData(MESSAGE_KEY, null),
    onError: (err) => setError(`Could not delete the message: ${errorMessage(err)}`),
  });

  function confirmRemove() {
    if (
      window.confirm(
        'Delete your voicemail message? Drop voicemail stays off until you record a new one.',
      )
    ) {
      setError(null);
      remove.mutate();
    }
  }

  const busy = stage.kind !== 'idle' && stage.kind !== 'review';

  return (
    <section className="max-w-3xl space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">Voicemail drop</h1>
        <p className="mt-1 text-sm text-slate-600">
          The message the <strong>Drop voicemail</strong> button leaves when an outbound call
          reaches voicemail. Re-record it whenever you like; the next drop uses the latest one.
        </p>
      </header>

      <div className="rounded border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Your message
        </h2>
        {message.isLoading ? (
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        ) : message.isError ? (
          <p role="alert" className="mt-3 text-sm text-rose-700">
            Could not load your message: {errorMessage(message.error)}
          </p>
        ) : saved ? (
          <div className="mt-3 space-y-3">
            <p className="text-sm text-slate-700">
              <span className="font-semibold">{formatClock(saved.durationMs)}</span> · recorded{' '}
              {formatDate(saved.updatedAt)}
            </p>
            {savedUrl ? (
              <audio
                controls
                preload="metadata"
                src={savedUrl}
                aria-label="Your voicemail message"
                className="w-full max-w-md"
              />
            ) : savedAudio.isError ? (
              <p className="text-sm text-rose-700">Could not load the audio.</p>
            ) : (
              <p className="text-sm text-slate-500">Loading audio…</p>
            )}
            <button
              type="button"
              onClick={confirmRemove}
              disabled={remove.isPending}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50 disabled:opacity-60"
            >
              {remove.isPending ? 'Deleting…' : 'Delete message'}
            </button>
          </div>
        ) : (
          <p className="mt-3 text-sm text-slate-600">
            No message yet. Record one below; <strong>Drop voicemail</strong> on the Dial page stays
            off until you do.
          </p>
        )}
      </div>

      <div className="rounded border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          {saved ? 'Record a new message' : 'Record your message'}
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Up to {formatClock(VOICEMAIL_DROP_MAX_MS)}. Silence before and after you speak is trimmed
          and the volume is levelled.
        </p>

        {stage.kind === 'idle' || stage.kind === 'starting' ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void startRecording()}
              disabled={stage.kind === 'starting'}
              className="inline-flex items-center gap-2 rounded bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
            >
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-white" />
              {stage.kind === 'starting' ? 'Starting…' : 'Record'}
            </button>
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={stage.kind === 'starting'}
              className="rounded border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-60"
            >
              Upload a file
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="audio/*"
              onChange={(e) => void onFileChosen(e)}
              className="hidden"
              data-testid="voicemail-file"
            />
          </div>
        ) : null}

        {stage.kind === 'recording' && (
          <div className="mt-3 space-y-3">
            <p role="status" className="flex items-center gap-2 text-sm font-medium text-rose-700">
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 animate-pulse rounded-full bg-rose-600"
              />
              Recording {formatClock(elapsedMs)} / {formatClock(VOICEMAIL_DROP_MAX_MS)}
            </p>
            <div
              className="h-2 w-full max-w-md overflow-hidden rounded bg-slate-100"
              role="meter"
              aria-label="Microphone level"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(level * 100)}
            >
              <div
                className="h-full bg-emerald-500 transition-[width] duration-75"
                style={{ width: `${Math.round(level * 100)}%` }}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void stopRecording()}
                className="rounded bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
              >
                Stop
              </button>
              <button
                type="button"
                onClick={cancelRecording}
                className="rounded border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {stage.kind === 'processing' && (
          <p role="status" className="mt-3 text-sm text-slate-600">
            Preparing the audio…
          </p>
        )}

        {take && (
          <div className="mt-3 space-y-3">
            <p className="text-sm text-slate-700">
              New take{take.fileName ? ` from ${take.fileName}` : ''} ·{' '}
              <span className="font-semibold">{formatClock(take.durationMs)}</span>. Listen before
              saving.
            </p>
            <audio
              controls
              preload="metadata"
              src={take.url}
              aria-label="New take"
              className="w-full max-w-md"
            />
            {take.peak < QUIET_PEAK && (
              <p className="text-sm text-amber-700">
                This take is almost silent. Check the microphone and record again.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  save.mutate(take);
                }}
                disabled={save.isPending}
                className="rounded bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
              >
                {save.isPending ? 'Saving…' : saved ? 'Replace my message' : 'Save as my message'}
              </button>
              <button
                type="button"
                onClick={() => void startRecording()}
                disabled={save.isPending}
                className="rounded border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-60"
              >
                Record again
              </button>
              <button
                type="button"
                onClick={() => setStage({ kind: 'idle' })}
                disabled={save.isPending}
                className="rounded border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-60"
              >
                Discard
              </button>
            </div>
          </div>
        )}

        {error && !busy && (
          <p role="alert" className="mt-3 text-sm text-rose-700">
            {error}
          </p>
        )}
      </div>

      <div className="rounded border border-slate-200 bg-white p-4 text-sm text-slate-700">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">On a call</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>Place an outbound call from the Dial page.</li>
          <li>When it reaches voicemail, wait for the beep.</li>
          <li>
            Press <strong>Drop voicemail</strong>. Your side of the call ends at once and you can
            dial the next number. Twilio plays this message into their mailbox, then hangs up.
          </li>
        </ol>
        <p className="mt-2 text-xs text-slate-500">
          Works on outbound calls you place from this app, once the call is answered (by a person or
          a voicemail box).{' '}
          <Link to="/numbers" className="underline">
            Go to your numbers
          </Link>
        </p>
      </div>
    </section>
  );
}
