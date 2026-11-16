import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../lib/api-client';

import { VoicemailDropPage } from './voicemail-drop';

const audioMock = vi.hoisted(() => ({
  stop: vi.fn(),
  cancel: vi.fn(),
  start: vi.fn(),
  toWav: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  Link: ({ children }: { children: unknown }) => children,
}));

vi.mock('../lib/wav-audio', () => ({
  startMicRecording: (opts: unknown) => audioMock.start(opts),
  audioToWav: (blob: Blob, opts: unknown) => audioMock.toWav(blob, opts),
  blobToBase64: async () => 'UklGRg==',
}));

vi.mock('../lib/api-client', () => ({
  api: {
    voicemailDrop: {
      get: vi.fn(),
      save: vi.fn(),
      remove: vi.fn(),
      audio: vi.fn(),
    },
  },
}));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <VoicemailDropPage />
    </QueryClientProvider>,
  );
}

const SAVED = { durationMs: 23_000, updatedAt: '2026-11-16T10:00:00.000Z' };

async function recordTake() {
  fireEvent.click(screen.getByRole('button', { name: 'Record' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
}

describe('VoicemailDropPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    URL.createObjectURL = vi.fn(() => 'blob:take');
    URL.revokeObjectURL = vi.fn();
    vi.mocked(api.voicemailDrop.get).mockResolvedValue(null);
    vi.mocked(api.voicemailDrop.audio).mockResolvedValue(new Blob(['x'], { type: 'audio/wav' }));
    audioMock.start.mockResolvedValue({ stop: audioMock.stop, cancel: audioMock.cancel });
    audioMock.stop.mockResolvedValue(new Blob(['webm'], { type: 'audio/webm' }));
    audioMock.toWav.mockResolvedValue({
      blob: new Blob(['wav'], { type: 'audio/wav' }),
      durationMs: 12_400,
      peak: 0.5,
    });
  });

  it('says drops stay off until a message is recorded', async () => {
    renderPage();
    expect(await screen.findByText(/No message yet/)).toBeInTheDocument();
  });

  it('records, previews and saves a message', async () => {
    vi.mocked(api.voicemailDrop.save).mockResolvedValue({
      durationMs: 12_400,
      updatedAt: '2026-11-16T11:00:00.000Z',
    });
    renderPage();
    await screen.findByText(/No message yet/);

    await recordTake();

    expect(await screen.findByLabelText('New take')).toHaveAttribute('src', 'blob:take');
    expect(audioMock.toWav).toHaveBeenCalledWith(expect.any(Blob), { tidy: true });
    fireEvent.click(screen.getByRole('button', { name: 'Save as my message' }));

    await waitFor(() => expect(api.voicemailDrop.save).toHaveBeenCalledWith('UklGRg==', 12_400));
    expect(await screen.findByText('0:12')).toBeInTheDocument();
    expect(await screen.findByLabelText('Your voicemail message')).toBeInTheDocument();
    // The take's own audio is reused instead of downloading it again.
    expect(api.voicemailDrop.audio).not.toHaveBeenCalled();
  });

  it('shows the saved message and offers to replace it', async () => {
    vi.mocked(api.voicemailDrop.get).mockResolvedValue(SAVED);
    renderPage();

    expect(await screen.findByText('0:23')).toBeInTheDocument();
    expect(await screen.findByLabelText('Your voicemail message')).toBeInTheDocument();
    await recordTake();
    expect(await screen.findByRole('button', { name: 'Replace my message' })).toBeInTheDocument();
  });

  it('warns about a silent take', async () => {
    audioMock.toWav.mockResolvedValue({ blob: new Blob(['wav']), durationMs: 3000, peak: 0.001 });
    renderPage();
    await screen.findByText(/No message yet/);

    await recordTake();

    expect(await screen.findByText(/almost silent/)).toBeInTheDocument();
  });

  it('refuses a file longer than two minutes', async () => {
    audioMock.toWav.mockResolvedValue({ blob: new Blob(['wav']), durationMs: 150_000, peak: 0.5 });
    renderPage();
    await screen.findByText(/No message yet/);

    const file = new File(['mp3'], 'pitch.mp3', { type: 'audio/mpeg' });
    fireEvent.change(screen.getByTestId('voicemail-file'), { target: { files: [file] } });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not use pitch.mp3. It runs 2:30; the limit is 2:00.',
    );
    expect(screen.queryByLabelText('New take')).not.toBeInTheDocument();
  });

  it('explains a blocked microphone', async () => {
    audioMock.start.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    renderPage();
    await screen.findByText(/No message yet/);

    fireEvent.click(screen.getByRole('button', { name: 'Record' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Microphone access is blocked/);
    expect(screen.getByRole('button', { name: 'Record' })).toBeEnabled();
  });

  it('deletes the message after confirmation', async () => {
    vi.mocked(api.voicemailDrop.get).mockResolvedValue(SAVED);
    vi.mocked(api.voicemailDrop.remove).mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete message' }));

    await waitFor(() => expect(api.voicemailDrop.remove).toHaveBeenCalled());
    expect(await screen.findByText(/No message yet/)).toBeInTheDocument();
  });
});
