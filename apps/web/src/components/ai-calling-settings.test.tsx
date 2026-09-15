import type { AiCallingConfigDto } from '@pstn-twilio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../lib/api-client';

import { AiCallingSettings } from './ai-calling-settings';

vi.mock('../lib/api-client', () => ({
  api: {
    aiCalls: { config: vi.fn(), inbound: vi.fn(), setInbound: vi.fn() },
    googleCalendar: { connectUrl: vi.fn(), disconnect: vi.fn() },
  },
}));

const config: AiCallingConfigDto = {
  ready: true,
  missing: [],
  callerNumber: '+16672206726',
  defaultStateCode: 'AL',
  consultMinutes: 20,
  calendar: { connected: true, email: 'host@example.com' },
};

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AiCallingSettings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AiCallingSettings incoming calls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.aiCalls.config).mockResolvedValue(config);
  });

  it('shows blocked incoming calls and reverts to the agent in one click', async () => {
    vi.mocked(api.aiCalls.inbound).mockResolvedValue({
      phoneNumber: '+16672206726',
      mode: 'blocked',
    });
    vi.mocked(api.aiCalls.setInbound).mockResolvedValue({
      phoneNumber: '+16672206726',
      mode: 'agent',
    });
    renderSettings();

    expect(await screen.findByText(/Blocked\. Callers hear a busy signal/)).toBeInTheDocument();
    expect(screen.getByText('+1 (667) 220-6726')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Block incoming calls' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Let the agent answer' }));

    await waitFor(() => expect(api.aiCalls.setInbound).toHaveBeenCalledWith('agent'));
    expect(await screen.findByText(/The agent answers\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Block incoming calls' })).toBeInTheDocument();
  });

  it('blocks incoming calls when the agent is answering', async () => {
    vi.mocked(api.aiCalls.inbound).mockResolvedValue({
      phoneNumber: '+16672206726',
      mode: 'agent',
    });
    vi.mocked(api.aiCalls.setInbound).mockResolvedValue({
      phoneNumber: '+16672206726',
      mode: 'blocked',
    });
    renderSettings();

    fireEvent.click(await screen.findByRole('button', { name: 'Block incoming calls' }));

    await waitFor(() => expect(api.aiCalls.setInbound).toHaveBeenCalledWith('blocked'));
    expect(await screen.findByText(/Blocked\./)).toBeInTheDocument();
  });

  it('offers both options when Twilio routes the number elsewhere, and shows failures', async () => {
    vi.mocked(api.aiCalls.inbound).mockResolvedValue({
      phoneNumber: '+16672206726',
      mode: 'other',
    });
    vi.mocked(api.aiCalls.setInbound).mockRejectedValue(
      new Error("Twilio couldn't update incoming calls"),
    );
    renderSettings();

    expect(await screen.findByRole('button', { name: 'Let the agent answer' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Block incoming calls' }));
    expect(await screen.findByText("Twilio couldn't update incoming calls")).toBeInTheDocument();
  });
});
