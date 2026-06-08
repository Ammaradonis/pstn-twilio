import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError } from '../lib/api-client';

import { DialPage } from './dial';

const voiceMock = vi.hoisted(() => ({
  current: {
    ready: true,
    registered: true,
    incoming: null,
    active: false,
    connectionState: 'idle' as 'idle' | 'pending' | 'ringing' | 'open' | 'closed',
    identity: 'user_u1_number_pn1',
    error: null,
    isMuted: false,
    canSendDigits: false,
    micPermission: 'granted' as const,
    browserSupported: true,
    init: vi.fn(),
    destroy: vi.fn(),
    accept: vi.fn(),
    reject: vi.fn(),
    hangup: vi.fn(),
    toggleMute: vi.fn(),
    sendDigits: vi.fn(),
    makeCall: vi.fn(),
  },
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ numberId: 'pn1' }),
}));

vi.mock('../hooks/use-voice-device', () => ({
  useVoiceDevice: () => voiceMock.current,
}));

vi.mock('../lib/api-client', () => {
  class MockApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
      readonly payload?: unknown,
    ) {
      super(message);
      this.name = 'ApiError';
    }
  }

  return {
    ApiError: MockApiError,
    api: {
      calls: {
        lastDial: vi.fn().mockResolvedValue(null),
      },
      numbers: {
        get: vi.fn(() => new Promise(() => {})),
      },
    },
  };
});

function resetVoiceMock() {
  voiceMock.current = {
    ready: true,
    registered: true,
    incoming: null,
    active: false,
    connectionState: 'idle' as 'idle' | 'pending' | 'ringing' | 'open' | 'closed',
    identity: 'user_u1_number_pn1',
    error: null,
    isMuted: false,
    canSendDigits: false,
    micPermission: 'granted',
    browserSupported: true,
    init: vi.fn(),
    destroy: vi.fn(),
    accept: vi.fn(),
    reject: vi.fn(),
    hangup: vi.fn(),
    toggleMute: vi.fn(),
    sendDigits: vi.fn(),
    makeCall: vi.fn(),
  };
}

describe('DialPage dialpad', () => {
  beforeEach(() => {
    resetVoiceMock();
    vi.mocked(api.calls.lastDial).mockClear();
    vi.mocked(api.calls.lastDial).mockResolvedValue(null);
  });

  it('has a plus key for destination entry before a call', () => {
    render(<DialPage />);

    fireEvent.click(screen.getByRole('button', { name: '+' }));

    expect(screen.getByLabelText(/destination/i)).toHaveValue('+');
  });

  it('sends active-call keypad digits as DTMF instead of editing the destination', () => {
    voiceMock.current.active = true;
    voiceMock.current.connectionState = 'open';
    render(<DialPage />);

    fireEvent.click(screen.getByRole('button', { name: '5' }));
    fireEvent.click(screen.getByRole('button', { name: '+' }));

    expect(voiceMock.current.sendDigits).toHaveBeenCalledWith('5');
    expect(voiceMock.current.sendDigits).not.toHaveBeenCalledWith('+');
    expect(screen.getByText(/Tones:/)).toHaveTextContent('5');
    expect(screen.getByLabelText(/destination/i)).toHaveValue('');
  });

  it('sends DTMF when the Twilio call can send digits even if active state is stale', () => {
    voiceMock.current.active = false;
    voiceMock.current.canSendDigits = true;
    voiceMock.current.connectionState = 'open';
    render(<DialPage />);

    fireEvent.click(screen.getByRole('button', { name: '8' }));
    fireEvent.keyDown(window, { key: '9' });

    expect(voiceMock.current.sendDigits).toHaveBeenCalledWith('8');
    expect(voiceMock.current.sendDigits).toHaveBeenCalledWith('9');
    expect(screen.getByText(/Tones:/)).toHaveTextContent('89');
    expect(screen.getByRole('button', { name: '+' })).toBeDisabled();
  });

  it('continues dialing when the optional last-dial lookup route is missing', async () => {
    vi.mocked(api.calls.lastDial).mockRejectedValue(
      new ApiError(404, 'Cannot GET /api/numbers/pn1/last-dial'),
    );
    render(<DialPage />);

    fireEvent.change(screen.getByLabelText(/destination/i), {
      target: { value: '+12547024877' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Call' }));

    await waitFor(() =>
      expect(voiceMock.current.makeCall).toHaveBeenCalledWith('pn1', '+12547024877'),
    );
    expect(screen.queryByText(/Cannot GET/)).not.toBeInTheDocument();
  });

  it('checks the last-dial endpoint before starting an outbound call', async () => {
    render(<DialPage />);

    fireEvent.change(screen.getByLabelText(/destination/i), {
      target: { value: '+12547024877' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Call' }));

    await waitFor(() =>
      expect(voiceMock.current.makeCall).toHaveBeenCalledWith('pn1', '+12547024877'),
    );
    expect(api.calls.lastDial).toHaveBeenCalledWith('pn1', '+12547024877');
  });

  it('does not initiate a repeated outbound call when the user chooses no', async () => {
    vi.mocked(api.calls.lastDial).mockResolvedValue({
      callId: 'c1',
      destinationNumber: '+15304419961',
      lastDialedAt: '2026-06-07T18:31:57.652Z',
    });
    render(<DialPage />);

    fireEvent.change(screen.getByLabelText(/destination/i), { target: { value: '5304419961' } });
    fireEvent.click(screen.getByRole('button', { name: 'Call' }));

    expect(await screen.findByRole('dialog')).toHaveTextContent('Warning: number dialed before');
    expect(screen.getByRole('dialog')).toHaveTextContent('+1 (530) 441-9961');
    expect(screen.getByRole('dialog')).toHaveTextContent(
      new Date('2026-06-07T18:31:57.652Z').toLocaleString(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'No' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(voiceMock.current.makeCall).not.toHaveBeenCalled();
  });

  it('initiates a repeated outbound call when the user chooses yes', async () => {
    vi.mocked(api.calls.lastDial).mockResolvedValue({
      callId: 'c1',
      destinationNumber: '+15304419961',
      lastDialedAt: '2026-06-07T18:31:57.652Z',
    });
    render(<DialPage />);

    fireEvent.change(screen.getByLabelText(/destination/i), { target: { value: '5304419961' } });
    fireEvent.click(screen.getByRole('button', { name: 'Call' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yes' }));

    await waitFor(() =>
      expect(voiceMock.current.makeCall).toHaveBeenCalledWith('pn1', '+15304419961'),
    );
    expect(api.calls.lastDial).toHaveBeenCalledTimes(1);
  });
});
