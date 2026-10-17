import type { CallDto, CallRecordingDto } from '@pstn-twilio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../lib/api-client';
import { saveBlob } from '../lib/download';
import { getSocket } from '../lib/realtime';

import { RecordingsPage } from './recordings';

vi.mock('../lib/api-client', () => ({
  api: {
    numbers: { get: vi.fn() },
    calls: { list: vi.fn(), recordingMedia: vi.fn() },
  },
}));
vi.mock('../lib/download', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/download')>()),
  saveBlob: vi.fn(),
}));
vi.mock('../lib/realtime', () => {
  const socket = { on: vi.fn(), off: vi.fn() };
  return { getSocket: () => socket };
});

function recording(id: string, overrides: Partial<CallRecordingDto> = {}): CallRecordingDto {
  return {
    id,
    twilioCallSid: 'CA1',
    twilioRecordingSid: null,
    recordingUrl: null,
    status: 'COMPLETED',
    durationSeconds: 125,
    channels: 2,
    source: 'browser',
    track: 'both',
    contentType: 'audio/webm',
    storedAt: '2026-10-15T12:03:00Z',
    startedAt: '2026-10-15T12:00:00Z',
    createdAt: '2026-10-15T12:03:00Z',
    ...overrides,
  };
}

function call(id: string, overrides: Partial<CallDto> = {}): CallDto {
  return {
    id,
    phoneNumberId: 'pn1',
    twilioCallSid: 'CA1',
    direction: 'OUTBOUND',
    from: 'client:browser',
    to: '+442045726501',
    selectedCallerId: '+447470463635',
    destination: '+442045726501',
    status: 'COMPLETED',
    durationSeconds: 125,
    startedAt: '2026-10-15T12:00:00Z',
    answeredAt: '2026-10-15T12:00:00Z',
    endedAt: '2026-10-15T12:02:05Z',
    recordings: [recording(`rec-${id}`)],
    ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/numbers/pn1/recordings']}>
        <Link to="/numbers/pn2/recordings">Switch number</Link>
        <Routes>
          <Route path="/numbers/:numberId/recordings" element={<RecordingsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.numbers.get).mockResolvedValue({
    phoneNumberE164: '+447470463635',
    friendlyName: 'Sales',
  } as Awaited<ReturnType<typeof api.numbers.get>>);
  vi.mocked(api.calls.list).mockResolvedValue({ items: [], nextCursor: null });
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:recording'),
      revokeObjectURL: vi.fn(),
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RecordingsPage', () => {
  it('lists every completed audio file for inbound and outbound calls', async () => {
    vi.mocked(api.calls.list).mockResolvedValue({
      items: [
        call('outbound', {
          recordings: [
            recording('browser'),
            recording('backup', { contentType: null, source: 'DialVerb' }),
          ],
        }),
        call('inbound', {
          direction: 'INBOUND',
          from: '+442012345678',
          recordings: [
            recording('voicemail', { source: 'voicemail', durationSeconds: 20 }),
            recording('pending', { status: 'IN_PROGRESS' }),
          ],
        }),
      ],
      nextCursor: null,
    });
    renderPage();

    expect(await screen.findAllByRole('button', { name: 'Play' })).toHaveLength(3);
    expect(screen.getAllByText('Outbound')).toHaveLength(2);
    expect(screen.getByText('Inbound')).toBeInTheDocument();
    expect(screen.getByText('+442012345678')).toBeInTheDocument();
    expect(screen.getByText('0:20')).toBeInTheDocument();
    expect(api.calls.list).toHaveBeenCalledWith('pn1', {
      limit: 50,
      hasRecordings: true,
      cursor: undefined,
    });
    expect(api.calls.recordingMedia).not.toHaveBeenCalled();
  });

  it('loads older recordings and clears the list when switching numbers', async () => {
    vi.mocked(api.calls.list)
      .mockResolvedValueOnce({ items: [call('first')], nextCursor: 'older' })
      .mockResolvedValueOnce({ items: [call('second')], nextCursor: null });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Load older recordings' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Play' })).toHaveLength(2));
    expect(api.calls.list).toHaveBeenLastCalledWith('pn1', {
      limit: 50,
      hasRecordings: true,
      cursor: 'older',
    });

    fireEvent.click(screen.getByText('Switch number'));
    expect(await screen.findByText('No recordings yet for this number.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Play' })).not.toBeInTheDocument();
    expect(api.calls.list).toHaveBeenLastCalledWith('pn2', {
      limit: 50,
      hasRecordings: true,
      cursor: undefined,
    });
  });

  it('plays and downloads authenticated media only on request', async () => {
    vi.mocked(api.calls.list).mockResolvedValue({ items: [call('first')], nextCursor: null });
    const blob = new Blob(['audio'], { type: 'audio/webm' });
    vi.mocked(api.calls.recordingMedia).mockResolvedValue(blob);
    const { container, unmount } = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Play' }));
    await waitFor(() =>
      expect(container.querySelector('audio')).toHaveAttribute('src', 'blob:recording'),
    );
    expect(api.calls.recordingMedia).toHaveBeenCalledWith('pn1', 'first', 'rec-first');
    fireEvent.click(screen.getByRole('button', { name: 'Download recording as WEBM' }));
    await waitFor(() =>
      expect(saveBlob).toHaveBeenCalledWith(
        blob,
        expect.stringMatching(/^call-442045726501-.*\.webm$/),
      ),
    );
    expect(api.calls.recordingMedia).toHaveBeenCalledTimes(1);
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:recording');
  });

  it('shows loading, then an error with retry instead of an empty list', async () => {
    vi.mocked(api.calls.list).mockRejectedValueOnce(new Error('Unable to load recordings'));
    renderPage();
    expect(screen.getByText('Loading recordings…')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load recordings');
    expect(screen.queryByText('No recordings yet for this number.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No recordings yet for this number.')).toBeInTheDocument();
  });

  it('refreshes when a recording finishes uploading for this number', async () => {
    renderPage();
    await screen.findByText('No recordings yet for this number.');
    vi.mocked(api.calls.list).mockResolvedValue({ items: [call('uploaded')], nextCursor: null });
    const handleCall = vi
      .mocked(getSocket().on)
      .mock.calls.find(([event]) => event === 'call.status.updated')![1];
    act(() => handleCall({ numberId: 'pn2', call: call('other') }));
    expect(api.calls.list).toHaveBeenCalledTimes(1);
    act(() => handleCall({ numberId: 'pn1', call: call('uploaded') }));
    expect(await screen.findByRole('button', { name: 'Play' })).toBeInTheDocument();
  });
});
