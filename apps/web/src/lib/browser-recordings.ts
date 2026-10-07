import fixWebmDuration from 'fix-webm-duration';
import { useSyncExternalStore } from 'react';

import { api, ApiError, getToken } from './api-client';
import { CallRecorder, recordingMimeType, type RecordableCall } from './call-recorder';
import { callRecordingFilename, saveBlob } from './download';
import {
  createMemoryRecordingStore,
  indexedDbRecordingStore,
  type RecordingStore,
  type StoredBrowserRecording,
} from './recording-store';

// Free call recording: the browser records each call it is on, from the
// moment it is answered (see CallRecorder). A call that lasted at least
// MIN_UPLOAD_SECONDS is saved to the downloads folder when it ends and
// uploaded to the call log; a shorter one is deleted everywhere (memory,
// IndexedDB, never downloaded) so cold-call hang-ups don't fill the disk.
// Uploads that fail (no network, storage not set up yet) wait in IndexedDB
// and are retried.

export type BrowserRecordingState =
  | 'recording'
  | 'saving'
  | 'uploading'
  | 'uploaded'
  // Under MIN_UPLOAD_SECONDS: deleted, never downloaded or uploaded.
  | 'discarded'
  | 'waiting'
  | 'failed';

export interface BrowserRecordingStatus {
  id: string;
  direction: 'inbound' | 'outbound';
  counterpart: string;
  startedAt: string;
  state: BrowserRecordingState;
  message: string | null;
  filename: string | null;
}

export type BrowserRecordingMeta =
  | {
      direction: 'outbound';
      counterpart: string;
      numberId: string;
      outboundIntentId: string;
    }
  | {
      direction: 'inbound';
      counterpart: string;
      /** The inbound call this browser's leg belongs to. */
      callSid: string | null;
    };

/** Shorter recordings are deleted outright (and the API refuses them too). */
export const MIN_UPLOAD_SECONDS = 90;
const UPLOAD_RETRY_MS = 60_000;
// A recording that is not finished and has had no audio for this long was
// cut off by a reload or crash (another open tab would still be adding audio).
const CUT_OFF_AFTER_MS = 60_000;
const KEEP_UNUPLOADED_MS = 14 * 24 * 60 * 60_000;
// Upload refusals that retrying cannot fix.
const PERMANENT_UPLOAD_ERRORS = new Set([400, 403, 409, 413]);
const CALL_CLOSED_POLL_MS = 2_000;
const MAX_STATUSES = 20;

interface Session {
  recorder: CallRecorder;
  chunks: Blob[];
  row: StoredBrowserRecording;
}

let store: RecordingStore =
  typeof indexedDB === 'undefined' ? createMemoryRecordingStore() : indexedDbRecordingStore;
const sessions = new Map<string, Session>();
// Finished in this tab: upload from memory even if IndexedDB lost chunks.
const finishedBlobs = new Map<string, Blob>();
const uploadsInFlight = new Set<string>();
const statuses = new Map<string, BrowserRecordingStatus>();
const listeners = new Set<() => void>();
let snapshot: BrowserRecordingStatus | null = null;
let uploading: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

export function setRecordingStoreForTests(next: RecordingStore): void {
  store = next;
  sessions.clear();
  finishedBlobs.clear();
  uploadsInFlight.clear();
  statuses.clear();
  snapshot = null;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

export function isBrowserRecordingSupported(): boolean {
  return recordingMimeType() !== null;
}

/** Status of the most recently started browser recording. */
export function useBrowserRecordingStatus(): BrowserRecordingStatus | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): BrowserRecordingStatus | null {
  return snapshot;
}

function setStatus(
  id: string,
  patch: Partial<BrowserRecordingStatus> & Pick<BrowserRecordingStatus, 'state'>,
): void {
  const previous = statuses.get(id);
  const base = previous ?? {
    id,
    direction: 'outbound' as const,
    counterpart: '',
    startedAt: new Date().toISOString(),
    message: null,
    filename: null,
  };
  statuses.set(id, { ...base, message: null, ...patch });
  const newestFirst = [...statuses.values()].sort(
    (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
  );
  for (const old of newestFirst.slice(MAX_STATUSES)) statuses.delete(old.id);
  snapshot = newestFirst[0] ?? null;
  for (const listener of listeners) listener();
}

/** One line for the call screens about a browser recording's progress. */
export function describeBrowserRecording(status: BrowserRecordingStatus): string {
  switch (status.state) {
    case 'recording':
      return 'Recording in this browser…';
    case 'saving':
      return 'Saving the recording…';
    case 'uploading':
      return status.filename
        ? `Saved as ${status.filename}. Adding it to the call log…`
        : 'Adding the recording to the call log…';
    case 'uploaded':
      return status.filename
        ? `Saved as ${status.filename} and added to the call log.`
        : 'Recording added to the call log.';
    case 'discarded':
      return `Under ${MIN_UPLOAD_SECONDS} seconds, so the recording was deleted.`;
    default:
      return status.message ?? 'The recording could not be saved.';
  }
}

/**
 * Records `call` in the browser once it is answered, until it ends. False when
 * this browser cannot record, so the caller can have Twilio record instead.
 */
export function recordCallInBrowser(call: RecordableCall, meta: BrowserRecordingMeta): boolean {
  const mimeType = recordingMimeType();
  if (!mimeType) return false;

  let started: Promise<string | null> | null = null;
  let closedPoll: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (closedPoll) clearInterval(closedPoll);
    closedPoll = null;
    void started?.then((id) => (id ? finishSession(id, call) : undefined));
  };
  call.on?.('accept', () => {
    started ??= startSession(call, meta, mimeType);
    // The SDK can close a call without emitting disconnect (see use-voice-device).
    closedPoll ??= setInterval(() => {
      if (call.status?.() === 'closed') stop();
    }, CALL_CLOSED_POLL_MS);
  });
  for (const event of ['disconnect', 'cancel', 'reject']) call.on?.(event, stop);
  return true;
}

async function startSession(
  call: RecordableCall,
  meta: BrowserRecordingMeta,
  mimeType: string,
): Promise<string | null> {
  const row: StoredBrowserRecording = {
    id: crypto.randomUUID(),
    direction: meta.direction,
    counterpart: meta.counterpart,
    numberId: meta.direction === 'outbound' ? meta.numberId : null,
    outboundIntentId: meta.direction === 'outbound' ? meta.outboundIntentId : null,
    callSid: meta.direction === 'inbound' ? meta.callSid : null,
    mimeType,
    startedAt: new Date().toISOString(),
    endedAt: null,
    updatedAt: Date.now(),
    attempts: 0,
    lastError: null,
  };
  const status = {
    direction: meta.direction,
    counterpart: meta.counterpart,
    startedAt: row.startedAt,
  };
  try {
    await store.put(row);
  } catch {
    // Still record; only recovery after a crash is lost.
  }
  const chunks: Blob[] = [];
  try {
    const recorder = new CallRecorder(call, mimeType, (seq, data) => {
      chunks.push(data);
      void store.addChunk(row.id, seq, data).catch(() => undefined);
    });
    sessions.set(row.id, { recorder, chunks, row });
  } catch (err) {
    void store.remove(row.id).catch(() => undefined);
    setStatus(row.id, {
      ...status,
      state: 'failed',
      message: `This browser could not record the call: ${errorMessage(err)}`,
    });
    return null;
  }
  setStatus(row.id, { ...status, state: 'recording' });
  return row.id;
}

async function finishSession(id: string, call: RecordableCall): Promise<void> {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  setStatus(id, { state: 'saving' });
  await session.recorder.stop();

  const endedAt = new Date();
  // An outbound call's own SID is the logged call; an answered incoming
  // call's leg is not, so keep the inbound call's SID it was given.
  const row: StoredBrowserRecording = {
    ...session.row,
    callSid: session.row.callSid ?? call.parameters?.CallSid ?? null,
    endedAt: endedAt.toISOString(),
    updatedAt: Date.now(),
  };
  if (durationSeconds(row) < MIN_UPLOAD_SECONDS) {
    session.chunks.length = 0;
    await forget(id);
    setStatus(id, { state: 'discarded' });
    return;
  }
  const blob = await assemble(session.chunks, row);
  if (blob.size === 0) {
    void store.remove(id).catch(() => undefined);
    setStatus(id, { state: 'failed', message: 'No audio was captured.' });
    return;
  }
  const filename = callRecordingFilename({
    counterpart: row.counterpart,
    startedAt: row.startedAt,
    extension: extensionFor(row.mimeType),
  });
  saveBlob(blob, filename);
  finishedBlobs.set(id, blob);
  try {
    await store.put(row);
  } catch {
    /* uploaded from memory below */
  }
  setStatus(id, { state: 'uploading', filename });
  if ((await uploadOne(row)) === 'retry') scheduleRetry();
}

/** Uploads every finished recording still waiting in this browser. */
export function uploadPendingRecordings(): Promise<void> {
  uploading ??= runUploads().finally(() => {
    uploading = null;
  });
  return uploading;
}

async function runUploads(): Promise<void> {
  if (!getToken()) return;
  let rows: StoredBrowserRecording[];
  try {
    rows = await store.list();
  } catch {
    return;
  }
  const now = Date.now();
  let retry = false;
  for (const stored of rows) {
    if (sessions.has(stored.id)) continue;
    let row = stored;
    if (!row.endedAt) {
      if (now - row.updatedAt < CUT_OFF_AFTER_MS) continue;
      // Cut off mid-call: keep what was saved up to then.
      row = { ...row, endedAt: new Date(row.updatedAt).toISOString() };
      await store.put(row).catch(() => undefined);
    }
    if (now - Date.parse(row.startedAt) > KEEP_UNUPLOADED_MS) {
      await store.remove(row.id).catch(() => undefined);
      continue;
    }
    if ((await uploadOne(row)) === 'retry') retry = true;
  }
  if (retry) scheduleRetry();
}

function scheduleRetry(): void {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void uploadPendingRecordings();
  }, UPLOAD_RETRY_MS);
}

async function uploadOne(row: StoredBrowserRecording): Promise<'done' | 'retry' | 'dropped'> {
  if (uploadsInFlight.has(row.id)) return 'done';
  uploadsInFlight.add(row.id);
  try {
    return await upload(row);
  } finally {
    uploadsInFlight.delete(row.id);
  }
}

async function upload(row: StoredBrowserRecording): Promise<'done' | 'retry' | 'dropped'> {
  if (durationSeconds(row) < MIN_UPLOAD_SECONDS) {
    await forget(row.id);
    setStatus(row.id, {
      direction: row.direction,
      counterpart: row.counterpart,
      startedAt: row.startedAt,
      filename: null,
      state: 'discarded',
    });
    return 'dropped';
  }
  const status = statuses.get(row.id);
  const show = (patch: Partial<BrowserRecordingStatus> & Pick<BrowserRecordingStatus, 'state'>) =>
    setStatus(row.id, {
      direction: row.direction,
      counterpart: row.counterpart,
      startedAt: row.startedAt,
      filename: status?.filename ?? null,
      ...patch,
    });

  const callSid = row.callSid ?? (await lookUpCallSid(row));
  const blob = finishedBlobs.get(row.id) ?? (await assemble(await store.chunks(row.id), row));
  if (blob.size === 0) {
    await forget(row.id);
    return 'dropped';
  }
  if (!callSid) {
    show({ state: 'waiting', message: 'Waiting for the call to reach the call log.' });
    return 'retry';
  }

  show({ state: 'uploading' });
  try {
    await api.recordings.uploadBrowser(
      {
        uploadId: row.id,
        callSid,
        startedAt: row.startedAt,
        durationSeconds: durationSeconds(row),
      },
      blob,
    );
  } catch (err) {
    if (err instanceof ApiError && PERMANENT_UPLOAD_ERRORS.has(err.status)) {
      await forget(row.id);
      show({ state: 'failed', message: `Not added to the call log: ${err.message}` });
      return 'dropped';
    }
    await store
      .put({ ...row, callSid, attempts: row.attempts + 1, lastError: errorMessage(err) })
      .catch(() => undefined);
    show({
      state: 'waiting',
      message:
        err instanceof ApiError && err.status === 503
          ? 'Kept in this browser; it uploads once recording storage is set up.'
          : 'Upload failed; it will retry automatically.',
    });
    return 'retry';
  }
  await forget(row.id);
  show({ state: 'uploaded', message: null });
  return 'done';
}

async function forget(id: string): Promise<void> {
  finishedBlobs.delete(id);
  await store.remove(id).catch(() => undefined);
}

async function lookUpCallSid(row: StoredBrowserRecording): Promise<string | null> {
  if (!row.numberId || !row.outboundIntentId) return null;
  try {
    const call = await api.calls.byOutboundIntent(row.numberId, row.outboundIntentId);
    return call?.twilioCallSid ?? null;
  } catch {
    return null;
  }
}

function durationSeconds(row: StoredBrowserRecording): number {
  const end = row.endedAt ? Date.parse(row.endedAt) : row.updatedAt;
  return Math.max(0, Math.round((end - Date.parse(row.startedAt)) / 1000));
}

// MediaRecorder's WebM has no duration in its header, so players cannot seek
// it; write the duration in.
async function assemble(chunks: Blob[], row: StoredBrowserRecording): Promise<Blob> {
  const blob = new Blob(chunks, { type: baseType(row.mimeType) });
  if (blob.size === 0 || !row.mimeType.startsWith('audio/webm')) return blob;
  try {
    return await fixWebmDuration(blob, durationSeconds(row) * 1000, { logger: false });
  } catch {
    return blob;
  }
}

function baseType(mimeType: string): string {
  return mimeType.split(';')[0]!.trim();
}

function extensionFor(mimeType: string): string {
  const type = baseType(mimeType);
  if (type === 'audio/ogg') return 'ogg';
  if (type === 'audio/mp4') return 'm4a';
  return 'webm';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => void uploadPendingRecordings());
}
