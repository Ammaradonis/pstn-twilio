import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../lib/api-client';

import { useVoiceDevice } from './use-voice-device';

const voiceSdkMock = vi.hoisted(() => ({
  instances: [] as Array<{
    state: 'destroyed' | 'unregistered' | 'registering' | 'registered';
    register: ReturnType<typeof vi.fn>;
    updateToken: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    emit: (event: string, ...args: unknown[]) => void;
  }>,
}));

vi.mock('../lib/api-client', () => ({
  api: {
    voice: {
      token: vi.fn(),
      deviceConfig: vi.fn(),
      prepareOutbound: vi.fn(),
    },
  },
}));

vi.mock('@twilio/voice-sdk', () => {
  class Device {
    state: 'destroyed' | 'unregistered' | 'registering' | 'registered' = 'unregistered';
    register = vi.fn(async () => {
      if (this.state !== 'unregistered') {
        throw new Error(
          `Attempt to register when device is in state "${this.state}". Must be "unregistered".`,
        );
      }
      this.state = 'registered';
      this.emit('registered');
    });
    updateToken = vi.fn();
    destroy = vi.fn(() => {
      this.state = 'destroyed';
    });
    disconnectAll = vi.fn();
    connect = vi.fn();

    private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor() {
      voiceSdkMock.instances.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void) {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
    }

    emit(event: string, ...args: unknown[]) {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
  }

  return { Device };
});

type VoiceHook = ReturnType<typeof useVoiceDevice>;

function Harness({ onChange }: { onChange: (voice: VoiceHook) => void }) {
  const voice = useVoiceDevice();
  useEffect(() => {
    onChange(voice);
  }, [onChange, voice]);
  return null;
}

describe('useVoiceDevice', () => {
  let current: VoiceHook | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    voiceSdkMock.instances.length = 0;
    current = null;
    Object.defineProperty(window, 'RTCPeerConnection', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn() },
    });
    vi.mocked(api.voice.token).mockResolvedValue({
      token: 'voice.jwt',
      identity: 'user_u1_number_pn1',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    vi.mocked(api.voice.deviceConfig).mockResolvedValue({});
    vi.mocked(api.voice.prepareOutbound).mockResolvedValue({
      outboundIntentId: 'intent1',
      selectedNumberId: 'pn1',
      selectedCallerId: '+15552222222',
      destinationNumber: '+15551111111',
      identity: 'user_u1_number_pn1',
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    });
  });

  afterEach(() => {
    act(() => current?.destroy());
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('does not call register again when 31005 fires while the Twilio device is still registered', async () => {
    render(<Harness onChange={(voice) => (current = voice)} />);
    expect(current).not.toBeNull();

    await act(async () => {
      await current!.init('pn1');
      await Promise.resolve();
    });

    const device = voiceSdkMock.instances[0];
    expect(device).toBeDefined();
    if (!device) throw new Error('Mock Twilio Device was not created');
    expect(device.register).toHaveBeenCalledTimes(1);
    expect(device.state).toBe('registered');

    act(() => {
      device.emit('error', Object.assign(new Error('signaling disconnected'), { code: 31005 }));
    });
    expect(current!.error).toContain('31005');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(api.voice.token).toHaveBeenCalledTimes(2);
    expect(device.updateToken).toHaveBeenCalledTimes(1);
    expect(device.register).toHaveBeenCalledTimes(1);
    expect(current!.registered).toBe(true);
    expect(current!.error).toBeNull();
  });

  it('prepares an outbound intent before connecting the Twilio device', async () => {
    render(<Harness onChange={(voice) => (current = voice)} />);

    await act(async () => {
      await current!.init('pn1');
      await Promise.resolve();
    });

    const device = voiceSdkMock.instances[0];
    expect(device).toBeDefined();
    if (!device) throw new Error('Mock Twilio Device was not created');
    const call = { on: vi.fn(), isMuted: vi.fn().mockReturnValue(false) };
    device.connect.mockReturnValue(call);

    await act(async () => {
      await current!.makeCall('pn1', '+1 555-111-1111');
      await Promise.resolve();
    });

    expect(api.voice.prepareOutbound).toHaveBeenCalledWith('pn1', '+1 555-111-1111');
    expect(device.connect).toHaveBeenCalledWith({
      params: {
        selectedNumberId: 'pn1',
        destinationNumber: '+15551111111',
        outboundIntentId: 'intent1',
      },
    });
  });

  it('sends DTMF digits on the active Twilio call', async () => {
    render(<Harness onChange={(voice) => (current = voice)} />);

    await act(async () => {
      await current!.init('pn1');
      await Promise.resolve();
    });

    const device = voiceSdkMock.instances[0];
    expect(device).toBeDefined();
    if (!device) throw new Error('Mock Twilio Device was not created');
    const call = {
      on: vi.fn(),
      isMuted: vi.fn().mockReturnValue(false),
      sendDigits: vi.fn(),
    };
    device.connect.mockReturnValue(call);

    await act(async () => {
      await current!.makeCall('pn1', '+1 555-111-1111');
      current!.sendDigits('5');
    });

    expect(call.sendDigits).toHaveBeenCalledWith('5');
    expect(current!.error).toBeNull();

    act(() => current!.sendDigits('+'));

    expect(call.sendDigits).not.toHaveBeenCalledWith('+');
    expect(current!.error).toContain('DTMF digits');
  });
});
