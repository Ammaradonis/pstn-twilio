import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IncomingCallPopup } from './incoming-call-popup';

const voiceMock = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('../hooks/use-voice-device', () => ({
  useVoiceDevice: () => voiceMock.current,
}));

const init = vi.fn();
const destroy = vi.fn();

function setVoice(overrides: Record<string, unknown> = {}) {
  voiceMock.current = {
    registered: true,
    incoming: null,
    active: false,
    connectionState: 'idle',
    error: null,
    micPermission: 'granted',
    init,
    destroy,
    accept: vi.fn().mockResolvedValue(undefined),
    reject: vi.fn(),
    hangup: vi.fn(),
    requestMicPermission: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

const ringing = {
  incoming: { connection: {}, from: '+15552223333', calledNumber: '+16672206726' },
};

describe('IncomingCallPopup', () => {
  beforeEach(() => {
    init.mockClear();
    destroy.mockClear();
    setVoice();
  });

  it('registers the voice device for the whole app and releases it on sign out', () => {
    const { container, unmount } = render(<IncomingCallPopup />);
    expect(init).toHaveBeenCalledWith();
    expect(container).toBeEmptyDOMElement();
    unmount();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('pops up a ringing call with the caller and the number that was called', () => {
    setVoice(ringing);
    render(<IncomingCallPopup />);
    const dialog = screen.getByRole('alertdialog', { name: 'Incoming call' });
    expect(dialog).toHaveTextContent('+1 (555) 222-3333');
    expect(dialog).toHaveTextContent('to +1 (667) 220-6726');
    expect(screen.getByRole('button', { name: 'Answer' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Hang up' })).toBeEnabled();
  });

  it('declines a ringing call with Hang up', () => {
    setVoice(ringing);
    render(<IncomingCallPopup />);
    fireEvent.click(screen.getByRole('button', { name: 'Hang up' }));
    expect(voiceMock.current.reject).toHaveBeenCalledTimes(1);
    expect(voiceMock.current.accept).not.toHaveBeenCalled();
  });

  it('asks for the microphone before answering when it is not granted yet', async () => {
    setVoice({ ...ringing, micPermission: 'prompt' });
    render(<IncomingCallPopup />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    });
    expect(voiceMock.current.requestMicPermission).toHaveBeenCalledTimes(1);
    expect(voiceMock.current.accept).toHaveBeenCalledTimes(1);
  });

  it('does not answer when the microphone request is refused', async () => {
    setVoice({
      ...ringing,
      micPermission: 'prompt',
      requestMicPermission: vi.fn().mockResolvedValue(false),
    });
    render(<IncomingCallPopup />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    });
    expect(voiceMock.current.accept).not.toHaveBeenCalled();
  });

  it('keeps a Hang up bar on screen after answering, until the call ends', async () => {
    setVoice(ringing);
    const { rerender } = render(<IncomingCallPopup />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    });
    expect(voiceMock.current.accept).toHaveBeenCalledTimes(1);

    setVoice({ active: true, connectionState: 'open' });
    rerender(<IncomingCallPopup />);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('+1 (555) 222-3333');
    fireEvent.click(screen.getByRole('button', { name: 'Hang up' }));
    expect(voiceMock.current.hangup).toHaveBeenCalledTimes(1);

    setVoice({ active: false, connectionState: 'closed' });
    rerender(<IncomingCallPopup />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows no call bar for outbound calls placed from the Dial page', () => {
    setVoice({ active: true, connectionState: 'open' });
    const { container } = render(<IncomingCallPopup />);
    expect(container).toBeEmptyDOMElement();
  });

  it('disables Answer while the microphone is blocked', () => {
    setVoice({ ...ringing, micPermission: 'denied' });
    render(<IncomingCallPopup />);
    expect(screen.getByRole('button', { name: 'Answer' })).toBeDisabled();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Microphone is blocked');
  });
});
