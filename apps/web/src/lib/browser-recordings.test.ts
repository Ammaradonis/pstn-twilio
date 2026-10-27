import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError } from './api-client';
import {
  describeBrowserRecording,
  isUploadSkipped,
  recordCallInBrowser,
  setRecordingStoreForTests,
  setUploadSkipped,
  uploadPendingRecordings,
  useBrowserRecordingStatus,
} from './browser-recordings';
import { saveBlob } from './download';
import { createMemoryRecordingStore, type RecordingStore } from './recording-store';

const CALL_SID = 'CA0123456789abcdef0123456789abcdef';

const recorderMock = vi.hoisted(() => ({
  supported: true,
  instances: [] as Array<{ onChunk: (seq: number, data: Blob) => void; stop: () => Promise<void> }>,
}));

vi.mock('./call-recorder', () => ({
  recordingMimeType: () => (recorderMock.supported ? 'audio/webm;codecs=opus' : null),
  CallRecorder: class {
    readonly stop = vi.fn(async () => undefined);
    constructor(_call: unknown, _mimeType: string, onChunk: (seq: number, data: Blob) => void) {
      recorderMock.instances.push({ onChunk, stop: this.stop });
    }
  },
}));

vi.mock('fix-webm-duration', () => ({ default: vi.fn(async (blob: Blob) => blob) }));

vi.mock('./download', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./download')>()),
  saveBlob: vi.fn(),
}));

vi.mock('./api-client', () => {
  class MockApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    ApiError: MockApiError,
    getToken: () => 'token',
    api: {
      calls: { byOutboundIntent: vi.fn() },
      recordings: { uploadBrowser: vi.fn() },
    },
  };
});

// jsdom's Blob has no text().
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

const META = {
  direction: 'outbound' as const,
  counterpart: '+12547024877',
  numberId: 'pn1',
  outboundIntentId: 'intent1',
};

function fakeCall(callSid: string | undefined = CALL_SID) {
  const handlers = new Map<string, Array<() => void>>();
  return {
    parameters: callSid ? { CallSid: callSid } : {},
    status: () => 'open',
    on: (event: string, handler: () => void) =>
      handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    emit: (event: string) => handlers.get(event)?.forEach((handler) => handler()),
  };
}

let store: RecordingStore;

beforeEach(() => {
  store = createMemoryRecordingStore();
  setRecordingStoreForTests(store);
  recorderMock.supported = true;
  recorderMock.instances = [];
  vi.mocked(saveBlob).mockClear();
  vi.mocked(api.recordings.uploadBrowser).mockReset();
  vi.mocked(api.calls.byOutboundIntent).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

// Only the clock is faked, so a call can last minutes in an instant.
function talkFor(seconds: number) {
  vi.setSystemTime(Date.now() + seconds * 1000);
}

// The status the call screens show, read without staying mounted.
function latestStatus() {
  const { result, unmount } = renderHook(() => useBrowserRecordingStatus());
  unmount();
  return result.current;
}

describe('recordCallInBrowser', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  it('reports that it cannot record when the browser has no recorder', () => {
    recorderMock.supported = false;
    expect(recordCallInBrowser(fakeCall(), META)).toBe(false);
  });

  it('records from answer to hangup and uploads without a local download', async () => {
    vi.mocked(api.recordings.uploadBrowser).mockResolvedValue({} as never);
    const call = fakeCall();

    expect(recordCallInBrowser(call, META)).toBe(true);
    expect(recorderMock.instances).toHaveLength(0);

    call.emit('accept');
    await vi.waitFor(() => expect(recorderMock.instances).toHaveLength(1));
    recorderMock.instances[0]!.onChunk(0, new Blob(['opus-1'], { type: 'audio/webm' }));
    recorderMock.instances[0]!.onChunk(1, new Blob(['opus-2'], { type: 'audio/webm' }));

    talkFor(120);
    call.emit('disconnect');

    await vi.waitFor(() => expect(api.recordings.uploadBrowser).toHaveBeenCalledTimes(1));
    expect(recorderMock.instances[0]!.stop).toHaveBeenCalled();
    const [input, blob] = vi.mocked(api.recordings.uploadBrowser).mock.calls[0]!;
    expect(input).toMatchObject({ callSid: CALL_SID, durationSeconds: expect.any(Number) });
    expect(input.uploadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await blobText(blob)).toBe('opus-1opus-2');
    expect(saveBlob).not.toHaveBeenCalled();
    // Uploaded, so nothing is left waiting in the browser.
    await vi.waitFor(async () => expect(await store.list()).toEqual([]));
  });

  it('files an answered incoming call under the inbound call, not its own leg', async () => {
    vi.mocked(api.recordings.uploadBrowser).mockResolvedValue({} as never);
    const PARENT_SID = 'CA' + 'b'.repeat(32);
    const call = fakeCall('CA' + 'c'.repeat(32));

    recordCallInBrowser(call, {
      direction: 'inbound',
      counterpart: '+15551234567',
      callSid: PARENT_SID,
    });
    call.emit('accept');
    await vi.waitFor(() => expect(recorderMock.instances).toHaveLength(1));
    recorderMock.instances[0]!.onChunk(0, new Blob(['opus'], { type: 'audio/webm' }));
    talkFor(120);
    call.emit('disconnect');

    await vi.waitFor(() => expect(api.recordings.uploadBrowser).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.recordings.uploadBrowser).mock.calls[0]![0]).toMatchObject({
      callSid: PARENT_SID,
    });
    expect(saveBlob).not.toHaveBeenCalled();
    expect(api.calls.byOutboundIntent).not.toHaveBeenCalled();
  });

  it('deletes a call under 90 seconds outright: no download, no upload, nothing stored', async () => {
    const addChunk = vi.spyOn(store, 'addChunk');
    const call = fakeCall();
    recordCallInBrowser(call, META);
    call.emit('accept');
    await vi.waitFor(() => expect(recorderMock.instances).toHaveLength(1));
    recorderMock.instances[0]!.onChunk(0, new Blob(['opus'], { type: 'audio/webm' }));
    await vi.waitFor(() => expect(addChunk).toHaveBeenCalled());
    const recordingId = addChunk.mock.calls[0]![0];
    talkFor(89);
    call.emit('disconnect');

    await vi.waitFor(() => expect(recorderMock.instances[0]!.stop).toHaveBeenCalled());
    await vi.waitFor(async () => expect(await store.list()).toEqual([]));
    expect(await store.chunks(recordingId)).toEqual([]);
    expect(saveBlob).not.toHaveBeenCalled();
    expect(api.recordings.uploadBrowser).not.toHaveBeenCalled();
  });

  it('deletes a long call instead of uploading it when No R2 is switched on mid-call', async () => {
    const call = fakeCall();
    recordCallInBrowser(call, META);
    call.emit('accept');
    await vi.waitFor(() => expect(recorderMock.instances).toHaveLength(1));
    recorderMock.instances[0]!.onChunk(0, new Blob(['voicemail'], { type: 'audio/webm' }));
    talkFor(60);
    setUploadSkipped(true);
    expect(isUploadSkipped()).toBe(true);
    talkFor(120);
    call.emit('disconnect');
    // Once the call is over, its setting is final.
    setUploadSkipped(false);

    await vi.waitFor(() => expect(latestStatus()?.state).toBe('discarded'));
    expect(describeBrowserRecording(latestStatus()!)).toBe(
      'No R2 was on, so the recording was deleted.',
    );
    expect(await store.list()).toEqual([]);
    expect(api.recordings.uploadBrowser).not.toHaveBeenCalled();
    expect(saveBlob).not.toHaveBeenCalled();
    expect(isUploadSkipped()).toBe(false);
  });

  it('uploads the call as usual when No R2 is switched off again before it ends', async () => {
    vi.mocked(api.recordings.uploadBrowser).mockResolvedValue({} as never);
    const call = fakeCall();
    recordCallInBrowser(call, META);
    call.emit('accept');
    await vi.waitFor(() => expect(recorderMock.instances).toHaveLength(1));
    recorderMock.instances[0]!.onChunk(0, new Blob(['opus'], { type: 'audio/webm' }));
    setUploadSkipped(true);
    talkFor(120);
    setUploadSkipped(false);
    call.emit('disconnect');

    await vi.waitFor(() => expect(api.recordings.uploadBrowser).toHaveBeenCalledTimes(1));
  });

  it('applies No R2 switched on while the call rings, and only to that call', async () => {
    vi.mocked(api.recordings.uploadBrowser).mockResolvedValue({} as never);
    const voicemail = fakeCall();
    recordCallInBrowser(voicemail, META);
    setUploadSkipped(true);
    voicemail.emit('accept');
    await vi.waitFor(() => expect(recorderMock.instances).toHaveLength(1));
    recorderMock.instances[0]!.onChunk(0, new Blob(['voicemail'], { type: 'audio/webm' }));
    talkFor(120);
    voicemail.emit('disconnect');
    await vi.waitFor(() => expect(latestStatus()?.state).toBe('discarded'));

    const next = fakeCall();
    recordCallInBrowser(next, META);
    expect(isUploadSkipped()).toBe(false);
    next.emit('accept');
    await vi.waitFor(() => expect(recorderMock.instances).toHaveLength(2));
    recorderMock.instances[1]!.onChunk(0, new Blob(['conversation'], { type: 'audio/webm' }));
    talkFor(120);
    next.emit('disconnect');

    await vi.waitFor(() => expect(api.recordings.uploadBrowser).toHaveBeenCalledTimes(1));
    const [, blob] = vi.mocked(api.recordings.uploadBrowser).mock.calls[0]!;
    expect(await blobText(blob)).toBe('conversation');
  });

  it('saves No R2 with the recording, so a tab that dies mid-call cannot upload it later', async () => {
    vi.mocked(api.recordings.uploadBrowser).mockResolvedValue({} as never);
    const addChunk = vi.spyOn(store, 'addChunk');
    const call = fakeCall();
    recordCallInBrowser(call, META);
    call.emit('accept');
    await vi.waitFor(() => expect(recorderMock.instances).toHaveLength(1));
    recorderMock.instances[0]!.onChunk(0, new Blob(['voicemail'], { type: 'audio/webm' }));
    await vi.waitFor(() => expect(addChunk).toHaveBeenCalled());
    talkFor(120);
    const switchedAt = Date.now();
    setUploadSkipped(true);

    // A fresh updatedAt, or another tab would take the live call for one cut off.
    await vi.waitFor(async () => {
      const [row] = await store.list();
      expect(row).toMatchObject({ skipUpload: true, endedAt: null });
      expect(row!.updatedAt).toBeGreaterThanOrEqual(switchedAt);
    });

    // The tab dies mid-call, and a reload finds the recording later.
    setRecordingStoreForTests(store);
    talkFor(5 * 60);
    await uploadPendingRecordings();

    expect(api.recordings.uploadBrowser).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([]);
  });

  it('does not record a call that is never answered', async () => {
    const call = fakeCall();
    recordCallInBrowser(call, META);

    call.emit('cancel');
    await Promise.resolve();

    expect(recorderMock.instances).toHaveLength(0);
    expect(api.recordings.uploadBrowser).not.toHaveBeenCalled();
  });

  it('keeps the recording for later while storage is not set up', async () => {
    vi.mocked(api.recordings.uploadBrowser).mockRejectedValue(
      new ApiError(503, 'Recording storage is not set up yet.'),
    );
    const call = fakeCall();
    recordCallInBrowser(call, META);
    call.emit('accept');
    await vi.waitFor(() => expect(recorderMock.instances).toHaveLength(1));
    recorderMock.instances[0]!.onChunk(0, new Blob(['opus'], { type: 'audio/webm' }));
    talkFor(120);
    call.emit('disconnect');

    await vi.waitFor(async () => {
      const [row] = await store.list();
      expect(row).toMatchObject({ callSid: CALL_SID, attempts: 1 });
      expect(row!.endedAt).not.toBeNull();
    });
    expect(saveBlob).not.toHaveBeenCalled();
  });

  it('drops an upload the API refuses for good', async () => {
    vi.mocked(api.recordings.uploadBrowser).mockRejectedValue(
      new ApiError(403, 'You do not own this call.'),
    );
    const call = fakeCall();
    recordCallInBrowser(call, META);
    call.emit('accept');
    await vi.waitFor(() => expect(recorderMock.instances).toHaveLength(1));
    recorderMock.instances[0]!.onChunk(0, new Blob(['opus'], { type: 'audio/webm' }));
    talkFor(120);
    call.emit('disconnect');

    await vi.waitFor(() => expect(api.recordings.uploadBrowser).toHaveBeenCalled());
    await vi.waitFor(async () => expect(await store.list()).toEqual([]));
  });
});

describe('uploadPendingRecordings', () => {
  const base = {
    id: '6f1c2a8e-4b7d-4c3e-9a51-2f0d8b7e6c4a',
    direction: 'outbound' as const,
    counterpart: '+12547024877',
    numberId: 'pn1',
    outboundIntentId: 'intent1',
    callSid: null,
    mimeType: 'audio/webm;codecs=opus',
    startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    attempts: 0,
    lastError: null,
  };

  it('finishes a recording cut off by a crash, finding its call by the intent', async () => {
    vi.mocked(api.calls.byOutboundIntent).mockResolvedValue({ twilioCallSid: CALL_SID } as never);
    vi.mocked(api.recordings.uploadBrowser).mockResolvedValue({} as never);
    await store.put({ ...base, endedAt: null, updatedAt: Date.now() - 2 * 60_000 });
    await store.addChunk(base.id, 0, new Blob(['saved-before-crash']));
    // addChunk refreshes updatedAt; make the recording look abandoned again.
    const row = (await store.get(base.id))!;
    await store.put({ ...row, updatedAt: Date.now() - 2 * 60_000 });

    await uploadPendingRecordings();

    expect(api.calls.byOutboundIntent).toHaveBeenCalledWith('pn1', 'intent1');
    const [input, blob] = vi.mocked(api.recordings.uploadBrowser).mock.calls[0]!;
    expect(input).toMatchObject({ uploadId: base.id, callSid: CALL_SID });
    expect(await blobText(blob)).toBe('saved-before-crash');
    expect(await store.list()).toEqual([]);
    expect(saveBlob).not.toHaveBeenCalled();
  });

  it('leaves alone a recording another tab is still making', async () => {
    await store.put({ ...base, endedAt: null, updatedAt: Date.now() });
    await store.addChunk(base.id, 0, new Blob(['live']));

    await uploadPendingRecordings();

    expect(api.recordings.uploadBrowser).not.toHaveBeenCalled();
    expect(await store.list()).toHaveLength(1);
  });

  it('discards recordings that could not be uploaded for two weeks', async () => {
    await store.put({
      ...base,
      startedAt: new Date(Date.now() - 15 * 24 * 60 * 60_000).toISOString(),
      endedAt: new Date().toISOString(),
      updatedAt: Date.now(),
    });

    await uploadPendingRecordings();

    expect(api.recordings.uploadBrowser).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([]);
  });
});
