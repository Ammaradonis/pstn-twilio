import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render as renderBase, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError } from '../lib/api-client';
import { watchRecordingDownload } from '../lib/recording-downloads';

import { DialPage } from './dial';

function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderBase(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

async function renderDial() {
  const view = render(<DialPage />);
  await screen.findByText(/Caller ID:/);
  return view;
}

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
    callQuality: null,
    qualityWarnings: [] as string[],
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

vi.mock('../components/ai-agent-panel', () => ({
  AiAgentPanel: () => null,
}));

vi.mock('../lib/recording-downloads', () => ({
  watchRecordingDownload: vi.fn(),
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
        outboundAnalytics: vi.fn(() => new Promise(() => {})),
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
    callQuality: null,
    qualityWarnings: [] as string[],
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
    window.localStorage.removeItem('pstn-twilio.record-calls');
    vi.mocked(watchRecordingDownload).mockClear();
    vi.mocked(api.calls.lastDial).mockClear();
    vi.mocked(api.calls.lastDial).mockResolvedValue(null);
    vi.mocked(api.numbers.get).mockResolvedValue({
      phoneNumberE164: '+18776524532',
      country: 'US',
    } as never);
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
    expect(screen.getByLabelText(/destination/i)).toHaveValue('5');
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
    await renderDial();

    fireEvent.change(screen.getByLabelText(/destination/i), {
      target: { value: '+12547024877' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Call' }));

    await waitFor(() =>
      expect(voiceMock.current.makeCall).toHaveBeenCalledWith(
        'pn1',
        '+12547024877',
        expect.objectContaining({ recordCall: true }),
      ),
    );
    expect(screen.queryByText(/Cannot GET/)).not.toBeInTheDocument();
  });

  it('checks the last-dial endpoint before starting an outbound call', async () => {
    await renderDial();

    fireEvent.change(screen.getByLabelText(/destination/i), {
      target: { value: '+12547024877' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Call' }));

    await waitFor(() =>
      expect(voiceMock.current.makeCall).toHaveBeenCalledWith(
        'pn1',
        '+12547024877',
        expect.objectContaining({ recordCall: true }),
      ),
    );
    expect(api.calls.lastDial).toHaveBeenCalledWith('pn1', '+12547024877');
  });

  it('does not initiate a repeated outbound call when the user chooses no', async () => {
    vi.mocked(api.calls.lastDial).mockResolvedValue({
      callId: 'c1',
      destinationNumber: '+15304419961',
      lastDialedAt: '2026-06-07T18:31:57.652Z',
    });
    await renderDial();

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

  it('records by default and starts the automatic download for the connected call', async () => {
    const prepared = {
      outboundIntentId: 'intent1',
      selectedNumberId: 'pn1',
      selectedCallerId: '+15552222222',
      destinationNumber: '+12547024877',
      identity: 'user_u1_number_pn1',
      expiresAt: '2026-09-14T12:02:00.000Z',
      recordCall: true,
    };
    voiceMock.current.makeCall = vi.fn(async (_numberId, _destination, options) => {
      options?.onPrepared?.(prepared);
      return { on: vi.fn() };
    });
    await renderDial();

    expect(screen.getByRole('switch', { name: /record call/i })).toBeChecked();
    fireEvent.change(screen.getByLabelText(/destination/i), {
      target: { value: '+12547024877' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Call' }));

    await waitFor(() =>
      expect(watchRecordingDownload).toHaveBeenCalledWith({
        outboundIntentId: 'intent1',
        numberId: 'pn1',
        destination: '+12547024877',
        intentExpiresAt: '2026-09-14T12:02:00.000Z',
      }),
    );
  });

  it('places an unrecorded call when recording is toggled off and remembers the choice', async () => {
    const view = await renderDial();

    fireEvent.click(screen.getByRole('switch', { name: /record call/i }));
    expect(screen.getByRole('switch', { name: /record call/i })).not.toBeChecked();
    expect(screen.getByText('The call will not be recorded.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/destination/i), {
      target: { value: '+12547024877' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Call' }));

    await waitFor(() =>
      expect(voiceMock.current.makeCall).toHaveBeenCalledWith(
        'pn1',
        '+12547024877',
        expect.objectContaining({ recordCall: false }),
      ),
    );
    expect(watchRecordingDownload).not.toHaveBeenCalled();

    view.unmount();
    render(<DialPage />);
    expect(screen.getByRole('switch', { name: /record call/i })).not.toBeChecked();
  });

  it('does not start a download when the call fails to connect', async () => {
    voiceMock.current.makeCall = vi.fn(async (_numberId, _destination, options) => {
      options?.onPrepared?.({
        outboundIntentId: 'intent1',
        selectedNumberId: 'pn1',
        selectedCallerId: '+15552222222',
        destinationNumber: '+12547024877',
        identity: 'user_u1_number_pn1',
        expiresAt: '2026-09-14T12:02:00.000Z',
        recordCall: true,
      });
      return null;
    });
    await renderDial();

    fireEvent.change(screen.getByLabelText(/destination/i), {
      target: { value: '+12547024877' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Call' }));

    await waitFor(() => expect(voiceMock.current.makeCall).toHaveBeenCalled());
    expect(watchRecordingDownload).not.toHaveBeenCalled();
  });

  it('locks the recording toggle during a call', () => {
    voiceMock.current.active = true;
    voiceMock.current.connectionState = 'open';
    render(<DialPage />);

    expect(screen.getByRole('switch', { name: /record call/i })).toBeDisabled();
    expect(screen.getByText('Changes apply to your next call.')).toBeInTheDocument();
  });

  it('initiates a repeated outbound call when the user chooses yes', async () => {
    vi.mocked(api.calls.lastDial).mockResolvedValue({
      callId: 'c1',
      destinationNumber: '+15304419961',
      lastDialedAt: '2026-06-07T18:31:57.652Z',
    });
    await renderDial();

    fireEvent.change(screen.getByLabelText(/destination/i), { target: { value: '5304419961' } });
    fireEvent.click(screen.getByRole('button', { name: 'Call' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yes' }));

    await waitFor(() =>
      expect(voiceMock.current.makeCall).toHaveBeenCalledWith(
        'pn1',
        '+15304419961',
        expect.objectContaining({ recordCall: true }),
      ),
    );
    expect(api.calls.lastDial).toHaveBeenCalledTimes(1);
  });

  it('pastes a UK listing and calls immediately without a repeat-call lookup', async () => {
    vi.mocked(api.numbers.get).mockResolvedValue({
      phoneNumberE164: '+447458904436',
      country: 'GB',
    } as never);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: vi.fn().mockResolvedValue('London studio\n020 7946 0018') },
    });
    await renderDial();
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
    await waitFor(() =>
      expect(voiceMock.current.makeCall).toHaveBeenCalledWith(
        'pn1',
        '+442079460018',
        expect.objectContaining({ recordCall: true }),
      ),
    );
    expect(screen.getByLabelText(/destination/i)).toHaveValue('+442079460018');
    expect(api.calls.lastDial).not.toHaveBeenCalled();
  });

  it('direct UK paste starts one call even with rapid repeated paste events', async () => {
    vi.mocked(api.numbers.get).mockResolvedValue({
      phoneNumberE164: '+447458904436',
      country: 'GB',
    } as never);
    let finish!: () => void;
    voiceMock.current.makeCall.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await renderDial();
    const pasted = { clipboardData: { getData: () => '+44 (0)20 7946 0018' } };
    fireEvent.paste(screen.getByLabelText(/destination/i), pasted);
    fireEvent.paste(screen.getByLabelText(/destination/i), pasted);
    expect(voiceMock.current.makeCall).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText(/destination/i)).toHaveValue('+442079460018');
    await act(async () => finish());
  });

  it('leaves invalid UK clipboard text undialed', async () => {
    vi.mocked(api.numbers.get).mockResolvedValue({
      phoneNumberE164: '+447458904436',
      country: 'GB',
    } as never);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: vi.fn().mockResolvedValue('22 High Street SW1A 1AA') },
    });
    await renderDial();
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
    await screen.findByText(/Copy one complete UK phone number/);
    expect(voiceMock.current.makeCall).not.toHaveBeenCalled();
  });

  it('waits for the selected number country before enabling Paste', () => {
    vi.mocked(api.numbers.get).mockReturnValue(new Promise(() => {}));
    render(<DialPage />);
    expect(screen.getByRole('button', { name: 'Paste' })).toBeDisabled();
  });
});
