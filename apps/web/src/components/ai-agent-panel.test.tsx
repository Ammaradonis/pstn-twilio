import type { AiCallDto, AiCallingConfigDto } from '@pstn-twilio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../lib/api-client';

import { AiAgentPanel } from './ai-agent-panel';

const socketHandlers = vi.hoisted(() => new Map<string, (payload: unknown) => void>());

vi.mock('../lib/api-client', () => ({
  api: {
    aiCalls: { config: vi.fn(), list: vi.fn(), start: vi.fn(), pressKeys: vi.fn() },
  },
}));

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
    recordingUrl: null,
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
    expect(screen.getByText(/already called this number/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Call again with AI' }));
    await waitFor(() => expect(api.aiCalls.start).toHaveBeenCalledTimes(1));
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
          recordingUrl: 'https://storage.vapi.ai/rec.wav',
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
    expect(screen.getByRole('link', { name: 'Recording' })).toBeInTheDocument();
    expect(screen.getByText('Owner booked a consultation.')).toBeInTheDocument();
    // No destination entered yet.
    expect(screen.getByRole('button', { name: 'Call with AI agent' })).toBeDisabled();
  });
});
