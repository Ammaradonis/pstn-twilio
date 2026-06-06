import type { CallDto, CallRecordingDto } from '@pstn-twilio/shared';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';

import { useRealtimeCalls } from '../hooks/use-realtime-calls';
import { api } from '../lib/api-client';

export function CallsPage() {
  const { numberId } = useParams<{ numberId: string }>();
  const queryClient = useQueryClient();

  useRealtimeCalls(numberId);

  const callsQuery = useQuery({
    queryKey: ['calls', numberId],
    enabled: Boolean(numberId),
    queryFn: () => api.calls.list(numberId!, { limit: 50 }),
    staleTime: 30_000,
  });

  const items = useMemo(() => callsQuery.data?.items ?? [], [callsQuery.data]);

  return (
    <section>
      <h1 className="text-2xl font-semibold">Call log · {numberId}</h1>
      <p className="mt-2 text-sm text-slate-600">
        Inbound and outbound call history for the selected number.
      </p>

      <div className="mt-4">
        {callsQuery.isLoading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-slate-500">No calls yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full table-auto border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="px-3 py-2">Direction</th>
                  <th className="px-3 py-2">From</th>
                  <th className="px-3 py-2">To</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Duration</th>
                  <th className="px-3 py-2">Recordings</th>
                  <th className="px-3 py-2">Started</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">{c.direction}</td>
                    <td className="px-3 py-2 font-mono">{c.from}</td>
                    <td className="px-3 py-2 font-mono">{c.to}</td>
                    <td className="px-3 py-2">{c.status}</td>
                    <td className="px-3 py-2">{c.durationSeconds ?? '—'}</td>
                    <td className="px-3 py-2">
                      <RecordingCell numberId={numberId!} call={c} />
                    </td>
                    <td className="px-3 py-2">{new Date(c.startedAt).toLocaleString()}</td>
                    <td className="px-3 py-2">
                      <button
                        onClick={async () => {
                          try {
                            await api.calls.hangup(c.id);
                            queryClient.invalidateQueries({ queryKey: ['calls', numberId] });
                          } catch {
                            // ignore
                          }
                        }}
                        className="rounded border border-slate-300 px-2 py-1 text-xs"
                      >
                        Hangup
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function RecordingCell({ numberId, call }: { numberId: string; call: CallDto }) {
  if (call.recordings.length === 0) return <span className="text-slate-400">—</span>;

  return (
    <div className="flex min-w-48 flex-col gap-2">
      {call.recordings.map((recording) => (
        <RecordingAudio
          key={recording.id}
          numberId={numberId}
          callId={call.id}
          recording={recording}
        />
      ))}
    </div>
  );
}

function RecordingAudio({
  numberId,
  callId,
  recording,
}: {
  numberId: string;
  callId: string;
  recording: CallRecordingDto;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (src) URL.revokeObjectURL(src);
    };
  }, [src]);

  async function loadRecording() {
    setLoading(true);
    setError(null);
    try {
      const blob = await api.calls.recordingMedia(numberId, callId, recording.id);
      const url = URL.createObjectURL(blob);
      setSrc((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Recording unavailable');
    } finally {
      setLoading(false);
    }
  }

  if (recording.status !== 'COMPLETED') {
    return <span className="text-xs text-slate-500">{recording.status}</span>;
  }

  if (src) {
    return <audio controls preload="metadata" src={src} className="h-8 w-64 max-w-full" />;
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={loadRecording}
        disabled={loading}
        className="w-fit rounded border border-slate-300 px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? 'Loading…' : 'Play'}
      </button>
      {error ? <span className="max-w-48 text-xs text-red-600">{error}</span> : null}
    </div>
  );
}
