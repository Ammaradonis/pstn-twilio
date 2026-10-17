import type { CallDto, CallRecordingDto } from '@pstn-twilio/shared';
import { useEffect, useState } from 'react';

import { api } from '../lib/api-client';
import {
  callRecordingFilename,
  recordingExtension,
  recordingSourceLabel,
  saveBlob,
} from '../lib/download';

export function RecordingAudio({
  numberId,
  call,
  recording,
}: {
  numberId: string;
  call: CallDto;
  recording: CallRecordingDto;
}) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [busy, setBusy] = useState<'play' | 'download' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (src) URL.revokeObjectURL(src);
    };
  }, [src]);

  async function fetchBlob(): Promise<Blob> {
    if (blob) return blob;
    const fetched = await api.calls.recordingMedia(numberId, call.id, recording.id);
    setBlob(fetched);
    return fetched;
  }

  async function run(action: 'play' | 'download') {
    setBusy(action);
    setError(null);
    try {
      const media = await fetchBlob();
      if (action === 'play') {
        const url = URL.createObjectURL(media);
        setSrc((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
      } else {
        saveBlob(
          media,
          callRecordingFilename({
            prefix: recording.source === 'voicemail' ? 'voicemail' : 'call',
            counterpart: call.direction === 'OUTBOUND' ? (call.destination ?? call.to) : call.from,
            startedAt: call.startedAt,
            extension: recordingExtension(recording.contentType ?? media.type),
          }),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Recording unavailable');
    } finally {
      setBusy(null);
    }
  }

  if (recording.status !== 'COMPLETED') {
    return <span className="text-xs text-slate-500">{recording.status}</span>;
  }
  const extension = recordingExtension(recording.contentType).toUpperCase();

  return (
    <div className="flex flex-col gap-1">
      {call.recordings.length > 1 && (
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
          {recordingSourceLabel(recording.source)}
        </span>
      )}
      {src ? <audio controls preload="metadata" src={src} className="h-8 w-64 max-w-full" /> : null}
      <div className="flex gap-1">
        {!src && (
          <button
            type="button"
            onClick={() => void run('play')}
            disabled={busy !== null}
            className="w-fit rounded border border-slate-300 px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy === 'play' ? 'Loading…' : 'Play'}
          </button>
        )}
        <button
          type="button"
          onClick={() => void run('download')}
          disabled={busy !== null}
          aria-label={`Download recording as ${extension}`}
          className="w-fit rounded border border-slate-300 px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy === 'download' ? 'Downloading…' : `Download ${extension}`}
        </button>
      </div>
      {error ? <span className="max-w-48 text-xs text-red-600">{error}</span> : null}
    </div>
  );
}
