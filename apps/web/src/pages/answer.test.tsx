import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AnswerPage } from './answer';

const voiceMock = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ numberId: 'pn1' }),
}));

vi.mock('../hooks/use-voice-device', () => ({
  useVoiceDevice: () => voiceMock.current,
}));

function setVoice(overrides: Record<string, unknown> = {}) {
  voiceMock.current = {
    ready: true,
    registered: true,
    reconnecting: false,
    incoming: null,
    active: true,
    connectionState: 'open',
    identity: 'user_u1_number_pn1',
    error: null,
    isMuted: false,
    canSendDigits: true,
    micPermission: 'granted',
    browserSupported: true,
    init: vi.fn(),
    accept: vi.fn(),
    reject: vi.fn(),
    hangup: vi.fn(),
    toggleMute: vi.fn(),
    sendDigits: vi.fn(),
    requestMicPermission: vi.fn(),
    ...overrides,
  };
}

describe('AnswerPage in-call keypad', () => {
  beforeEach(() => setVoice());

  it('sends a tapped key as a DTMF tone and shows what was sent', () => {
    render(<AnswerPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Send 5' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send #' }));

    expect(voiceMock.current.sendDigits).toHaveBeenNthCalledWith(1, '5');
    expect(voiceMock.current.sendDigits).toHaveBeenNthCalledWith(2, '#');
    expect(screen.getByText('5#')).toBeInTheDocument();
  });

  it('sends digits typed on the physical keyboard', () => {
    render(<AnswerPage />);

    fireEvent.keyDown(window, { key: '5' });
    fireEvent.keyDown(window, { key: 'a' });

    expect(voiceMock.current.sendDigits).toHaveBeenCalledTimes(1);
    expect(voiceMock.current.sendDigits).toHaveBeenCalledWith('5');
  });

  it('keeps the keypad disabled until the call can send tones', () => {
    setVoice({ canSendDigits: false });
    render(<AnswerPage />);

    const five = screen.getByRole('button', { name: 'Send 5' });
    expect(five).toBeDisabled();
    fireEvent.keyDown(window, { key: '5' });
    expect(voiceMock.current.sendDigits).not.toHaveBeenCalled();
  });

  it('does not show the keypad when there is no call', () => {
    setVoice({ active: false, canSendDigits: false, connectionState: 'idle' });
    render(<AnswerPage />);

    expect(screen.queryByRole('group', { name: 'Call keypad' })).not.toBeInTheDocument();
  });
});
