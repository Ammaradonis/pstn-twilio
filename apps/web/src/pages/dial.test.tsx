import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../lib/api-client', () => ({
  api: {
    numbers: {
      get: vi.fn(() => new Promise(() => {})),
    },
  },
}));

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
});
