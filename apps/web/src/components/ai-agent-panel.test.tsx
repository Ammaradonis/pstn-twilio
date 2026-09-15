import type { AiCallDto, AiCallingConfigDto } from '@pstn-twilio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../lib/api-client';
import { saveBlob } from '../lib/download';

import { AiAgentPanel } from './ai-agent-panel';

const socketHandlers = vi.hoisted(() => new Map<string, (payload: unknown) => void>());

vi.mock('../lib/api-client', () => ({
  api: {
    aiCalls: {
      config: vi.fn(),
      list: vi.fn(),
      start: vi.fn(),
      pressKeys: vi.fn(),
      queue: vi.fn(),
      removeFromQueue: vi.fn(),
      clearQueue: vi.fn(),
      recording: vi.fn(),
    },
  },
}));

vi.mock('../lib/download', () => ({ saveBlob: vi.fn() }));

vi.mock('../lib/realtime', () => ({
  getSocket: () => ({
    on: (event: string, handler: (payload: unknown) => void) => socketHandlers.set(event, handler),
    off: vi.fn(),
  }),
}));

const readyConfig: AiCallingConfigDto = {
  ready: true,
  missing: [],
  callerNumber: '+16672206726',
  defaultStateCode: 'AL',
  consultMinutes: 20,
  calendar: { connected: true, email: 'host@example.com' },
};

function aiCall(overrides: Partial<AiCallDto> = {}): AiCallDto {
  return {
    id: 'ai1',
    direction: 'OUTBOUND',
    vapiCallId: 'call_1',
    customerNumber: '+12055550100',
    stateCode: 'AL',
    timeZone: 'America/Chicago',
    status: 'QUEUED',
    outcome: null,
    endedReason: null,
    summary: null,
    schoolName: null,
    contactName: null,
    contactEmail: null,
    consultStartAt: null,
    consultMeetUrl: null,
    callbackTime: null,
    hasRecording: false,
    startedAt: null,
    endedAt: null,
    createdAt: '2026-09-14T18:33:00.000Z',
    ...overrides,
  };
}

function renderPanel(destination: string | null = '+12055550100') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AiAgentPanel destination={destination} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AiAgentPanel', () => {
  beforeEach(() => {
    // Monday 1:33 PM in Alabama.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-14T18:33:00Z'));
    window.localStorage.removeItem('pstn-twilio.ai-target-state');
    socketHandlers.clear();
    vi.mocked(api.aiCalls.config).mockResolvedValue(readyConfig);
    vi.mocked(api.aiCalls.list).mockResolvedValue([]);
    vi.mocked(api.aiCalls.start).mockResolvedValue(aiCall());
    vi.mocked(api.aiCalls.queue).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('calls the dialed number in Alabama by default and shows the local time', async () => {
    renderPanel();

    const button = await screen.findByRole('button', { name: 'Call with AI agent' });
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.getByLabelText('Target state')).toHaveValue('AL');
    expect(screen.getByText(/It.s 1:33 PM in Alabama \(Central Time\)\./)).toBeInTheDocument();
    expect(screen.getByText('+1 (667) 220-6726')).toBeInTheDocument();
    expect(screen.queryByLabelText('Time zone')).not.toBeInTheDocument();

    fireEvent.click(button);

    await waitFor(() =>
      expect(api.aiCalls.start).toHaveBeenCalledWith({
        destinationNumber: '+12055550100',
        stateCode: 'AL',
      }),
    );
    expect(await screen.findByText('Queued')).toBeInTheDocument();
  });

  it('remembers the target state and asks for the zone in split states', async () => {
    renderPanel('+16155550100');
    await screen.findByRole('button', { name: 'Call with AI agent' });

    fireEvent.change(screen.getByLabelText('Target state'), { target: { value: 'TN' } });
    expect(window.localStorage.getItem('pstn-twilio.ai-target-state')).toBe('TN');
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'America/New_York' } });
    expect(screen.getByText(/2:33 PM in Tennessee \(Eastern Time\)/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Call with AI agent' }));
    await waitFor(() =>
      expect(api.aiCalls.start).toHaveBeenCalledWith({
        destinationNumber: '+16155550100',
        stateCode: 'TN',
        timeZone: 'America/New_York',
      }),
    );
  });

  it('blocks calls outside 8 AM to 9 PM in the target state', async () => {
    vi.setSystemTime(new Date('2026-09-15T02:40:00Z')); // 9:40 PM Central
    renderPanel();

    const button = await screen.findByRole('button', { name: 'Call with AI agent' });
    expect(button).toBeDisabled();
    expect(screen.getByText(/only calls between 8 AM and 9 PM local time/)).toBeInTheDocument();
  });

  it('lists setup steps and stays disabled until setup is complete', async () => {
    vi.mocked(api.aiCalls.config).mockResolvedValue({
      ...readyConfig,
      ready: false,
      missing: ['Connect your Google Calendar in Settings.'],
      calendar: { connected: false, email: null },
    });
    renderPanel();

    expect(
      await screen.findByText('Connect your Google Calendar in Settings.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Call with AI agent' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Open Settings' })).toHaveAttribute(
      'href',
      '/settings',
    );
  });

  it('asks for confirmation before calling a number the agent already called', async () => {
    vi.mocked(api.aiCalls.list).mockResolvedValue([
      aiCall({ outcome: 'no_answer', status: 'ENDED' }),
    ]);
    renderPanel();

    const button = await screen.findByRole('button', { name: 'Call with AI agent' });
    await screen.findByText('No answer');
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(api.aiCalls.start).not.toHaveBeenCalled();
    expect(screen.getByText(/already called/)).toHaveTextContent('+1 (205) 555-0100');

    fireEvent.click(screen.getByRole('button', { name: 'Call anyway' }));
    await waitFor(() => expect(api.aiCalls.start).toHaveBeenCalledTimes(1));
  });

  describe('Paste', () => {
    function mockClipboard(readText: () => Promise<string>) {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { readText: vi.fn(readText) },
      });
    }

    it('calls the clipboard number with the agent, without a number in the dialer', async () => {
      mockClipboard(async () => 'Tiger Karate: (334) 555-0142');
      renderPanel(null);

      const paste = await screen.findByRole('button', { name: 'Paste and call with AI agent' });
      expect(screen.getByRole('button', { name: 'Call with AI agent' })).toBeDisabled();
      await waitFor(() => expect(paste).toBeEnabled());
      fireEvent.click(paste);

      await waitFor(() =>
        expect(api.aiCalls.start).toHaveBeenCalledWith({
          destinationNumber: '+13345550142',
          stateCode: 'AL',
        }),
      );
    });

    it('uses the pasted number, not the one typed in the manual dialer', async () => {
      mockClipboard(async () => '334-555-0142');
      renderPanel('+12055550100');

      const paste = await screen.findByRole('button', { name: 'Paste and call with AI agent' });
      await waitFor(() => expect(paste).toBeEnabled());
      fireEvent.click(paste);

      await waitFor(() =>
        expect(api.aiCalls.start).toHaveBeenCalledWith(
          expect.objectContaining({ destinationNumber: '+13345550142' }),
        ),
      );
    });

    it('explains clipboard problems instead of calling', async () => {
      mockClipboard(async () => 'no number here');
      renderPanel(null);

      const paste = await screen.findByRole('button', { name: 'Paste and call with AI agent' });
      await waitFor(() => expect(paste).toBeEnabled());
      fireEvent.click(paste);
      expect(
        await screen.findByText('Clipboard does not contain a dialable phone number.'),
      ).toBeInTheDocument();

      mockClipboard(async () => {
        throw new Error('Read permission denied.');
      });
      fireEvent.click(paste);
      expect(await screen.findByText('Read permission denied.')).toBeInTheDocument();
      expect(api.aiCalls.start).not.toHaveBeenCalled();
    });

    it('asks before calling a pasted number the agent already called', async () => {
      mockClipboard(async () => '+12055550100');
      vi.mocked(api.aiCalls.list).mockResolvedValue([
        aiCall({ outcome: 'voicemail', status: 'ENDED' }),
      ]);
      renderPanel(null);

      await screen.findByText('Voicemail');
      const paste = screen.getByRole('button', { name: 'Paste and call with AI agent' });
      await waitFor(() => expect(paste).toBeEnabled());
      fireEvent.click(paste);

      expect(await screen.findByText(/already called/)).toHaveTextContent('+1 (205) 555-0100');
      expect(api.aiCalls.start).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Call anyway' }));
      await waitFor(() =>
        expect(api.aiCalls.start).toHaveBeenCalledWith(
          expect.objectContaining({ destinationNumber: '+12055550100' }),
        ),
      );
    });

    it('is disabled outside the calling window', async () => {
      vi.setSystemTime(new Date('2026-09-15T02:40:00Z')); // 9:40 PM Central
      renderPanel(null);
      expect(
        await screen.findByRole('button', { name: 'Paste and call with AI agent' }),
      ).toBeDisabled();
    });
  });

  it('shows server errors from starting a call', async () => {
    vi.mocked(api.aiCalls.start).mockRejectedValue(
      new Error('This number asked not to be called again.'),
    );
    renderPanel();

    const button = await screen.findByRole('button', { name: 'Call with AI agent' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(
      await screen.findByText('This number asked not to be called again.'),
    ).toBeInTheDocument();
  });

  it('lets you press keys for the agent on a live call only', async () => {
    vi.mocked(api.aiCalls.pressKeys).mockResolvedValue({ sent: true });
    vi.mocked(api.aiCalls.list).mockResolvedValue([
      aiCall({ id: 'live', status: 'IN_PROGRESS' }),
      aiCall({ id: 'done', status: 'ENDED', outcome: 'voicemail', customerNumber: '+12055550111' }),
    ]);
    renderPanel(null);

    const toggles = await screen.findAllByRole('button', { name: 'Keypad' });
    expect(toggles).toHaveLength(1);
    fireEvent.click(toggles[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Send 1' }));

    await waitFor(() => expect(api.aiCalls.pressKeys).toHaveBeenCalledWith('live', '1'));
  });

  it('shows why a keypress could not be relayed', async () => {
    vi.mocked(api.aiCalls.pressKeys).mockRejectedValue(new Error('This AI call is not live.'));
    vi.mocked(api.aiCalls.list).mockResolvedValue([aiCall({ status: 'RINGING' })]);
    renderPanel(null);

    fireEvent.click(await screen.findByRole('button', { name: 'Keypad' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send #' }));
    expect(await screen.findByText('This AI call is not live.')).toBeInTheDocument();
  });

  describe('queue', () => {
    const waitingCall = (i: number) =>
      aiCall({
        id: `w${i}`,
        status: 'WAITING',
        customerNumber: `+1334555${String(i).padStart(4, '0')}`,
      });

    it('tells you a pasted school joined the queue while the agent is busy', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { readText: vi.fn(async () => '(334) 555-0002') },
      });
      vi.mocked(api.aiCalls.list).mockResolvedValue([aiCall({ status: 'IN_PROGRESS' })]);
      vi.mocked(api.aiCalls.start).mockResolvedValue(waitingCall(2));
      vi.mocked(api.aiCalls.queue)
        .mockResolvedValueOnce([waitingCall(1)])
        .mockResolvedValue([waitingCall(1), waitingCall(2)]);
      renderPanel(null);

      const paste = await screen.findByRole('button', { name: 'Paste and call with AI agent' });
      await waitFor(() => expect(paste).toBeEnabled());
      fireEvent.click(paste);

      expect(
        await screen.findByText('The agent is on a call. +1 (334) 555-0002 is #2 in the queue.'),
      ).toBeInTheDocument();
      expect(await screen.findByText('Queue · 2 of 100 waiting')).toBeInTheDocument();
      // Queued schools aren't listed with the finished and live calls.
      expect(screen.getAllByText('+1 (334) 555-0002')).toHaveLength(1);
    });

    it('removes a school, clears the queue, and shows all past the first five', async () => {
      const seven = Array.from({ length: 7 }, (_, i) => waitingCall(i + 1));
      vi.mocked(api.aiCalls.queue).mockResolvedValue(seven);
      vi.mocked(api.aiCalls.removeFromQueue).mockResolvedValue(undefined);
      vi.mocked(api.aiCalls.clearQueue).mockResolvedValue({ removed: 6 });
      renderPanel(null);

      expect(await screen.findByText('Queue · 7 of 100 waiting')).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: /from the queue/ })).toHaveLength(5);
      fireEvent.click(screen.getByRole('button', { name: 'Show all 7' }));
      expect(screen.getAllByRole('button', { name: /from the queue/ })).toHaveLength(7);

      fireEvent.click(
        screen.getByRole('button', { name: 'Remove +1 (334) 555-0003 from the queue' }),
      );
      await waitFor(() => expect(api.aiCalls.removeFromQueue).toHaveBeenCalledWith('w3'));

      fireEvent.click(screen.getByRole('button', { name: 'Clear queue' }));
      await waitFor(() => expect(api.aiCalls.clearQueue).toHaveBeenCalled());
      expect(vi.mocked(api.aiCalls.queue).mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('recordings', () => {
    it('plays and downloads the recording as MP3 through the API, not a storage link', async () => {
      const mp3 = new Blob(['mp3'], { type: 'audio/mpeg' });
      vi.mocked(api.aiCalls.recording).mockResolvedValue(mp3);
      const createObjectURL = vi.fn(() => 'blob:recording');
      Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
      vi.mocked(api.aiCalls.list).mockResolvedValue([
        aiCall({
          status: 'ENDED',
          outcome: 'gatekeeper',
          hasRecording: true,
          startedAt: '2026-09-14T18:40:00.000Z',
        }),
      ]);
      renderPanel(null);

      expect(screen.queryByRole('link', { name: /recording/i })).not.toBeInTheDocument();
      fireEvent.click(await screen.findByRole('button', { name: 'Download MP3' }));
      await waitFor(() =>
        expect(saveBlob).toHaveBeenCalledWith(mp3, 'ai-call-12055550100-2026-09-14.mp3'),
      );

      fireEvent.click(screen.getByRole('button', { name: 'Play recording' }));
      await waitFor(() => expect(createObjectURL).toHaveBeenCalledWith(mp3));
      expect(document.querySelector('audio')).toHaveAttribute('src', 'blob:recording');
      // Fetched once, reused for both.
      expect(api.aiCalls.recording).toHaveBeenCalledTimes(1);
    });

    it('shows why a recording could not load', async () => {
      vi.mocked(api.aiCalls.recording).mockRejectedValue(new Error('No recording for this call.'));
      vi.mocked(api.aiCalls.list).mockResolvedValue([
        aiCall({ status: 'ENDED', outcome: 'voicemail', hasRecording: true }),
      ]);
      renderPanel(null);

      fireEvent.click(await screen.findByRole('button', { name: 'Play recording' }));
      expect(await screen.findByText('No recording for this call.')).toBeInTheDocument();
    });
  });

  it('updates live from realtime events, including a booked consultation', async () => {
    vi.mocked(api.aiCalls.list).mockResolvedValue([aiCall({ status: 'IN_PROGRESS' })]);
    renderPanel(null);
    expect(await screen.findByText('On the call')).toBeInTheDocument();

    act(() => {
      socketHandlers.get('ai-call.updated')?.({
        aiCall: aiCall({
          status: 'ENDED',
          outcome: 'booked',
          schoolName: 'Tiger Karate',
          contactName: 'Mike Johnson',
          consultStartAt: '2026-09-15T14:00:00.000Z',
          consultMeetUrl: 'https://meet.google.com/abc-defg-hij',
          summary: 'Owner booked a consultation.',
          hasRecording: true,
        }),
      });
    });

    expect(await screen.findByText('Booked')).toBeInTheDocument();
    expect(
      screen.getByText(/Consultation: Tue, Sep 15, 9:00 AM Central Time with Mike Johnson/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Meet link' })).toHaveAttribute(
      'href',
      'https://meet.google.com/abc-defg-hij',
    );
    expect(screen.getByRole('button', { name: 'Download MP3' })).toBeInTheDocument();
    expect(screen.getByText('Owner booked a consultation.')).toBeInTheDocument();
    // No destination entered yet.
    expect(screen.getByRole('button', { name: 'Call with AI agent' })).toBeDisabled();
  });
});
