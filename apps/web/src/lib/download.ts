// Saves a Blob to the user's downloads folder under `filename`.
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking right away can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

// e.g. "call-15304419961-2026-09-14_10-22-05.mp3", in the user's local time.
export function callRecordingFilename(input: {
  prefix?: string;
  counterpart: string | null | undefined;
  startedAt: string | Date;
  extension?: string;
}): string {
  const started = new Date(input.startedAt);
  const when = Number.isNaN(started.getTime())
    ? 'unknown-time'
    : `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())}_${pad(
        started.getHours(),
      )}-${pad(started.getMinutes())}-${pad(started.getSeconds())}`;
  const digits = (input.counterpart ?? '').replace(/\D/g, '');
  return `${input.prefix ?? 'call'}-${digits || 'unknown'}-${when}.${input.extension ?? 'mp3'}`;
}

// File extension for a stored recording; recordings still at Twilio are MP3.
export function recordingExtension(contentType: string | null | undefined): string {
  const type = (contentType ?? '').split(';')[0]!.trim();
  if (type === 'audio/webm') return 'webm';
  if (type === 'audio/ogg') return 'ogg';
  if (type === 'audio/mp4') return 'm4a';
  return 'mp3';
}

// How a recording was made, for labels next to it.
export function recordingSourceLabel(source: string | null | undefined): string {
  if (source === 'browser') return 'Browser';
  if (source === 'voicemail') return 'Voicemail';
  return 'Twilio';
}
