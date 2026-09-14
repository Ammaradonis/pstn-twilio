import type { CallDto, CallRecordingDto, CallStatus, WsCallEvent } from '@pstn-twilio/shared';
import { useSyncExternalStore } from 'react';

import { api, ApiError, getToken } from './api-client';
import { callRecordingFilename, saveBlob } from './download';
import { getSocket } from './realtime';

// Downloads the Twilio recording of a call placed with recording on, as soon
// as Twilio finishes processing it (usually a few seconds after hangup).
// Pending downloads are kept in localStorage so a reload does not lose them.

export type RecordingDownloadState =
  | 'waiting'
  | 'downloading'
  | 'downloaded'
  | 'unavailable'
  | 'failed';

export interface RecordingDownload {
  outboundIntentId: string;
  numberId: string;
  destination: string;
  // A call that has not reached Twilio by the time its intent expires never will.
  intentExpiresAt: string;
  createdAt: number;
  state: RecordingDownloadState;
  message: string | null;
  callId: string | null;
  recordingId: string | null;
  filename: string | null;
}

export interface WatchRecordingInput {
  outboundIntentId: string;
  numberId: string;
  destination: string;
  intentExpiresAt: string;
}

const STORAGE_KEY = 'pstn-twilio.recording-downloads';
const POLL_BEFORE_CALL_MS = 3_000;
const POLL_DURING_CALL_MS = 15_000;
const POLL_AFTER_CALL_MS = 3_000;
const ERROR_RETRY_MS = 10_000;
const INTENT_GRACE_MS = 30_000;
// Twilio only records answered calls; give its status callbacks a moment to
// report an answer before concluding there is nothing to download.
const UNANSWERED_GRACE_MS = 20_000;
const RECORDING_ARRIVAL_TIMEOUT_MS = 5 * 60_000;
const MAX_WATCH_MS = 6 * 60 * 60_000;
const DOWNLOADED_VISIBLE_MS = 20_000;
// How far a call-log entry's start may be from when its download was requested.
const CALL_LOG_MATCH_WINDOW_MS = 60_000;

const TERMINAL_CALL_STATUSES = new Set<CallStatus>([
  'COMPLETED',
  'BUSY',
  'FAILED',
  'NO_ANSWER',
  'CANCELED',
]);

const entries = new Map<string, RecordingDownload>();
const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Set<string>();
// When this tab first saw each call in a final state.
const callEndSeenAt = new Map<string, number>();
// Ids this tab wrote to or read from storage, so a missing stored entry means
// another tab already downloaded it.
const storedIds = new Set<string>();
const listeners = new Set<() => void>();

let snapshot: RecordingDownload[] = [];
let storageLoaded = false;
let listeningSocket: ReturnType<typeof getSocket> | null = null;

function emit(): void {
  snapshot = [...entries.values()].sort((a, b) => b.createdAt - a.createdAt);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): RecordingDownload[] {
  return snapshot;
}

export function useRecordingDownloads(): RecordingDownload[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

type StoredEntry = Pick<
  RecordingDownload,
  'outboundIntentId' | 'numberId' | 'destination' | 'intentExpiresAt' | 'createdAt' | 'callId'
>;

function isStoredEntry(value: unknown): value is StoredEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.outboundIntentId === 'string' &&
    typeof v.numberId === 'string' &&
    typeof v.destination === 'string' &&
    typeof v.intentExpiresAt === 'string' &&
    typeof v.createdAt === 'number' &&
    (v.callId === null || typeof v.callId === 'string')
  );
}

function readStored(): StoredEntry[] | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isStoredEntry) : [];
  } catch {
    return null;
  }
}

function writeStored(stored: StoredEntry[]): boolean {
  try {
    if (stored.length === 0) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

function toStored(entry: RecordingDownload): StoredEntry {
  const { outboundIntentId, numberId, destination, intentExpiresAt, createdAt, callId } = entry;
  return { outboundIntentId, numberId, destination, intentExpiresAt, createdAt, callId };
}

function persist(entry: RecordingDownload): void {
  const stored = readStored();
  if (!stored) return;
  const id = entry.outboundIntentId;
  // Never re-add an entry that another tab has claimed or dismissed.
  if (storedIds.has(id) && !stored.some((s) => s.outboundIntentId === id)) return;
  const others = stored.filter((s) => s.outboundIntentId !== id);
  if (writeStored([...others, toStored(entry)])) storedIds.add(id);
}

function unpersist(id: string): void {
  const stored = readStored();
  if (!stored) return;
  writeStored(stored.filter((s) => s.outboundIntentId !== id));
}

// Takes the stored entry before downloading. False when another tab already
// took it.
function claim(id: string): boolean {
  const stored = readStored();
  if (!stored) return true;
  const present = stored.some((s) => s.outboundIntentId === id);
  if (present) {
    writeStored(stored.filter((s) => s.outboundIntentId !== id));
    return true;
  }
  return !storedIds.has(id);
}

function update(id: string, patch: Partial<RecordingDownload>): RecordingDownload | null {
  const entry = entries.get(id);
  if (!entry) return null;
  const next = { ...entry, ...patch };
  entries.set(id, next);
  emit();
  return next;
}

function clearPollTimer(id: string): void {
  const timer = pollTimers.get(id);
  if (timer) clearTimeout(timer);
  pollTimers.delete(id);
}

function schedule(id: string, delayMs: number): void {
  clearPollTimer(id);
  pollTimers.set(
    id,
    setTimeout(() => {
      pollTimers.delete(id);
      void check(id);
    }, delayMs),
  );
}

function finish(
  id: string,
  state: Exclude<RecordingDownloadState, 'waiting' | 'downloading'>,
  message: string | null,
  patch: Partial<RecordingDownload> = {},
): void {
  clearPollTimer(id);
  callEndSeenAt.delete(id);
  unpersist(id);
  update(id, { ...patch, state, message });
  if (state === 'downloaded') {
    dismissTimers.set(
      id,
      setTimeout(() => dismissRecordingDownload(id), DOWNLOADED_VISIBLE_MS),
    );
  }
}

function pickRecording(call: CallDto): CallRecordingDto | null {
  const callRecordings = call.recordings.filter((r) => r.source !== 'voicemail');
  return (
    callRecordings.find((r) => r.status === 'COMPLETED') ??
    callRecordings.find((r) => r.status === 'IN_PROGRESS') ??
    callRecordings[0] ??
    null
  );
}

function onCallEvent(payload: WsCallEvent): void {
  for (const entry of entries.values()) {
    if (entry.state !== 'waiting') continue;
    const matches = entry.callId
      ? entry.callId === payload.call.id
      : entry.numberId === payload.numberId;
    if (matches) void check(entry.outboundIntentId);
  }
}

// Twilio's recording callback reaches the app over the socket, so check right
// away instead of waiting for the next poll.
function listenForCallEvents(): void {
  if (!getToken()) return;
  const socket = getSocket();
  if (listeningSocket === socket) return;
  listeningSocket = socket;
  socket.on('call.status.updated', onCallEvent);
}

async function saveRecording(
  entry: RecordingDownload,
  callId: string,
  recordingId: string,
  call: Pick<CallDto, 'destination' | 'startedAt'> | null,
): Promise<void> {
  const id = entry.outboundIntentId;
  update(id, { state: 'downloading', message: null, callId, recordingId });
  try {
    const blob = await api.calls.recordingMedia(entry.numberId, callId, recordingId);
    const filename =
      entry.filename ??
      callRecordingFilename({
        counterpart: call?.destination ?? entry.destination,
        startedAt: call?.startedAt ?? new Date(entry.createdAt),
      });
    saveBlob(blob, filename);
    finish(id, 'downloaded', null, { filename });
  } catch (err) {
    finish(
      id,
      'failed',
      err instanceof Error ? `Download failed: ${err.message}` : 'Download failed.',
    );
  }
}

// NestJS answers an unknown route with a 404 "Cannot GET ...", unlike the
// lookup's own 404 for an unknown intent.
function isMissingRoute(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404 && err.message.startsWith('Cannot GET');
}

// Finds the call in the recent call log: the outbound call to this
// destination that started closest to when the download was requested.
function matchRecentCall(calls: CallDto[], entry: RecordingDownload): CallDto | null {
  if (entry.callId) return calls.find((c) => c.id === entry.callId) ?? null;
  let best: CallDto | null = null;
  let bestGap = Infinity;
  for (const candidate of calls) {
    if (candidate.direction !== 'OUTBOUND' || candidate.destination !== entry.destination) continue;
    const gap = Math.abs(Date.parse(candidate.startedAt) - entry.createdAt);
    if (gap <= CALL_LOG_MATCH_WINDOW_MS && gap < bestGap) {
      best = candidate;
      bestGap = gap;
    }
  }
  return best;
}

async function findCall(entry: RecordingDownload): Promise<CallDto | null> {
  try {
    return await api.calls.byOutboundIntent(entry.numberId, entry.outboundIntentId);
  } catch (err) {
    // An API released before the intent lookup existed (the website and API
    // deploy separately).
    if (!isMissingRoute(err)) throw err;
    const page = await api.calls.list(entry.numberId, { limit: 25, direction: 'OUTBOUND' });
    return matchRecentCall(page.items, entry);
  }
}

async function check(id: string): Promise<void> {
  clearPollTimer(id);
  const entry = entries.get(id);
  if (!entry || entry.state !== 'waiting' || inFlight.has(id)) return;
  // Signed out: resumeRecordingDownloads() picks this up after sign-in.
  if (!getToken()) return;

  inFlight.add(id);
  try {
    listenForCallEvents();
    let call: CallDto | null;
    try {
      call = await findCall(entry);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        finish(id, 'unavailable', 'This call is no longer available.');
      } else {
        schedule(id, ERROR_RETRY_MS);
      }
      return;
    }

    const now = Date.now();
    if (!call) {
      if (now > Date.parse(entry.intentExpiresAt) + INTENT_GRACE_MS) {
        finish(id, 'unavailable', "The call didn't connect, so there is no recording.");
      } else {
        schedule(id, POLL_BEFORE_CALL_MS);
      }
      return;
    }

    if (entry.callId !== call.id) {
      const next = update(id, { callId: call.id });
      if (next) persist(next);
    }

    const recording = pickRecording(call);
    if (recording?.status === 'COMPLETED') {
      if (!claim(id)) {
        entries.delete(id);
        emit();
        return;
      }
      await saveRecording(entry, call.id, recording.id, call);
      return;
    }
    if (recording?.status === 'ABSENT') {
      finish(id, 'unavailable', 'Twilio did not capture any audio for this call.');
      return;
    }

    if (!TERMINAL_CALL_STATUSES.has(call.status)) {
      if (now - entry.createdAt > MAX_WATCH_MS) {
        finish(id, 'failed', 'Stopped waiting for this call to end.');
      } else {
        schedule(id, POLL_DURING_CALL_MS);
      }
      return;
    }

    const endSeenAt = callEndSeenAt.get(id) ?? now;
    callEndSeenAt.set(id, endSeenAt);
    const sinceEnd = now - endSeenAt;
    if (!recording && !call.answeredAt && sinceEnd >= UNANSWERED_GRACE_MS) {
      finish(id, 'unavailable', "The call wasn't answered, so there is no recording.");
    } else if (sinceEnd >= RECORDING_ARRIVAL_TIMEOUT_MS) {
      finish(
        id,
        'failed',
        'Twilio has not finished the recording yet. It will appear in the call log when ready.',
      );
    } else {
      schedule(id, POLL_AFTER_CALL_MS);
    }
  } finally {
    inFlight.delete(id);
  }
}

export function watchRecordingDownload(input: WatchRecordingInput): void {
  const existing = entries.get(input.outboundIntentId);
  if (existing) return;
  const entry: RecordingDownload = {
    ...input,
    createdAt: Date.now(),
    state: 'waiting',
    message: null,
    callId: null,
    recordingId: null,
    filename: null,
  };
  entries.set(entry.outboundIntentId, entry);
  persist(entry);
  emit();
  void check(entry.outboundIntentId);
}

// Restores downloads left pending by a previous page load and restarts any
// that stalled while signed out. Safe to call repeatedly.
export function resumeRecordingDownloads(): void {
  if (!storageLoaded) {
    storageLoaded = true;
    for (const stored of readStored() ?? []) {
      if (entries.has(stored.outboundIntentId)) continue;
      storedIds.add(stored.outboundIntentId);
      if (Date.now() - stored.createdAt > MAX_WATCH_MS) {
        unpersist(stored.outboundIntentId);
        continue;
      }
      entries.set(stored.outboundIntentId, {
        ...stored,
        state: 'waiting',
        message: null,
        recordingId: null,
        filename: null,
      });
    }
    emit();
  }
  for (const entry of entries.values()) {
    if (
      entry.state === 'waiting' &&
      !pollTimers.has(entry.outboundIntentId) &&
      !inFlight.has(entry.outboundIntentId)
    ) {
      void check(entry.outboundIntentId);
    }
  }
}

// Downloads again after a failure or a download the browser blocked.
export function retryRecordingDownload(id: string): void {
  const entry = entries.get(id);
  if (!entry || entry.state === 'waiting' || entry.state === 'downloading') return;
  const timer = dismissTimers.get(id);
  if (timer) clearTimeout(timer);
  dismissTimers.delete(id);

  if (entry.callId && entry.recordingId) {
    void saveRecording(entry, entry.callId, entry.recordingId, null);
    return;
  }
  const next = update(id, { state: 'waiting', message: null, createdAt: Date.now() });
  // A user-requested retry re-registers the download, even though it was
  // removed from storage when it gave up.
  storedIds.delete(id);
  if (next) persist(next);
  void check(id);
}

export function dismissRecordingDownload(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  clearPollTimer(id);
  const timer = dismissTimers.get(id);
  if (timer) clearTimeout(timer);
  dismissTimers.delete(id);
  callEndSeenAt.delete(id);
  unpersist(id);
  entries.delete(id);
  emit();
}

// Test hook: forget all in-memory state.
export function resetRecordingDownloadsForTests(): void {
  for (const timer of pollTimers.values()) clearTimeout(timer);
  for (const timer of dismissTimers.values()) clearTimeout(timer);
  pollTimers.clear();
  dismissTimers.clear();
  entries.clear();
  inFlight.clear();
  callEndSeenAt.clear();
  storedIds.clear();
  storageLoaded = false;
  listeningSocket = null;
  snapshot = [];
}
