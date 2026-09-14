import { useEffect } from 'react';

import { useAuthStore } from '../lib/auth-store';
import { formatPhone } from '../lib/format';
import {
  dismissRecordingDownload,
  resumeRecordingDownloads,
  retryRecordingDownload,
  useRecordingDownloads,
  type RecordingDownload,
} from '../lib/recording-downloads';

const STATE_STYLES: Record<RecordingDownload['state'], string> = {
  waiting: 'border-slate-300 bg-white text-slate-900',
  downloading: 'border-slate-300 bg-white text-slate-900',
  downloaded: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  unavailable: 'border-amber-300 bg-amber-50 text-amber-900',
  failed: 'border-rose-300 bg-rose-50 text-rose-900',
};

function describeDownload(download: RecordingDownload): string {
  switch (download.state) {
    case 'waiting':
      return 'Waiting for Twilio to finish the recording…';
    case 'downloading':
      return 'Downloading…';
    case 'downloaded':
      return `Saved as ${download.filename}`;
    default:
      return download.message ?? 'The recording is unavailable.';
  }
}

// Progress of automatic call-recording downloads, shown on every page so a
// download started on the dial page is visible after navigating away.
export function RecordingDownloadTray() {
  const downloads = useRecordingDownloads();
  const { token } = useAuthStore();

  useEffect(() => {
    if (token) resumeRecordingDownloads();
  }, [token]);

  if (downloads.length === 0) return null;

  return (
    <div
      aria-label="Call recording downloads"
      className="fixed inset-x-2 bottom-2 z-40 flex flex-col gap-2 sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-80"
    >
      {downloads.map((download) => {
        const busy = download.state === 'waiting' || download.state === 'downloading';
        const canRetry = download.state === 'failed' || download.state === 'downloaded';
        return (
          <div
            key={download.outboundIntentId}
            role="status"
            className={`rounded border p-3 text-sm shadow-sm ${STATE_STYLES[download.state]}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold">
                  Recording · <span className="font-mono">{formatPhone(download.destination)}</span>
                </p>
                <p className="mt-0.5 break-words text-xs">
                  {busy && (
                    <span
                      className="mr-1.5 inline-block h-2 w-2 animate-pulse rounded-full bg-slate-400 align-middle"
                      aria-hidden="true"
                    />
                  )}
                  {describeDownload(download)}
                </p>
              </div>
              <button
                type="button"
                aria-label={busy ? 'Stop waiting for this recording' : 'Dismiss'}
                title={busy ? 'Stop waiting for this recording' : 'Dismiss'}
                onClick={() => dismissRecordingDownload(download.outboundIntentId)}
                className="shrink-0 text-xs text-slate-500 hover:text-slate-900"
              >
                ✕
              </button>
            </div>
            {canRetry && (
              <button
                type="button"
                onClick={() => retryRecordingDownload(download.outboundIntentId)}
                className="mt-2 rounded border border-current px-2 py-0.5 text-xs font-medium"
              >
                {download.state === 'downloaded' ? 'Download again' : 'Try again'}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
