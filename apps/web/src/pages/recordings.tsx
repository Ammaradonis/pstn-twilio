import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';

import { RecordingAudio } from '../components/recording-audio';
import { useRealtimeCalls } from '../hooks/use-realtime-calls';
import { api } from '../lib/api-client';
import { callRecordingFilename, recordingExtension } from '../lib/download';
import { formatDate, formatPhone } from '../lib/format';

export function RecordingsPage() {
  const { numberId } = useParams<{ numberId: string }>();
  useRealtimeCalls(numberId);

  const numberQuery = useQuery({
    queryKey: ['numbers', numberId],
    queryFn: () => api.numbers.get(numberId!),
    enabled: Boolean(numberId),
  });
  const recordingsQuery = useInfiniteQuery({
    queryKey: ['recordings', numberId],
    queryFn: ({ pageParam }) =>
      api.calls.list(numberId!, { limit: 50, hasRecordings: true, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(numberId),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  const recordings = (recordingsQuery.data?.pages ?? []).flatMap((page) =>
    page.items.flatMap((call) =>
      call.recordings
        .filter((recording) => recording.status === 'COMPLETED')
        .map((recording) => ({ call, recording })),
    ),
  );

  return (
    <section className="space-y-4">
      <header>
        <Link to="/numbers" className="text-sm text-slate-500 hover:underline">
          ← Numbers
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Recordings</h1>
        {numberQuery.data && (
          <Link to={`/numbers/${numberId}`} className="mt-1 inline-block text-sm hover:underline">
            {formatPhone(numberQuery.data.phoneNumberE164)} · {numberQuery.data.friendlyName}
          </Link>
        )}
        <p className="mt-2 text-sm text-slate-600">
          Audio files from recorded inbound and outbound calls on this number, newest calls first.
          Browser recordings are saved for calls lasting 90 seconds or more.
        </p>
      </header>

      {recordingsQuery.isLoading && <p className="text-sm text-slate-500">Loading recordings…</p>}
      {recordingsQuery.isError && (
        <div
          role="alert"
          className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"
        >
          <p>{recordingsQuery.error.message || 'Could not load recordings.'}</p>
          <button
            type="button"
            onClick={() =>
              void (recordingsQuery.isFetchNextPageError
                ? recordingsQuery.fetchNextPage()
                : recordingsQuery.refetch())
            }
            disabled={recordingsQuery.isFetching}
            className="mt-2 underline disabled:opacity-60"
          >
            Retry
          </button>
        </div>
      )}
      {recordingsQuery.isSuccess && recordings.length === 0 && (
        <p className="text-sm text-slate-500">No recordings yet for this number.</p>
      )}

      {recordings.length > 0 && (
        <div className="overflow-x-auto rounded border border-slate-200 bg-white">
          <table className="w-full table-auto border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th scope="col" className="px-3 py-2">
                  Audio file
                </th>
                <th scope="col" className="px-3 py-2">
                  Direction
                </th>
                <th scope="col" className="px-3 py-2">
                  Contact number
                </th>
                <th scope="col" className="px-3 py-2">
                  Started
                </th>
                <th scope="col" className="px-3 py-2">
                  Duration
                </th>
                <th scope="col" className="px-3 py-2">
                  Playback / download
                </th>
              </tr>
            </thead>
            <tbody>
              {recordings.map(({ call, recording }) => {
                const counterpart =
                  call.direction === 'OUTBOUND' ? (call.destination ?? call.to) : call.from;
                const filename = callRecordingFilename({
                  prefix: recording.source === 'voicemail' ? 'voicemail' : 'call',
                  counterpart,
                  startedAt: call.startedAt,
                  extension: recordingExtension(recording.contentType),
                });
                return (
                  <tr key={recording.id} className="border-t border-slate-100">
                    <td className="max-w-xs break-words px-3 py-3 font-mono text-xs">{filename}</td>
                    <td className="px-3 py-3">
                      {call.direction === 'OUTBOUND' ? 'Outbound' : 'Inbound'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 font-mono">
                      {formatPhone(counterpart)}
                    </td>
                    <td className="px-3 py-3">
                      {formatDate(recording.startedAt ?? call.startedAt)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">
                      {recording.durationSeconds === null
                        ? '—'
                        : `${Math.floor(recording.durationSeconds / 60)}:${String(recording.durationSeconds % 60).padStart(2, '0')}`}
                    </td>
                    <td className="px-3 py-3">
                      <RecordingAudio numberId={numberId!} call={call} recording={recording} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {recordingsQuery.hasNextPage && (
        <button
          type="button"
          onClick={() => void recordingsQuery.fetchNextPage()}
          disabled={recordingsQuery.isFetching}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-60"
        >
          {recordingsQuery.isFetchingNextPage ? 'Loading…' : 'Load older recordings'}
        </button>
      )}
    </section>
  );
}
