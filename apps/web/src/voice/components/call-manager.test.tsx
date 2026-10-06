import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CallProvider } from './call-manager';
import { SnackbarProvider } from './ui';

const voiceMock = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const api = vi.hoisted(() => ({
  decline: vi.fn(),
  answered: vi.fn(),
  ringHere: vi.fn(),
  bootstrap: vi.fn(),
  contacts: vi.fn(),
}));
const ringtone = vi.hoisted(() => ({ stop: vi.fn(), start: vi.fn() }));

vi.mock('../../hooks/use-voice-device', () => ({
  useVoiceDevice: () => voiceMock.current,
  setSdkIncomingSound: vi.fn(),
}));
vi.mock('../../lib/realtime', () => ({
  getSocket: () => ({ on: vi.fn(), off: vi.fn(), connected: true }),
}));
vi.mock('../lib/voice-api', () => ({ voiceApi: api }));
vi.mock('../lib/ringtone', () => ({
  startRingtone: ringtone.start,
  startRingback: ringtone.start,
  unlockAudio: vi.fn(),
  vibrate: vi.fn(),
  playKeyTone: vi.fn(),
  playEndTone: vi.fn(),
  // Treated as "audio is live" so the SDK's own ring stays off in tests.
  canPlayAudio: () => true,
  RING_VIBRATION: [1],
}));
vi.mock('../lib/push', () => ({
  showLocalNotification: vi.fn(),
  closeLocalNotifications: vi.fn().mockResolvedValue(undefined),
}));

const PARENT = 'CA11111111111111111111111111111111';

function incomingCall(parent = PARENT) {
  return {
    from: '+14155550100',
    connection: {
      customParameters: new Map([
        ['parentCallSid', parent],
        ['callerName', 'Ana Ruiz'],
      ]),
    },
  };
}

function setVoice(overrides: Record<string, unknown> = {}) {
  voiceMock.current = {
    registered: true,
    incoming: null,
    active: false,
    connectionState: 'idle',
    error: null,
    callNotice: null,
    micPermission: 'granted',
    microphoneInputs: [],
    isMuted: false,
    canSendDigits: false,
    init: vi.fn(),
    destroy: vi.fn(),
    accept: vi.fn().mockResolvedValue(undefined),
    reject: vi.fn(),
    hangup: vi.fn(),
    makeCall: vi.fn(),
    refreshMicrophones: vi.fn().mockResolvedValue(undefined),
    requestMicPermission: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function wrap(children: ReactNode, path = '/voice/calls') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <SnackbarProvider>
          <CallProvider>{children}</CallProvider>
        </SnackbarProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('CallProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ringtone.start.mockReturnValue(ringtone.stop);
    api.decline.mockResolvedValue({ declined: true });
    api.answered.mockResolvedValue(undefined);
    api.ringHere.mockResolvedValue({ ringing: true });
    api.bootstrap.mockResolvedValue({
      numbers: [{ id: 'pn1', e164: '+18776524532', voice: true, sms: true }],
    });
    api.contacts.mockResolvedValue([]);
    setVoice();
  });

  it('interrupts the screen with the caller and rings with this device’s ringtone', () => {
    setVoice({ incoming: incomingCall() });
    const { unmount } = render(wrap(<p>Calls page</p>));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Ana Ruiz');
    expect(dialog).toHaveTextContent('(415) 555-0100');
    expect(ringtone.start).toHaveBeenCalledWith('voice');
    unmount();
    expect(ringtone.stop).toHaveBeenCalled();
  });

  it('declining sends the caller to voicemail on every device', () => {
    setVoice({ incoming: incomingCall() });
    render(wrap(null));
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(voiceMock.current.reject).toHaveBeenCalled();
    expect(api.decline).toHaveBeenCalledWith(PARENT);
  });

  it('answering accepts the call and reports this device', async () => {
    setVoice({ incoming: incomingCall() });
    render(wrap(null));
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    await waitFor(() => expect(voiceMock.current.accept).toHaveBeenCalled());
    await waitFor(() => expect(api.answered).toHaveBeenCalledWith(PARENT, expect.any(String)));
  });

  it('opened from a call notification, it rings this device and picks up', async () => {
    const { rerender } = render(wrap(null, `/voice/calls?answer=${PARENT}`));
    await waitFor(() => expect(api.ringHere).toHaveBeenCalledWith(PARENT));
    expect(voiceMock.current.accept).not.toHaveBeenCalled();
    act(() => setVoice({ incoming: incomingCall() }));
    rerender(wrap(null, `/voice/calls?answer=${PARENT}`));
    await waitFor(() => expect(voiceMock.current.accept).toHaveBeenCalled());
  });
});
