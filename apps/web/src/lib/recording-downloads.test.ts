import type { CallDto, CallRecordingDto } from '@pstn-twilio/shared';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError, getToken } from './api-client';
import { saveBlob } from './download';
import {
  dismissRecordingDownload,
  resetRecordingDownloadsForTests,
  resumeRecordingDownloads,
  retryRecordingDownload,
  useRecordingDownloads,
  watchRecordingDownload,
} from './recording-downloads';

const socketHandlers = vi.hoisted(() => new Map<string, (payload: unknown) => void>());

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
    getToken: vi.fn(() => 'jwt'),
    api: {
      calls: {
        byOutboundIntent: vi.fn(),
        list: vi.fn(),
        recordingMedia: vi.fn(),
      },
    },
  };
});

vi.mock('./download', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./download')>()),
  saveBlob: vi.fn(),
}));

vi.mock('./realtime', () => ({
  getSocket: () => ({
    on: (event: string, handler: (payload: unknown) => void) => socketHandlers.set(event, handler),
  }),
}));

const STORAGE_KEY = 'pstn-twilio.recording-downloads';

function recording(overrides: Partial<CallRecordingDto> = {}): CallRecordingDto {
  return {
    id: 'rec1',
    twilioCallSid: 'CA1',
    twilioRecordingSid: 'RE1',
    recordingUrl: null,
    status: 'COMPLETED',
    durationSeconds: 12,
    channels: 2,
    source: 'DialVerb',
    track: 'both',
    startedAt: null,
    createdAt: '2026-09-14T10:22:20.000Z',
    ...overrides,
  };
}

function call(overrides: Partial<CallDto> = {}): CallDto {
  return {
    id: 'c1',
    phoneNumberId: 'pn1',
    twilioCallSid: 'CA1',
    direction: 'OUTBOUND',
    from: 'user_u1_number_pn1',
    to: '+15304419961',
    selectedCallerId: '+18776524532',
    destination: '+15304419961',
    status: 'COMPLETED',
    durationSeconds: 12,
    startedAt: new Date(2026, 8, 14, 10, 22, 5).toISOString(),
    answeredAt: new Date(2026, 8, 14, 10, 22, 7).toISOString(),
    endedAt: new Date(2026, 8, 14, 10, 22, 19).toISOString(),
    recordings: [],
    ...overrides,
  };
}

function watch() {
  watchRecordingDownload({
    outboundIntentId: 'intent1',
    numberId: 'pn1',
    destination: '+15304419961',
    intentExpiresAt: new Date(Date.now() + 120_000).toISOString(),
  });
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('recording downloads', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.removeItem(STORAGE_KEY);
    socketHandlers.clear();
    resetRecordingDownloadsForTests();
    vi.mocked(getToken).mockReturnValue('jwt');
    vi.mocked(api.calls.recordingMedia).mockResolvedValue(
      new Blob(['mp3'], { type: 'audio/mpeg' }),
    );
  });

  afterEach(() => {
    resetRecordingDownloadsForTests();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('downloads the MP3 once Twilio finishes the recording', async () => {
    const { result } = renderHook(() => useRecordingDownloads());
    vi.mocked(api.calls.byOutboundIntent)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(call({ status: 'IN_PROGRESS', endedAt: null }))
      .mockResolvedValueOnce(call({ recordings: [recording({ status: 'IN_PROGRESS' })] }))
      .mockResolvedValue(call({ recordings: [recording()] }));

    act(() => watch());
    await flush();
    expect(result.current[0]).toMatchObject({ state: 'waiting' });
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toHaveLength(1);

    await flush(3_000); // call reaches Twilio
    await flush(15_000); // call ends, recording still processing
    await flush(3_000); // recording completed

    expect(api.calls.recordingMedia).toHaveBeenCalledWith('pn1', 'c1', 'rec1');
    expect(saveBlob).toHaveBeenCalledTimes(1);
    expect(saveBlob).toHaveBeenCalledWith(
      expect.any(Blob),
      'call-15304419961-2026-09-14_10-22-05.mp3',
    );
    expect(result.current[0]).toMatchObject({
      state: 'downloaded',
      filename: 'call-15304419961-2026-09-14_10-22-05.mp3',
    });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();

    await flush(20_000);
    expect(result.current).toHaveLength(0);
  });

  it('checks immediately when the recording callback arrives over the socket', async () => {
    vi.mocked(api.calls.byOutboundIntent)
      .mockResolvedValueOnce(call({ recordings: [recording({ status: 'IN_PROGRESS' })] }))
      .mockResolvedValue(call({ recordings: [recording()] }));

    watch();
    await flush();
    expect(saveBlob).not.toHaveBeenCalled();

    await act(async () => {
      socketHandlers.get('call.status.updated')?.({ numberId: 'pn1', call: call() });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(saveBlob).toHaveBeenCalledTimes(1);
  });

  it('ignores voicemail recordings on the call', async () => {
    vi.mocked(api.calls.byOutboundIntent).mockResolvedValue(
      call({
        answeredAt: null,
        recordings: [recording({ id: 'vm1', source: 'voicemail' })],
      }),
    );
    const { result } = renderHook(() => useRecordingDownloads());

    act(() => watch());
    await flush(25_000);

    expect(saveBlob).not.toHaveBeenCalled();
    expect(result.current[0]).toMatchObject({
      state: 'unavailable',
      message: "The call wasn't answered, so there is no recording.",
    });
  });

  it('gives up when the call never reached Twilio', async () => {
    vi.mocked(api.calls.byOutboundIntent).mockResolvedValue(null);
    const { result } = renderHook(() => useRecordingDownloads());

    act(() => watch());
    await flush(140_000);
    expect(result.current[0]).toMatchObject({ state: 'waiting' });

    // Intent TTL (120s) plus the 30s grace period has passed.
    await flush(20_000);

    expect(result.current[0]).toMatchObject({
      state: 'unavailable',
      message: "The call didn't connect, so there is no recording.",
    });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('reports a failed download and retries it on request', async () => {
    vi.mocked(api.calls.byOutboundIntent).mockResolvedValue(call({ recordings: [recording()] }));
    vi.mocked(api.calls.recordingMedia).mockRejectedValueOnce(new Error('network down'));
    const { result } = renderHook(() => useRecordingDownloads());

    act(() => watch());
    await flush();
    expect(result.current[0]).toMatchObject({
      state: 'failed',
      message: 'Download failed: network down',
    });

    act(() => retryRecordingDownload('intent1'));
    await flush();

    expect(saveBlob).toHaveBeenCalledTimes(1);
    expect(result.current[0]).toMatchObject({ state: 'downloaded' });
  });

  it('finds the call in the call log when the API predates the intent lookup', async () => {
    vi.mocked(api.calls.byOutboundIntent).mockRejectedValue(
      new ApiError(404, 'Cannot GET /api/numbers/pn1/outbound-intents/intent1/call'),
    );
    const now = Date.now();
    vi.mocked(api.calls.list).mockResolvedValue({
      items: [
        // Same destination, but from an earlier call.
        call({
          id: 'old',
          startedAt: new Date(now - 10 * 60_000).toISOString(),
          recordings: [recording({ id: 'old-rec' })],
        }),
        call({ id: 'other', destination: '+15550000000', startedAt: new Date(now).toISOString() }),
        call({
          id: 'c1',
          startedAt: new Date(now + 1_500).toISOString(),
          recordings: [recording({ id: 'rec1' })],
        }),
      ],
      nextCursor: null,
    });
    const { result } = renderHook(() => useRecordingDownloads());

    act(() => watch());
    await flush();

    expect(api.calls.list).toHaveBeenCalledWith('pn1', { limit: 25, direction: 'OUTBOUND' });
    expect(api.calls.recordingMedia).toHaveBeenCalledWith('pn1', 'c1', 'rec1');
    expect(saveBlob).toHaveBeenCalledTimes(1);
    expect(result.current[0]).toMatchObject({ state: 'downloaded', callId: 'c1' });
  });

  it('stops when the call is not visible to the user', async () => {
    vi.mocked(api.calls.byOutboundIntent).mockRejectedValue(new ApiError(404, 'not found'));
    const { result } = renderHook(() => useRecordingDownloads());

    act(() => watch());
    await flush();

    expect(result.current[0]).toMatchObject({ state: 'unavailable' });
  });

  it('resumes a pending download after a page reload', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          outboundIntentId: 'intent1',
          numberId: 'pn1',
          destination: '+15304419961',
          intentExpiresAt: new Date(Date.now() - 60_000).toISOString(),
          createdAt: Date.now() - 90_000,
          callId: 'c1',
        },
      ]),
    );
    vi.mocked(api.calls.byOutboundIntent).mockResolvedValue(call({ recordings: [recording()] }));

    resumeRecordingDownloads();
    resumeRecordingDownloads();
    await flush();

    expect(api.calls.byOutboundIntent).toHaveBeenCalledTimes(1);
    expect(saveBlob).toHaveBeenCalledTimes(1);
  });

  it('skips a download another tab already took', async () => {
    vi.mocked(api.calls.byOutboundIntent).mockImplementation(async () => {
      // The other tab claims the stored entry while this request is in flight.
      window.localStorage.removeItem(STORAGE_KEY);
      return call({ recordings: [recording()] });
    });
    const { result } = renderHook(() => useRecordingDownloads());

    act(() => watch());
    await flush();

    expect(saveBlob).not.toHaveBeenCalled();
    expect(result.current).toHaveLength(0);
  });

  it('stops waiting when dismissed', async () => {
    vi.mocked(api.calls.byOutboundIntent).mockResolvedValue(null);
    const { result } = renderHook(() => useRecordingDownloads());

    act(() => watch());
    await flush();
    act(() => dismissRecordingDownload('intent1'));
    await flush(10_000);

    expect(result.current).toHaveLength(0);
    expect(api.calls.byOutboundIntent).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('waits while signed out and resumes after sign-in', async () => {
    vi.mocked(getToken).mockReturnValue(null);
    vi.mocked(api.calls.byOutboundIntent).mockResolvedValue(call({ recordings: [recording()] }));

    watch();
    await flush(10_000);
    expect(api.calls.byOutboundIntent).not.toHaveBeenCalled();

    vi.mocked(getToken).mockReturnValue('jwt');
    resumeRecordingDownloads();
    await flush();

    expect(saveBlob).toHaveBeenCalledTimes(1);
  });
});
