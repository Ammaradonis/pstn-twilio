import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../lib/api-client';

import { useVoiceDevice } from './use-voice-device';

const voiceSdkMock = vi.hoisted(() => ({
  autoRegister: true,
  instances: [] as Array<{
    state: 'destroyed' | 'unregistered' | 'registering' | 'registered';
    register: ReturnType<typeof vi.fn>;
    updateToken: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    audio: {
      setAudioConstraints: ReturnType<typeof vi.fn>;
      setInputDevice: ReturnType<typeof vi.fn>;
      unsetInputDevice: ReturnType<typeof vi.fn>;
    };
    options: Record<string, unknown>;
    emit: (event: string, ...args: unknown[]) => void;
  }>,
}));

const mediaMock = vi.hoisted(() => ({
  stopTrack: vi.fn(),
  getUserMedia: vi.fn(),
}));

vi.mock('../lib/api-client', () => ({
  api: {
    voice: {
      token: vi.fn(),
      deviceConfig: vi.fn(),
      prepareOutbound: vi.fn(),
    },
    calls: { byOutboundIntent: vi.fn() },
  },
}));

vi.mock('@twilio/voice-sdk', () => {
  class Device {
    state: 'destroyed' | 'unregistered' | 'registering' | 'registered' = 'unregistered';
    options: Record<string, unknown>;
    register = vi.fn(async () => {
      if (this.state !== 'unregistered') {
        throw new Error(
          `Attempt to register when device is in state "${this.state}". Must be "unregistered".`,
        );
      }
      this.state = 'registering';
      this.emit('registering');
      if (!voiceSdkMock.autoRegister) await new Promise<void>(() => {});
      this.state = 'registered';
      this.emit('registered');
    });
    updateToken = vi.fn();
    destroy = vi.fn(() => {
      this.state = 'destroyed';
    });
    disconnectAll = vi.fn();
    connect = vi.fn();
    audio = {
      setAudioConstraints: vi.fn().mockResolvedValue(undefined),
      setInputDevice: vi.fn().mockResolvedValue(undefined),
      unsetInputDevice: vi.fn().mockResolvedValue(undefined),
    };

    private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor(_token: string, options: Record<string, unknown>) {
      this.options = options;
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
    window.localStorage.clear();
    vi.useFakeTimers();
    voiceSdkMock.instances.length = 0;
    voiceSdkMock.autoRegister = true;
    vi.mocked(api.calls.byOutboundIntent).mockResolvedValue(null);
    current = null;
    Object.defineProperty(window, 'RTCPeerConnection', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: mediaMock.getUserMedia },
    });
    mediaMock.stopTrack.mockClear();
    mediaMock.getUserMedia.mockResolvedValue({
      getTracks: () => [{ stop: mediaMock.stopTrack }],
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
      recordCall: true,
    });
  });

  afterEach(() => {
    act(() => current?.destroy());
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('waits for the SDK to confirm recovery when 31005 fires while the device state is still registered', async () => {
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

    // A transport drop does not invalidate the token; pushing one while the
    // socket is down would only make the SDK emit 31009.
    expect(api.voice.token).toHaveBeenCalledTimes(1);
    expect(device.updateToken).not.toHaveBeenCalled();
    expect(device.register).toHaveBeenCalledTimes(1);
    expect(current!.registered).toBe(false);
    expect(current!.error).toContain('31005');

    act(() => {
      device.emit('registered');
    });

    expect(current!.registered).toBe(true);
    expect(current!.error).toBeNull();
  });

  it('passes validated fallback edges and signaling recovery options to the Twilio device', async () => {
    vi.mocked(api.voice.deviceConfig).mockResolvedValue({
      codecPreferences: ['opus', 'pcmu'],
      edge: ['frankfurt', 'dublin', 'ashburn'],
      dscp: true,
      closeProtection: true,
      enableImprovedSignalingErrorPrecision: true,
      tokenRefreshMs: 60_000,
      maxCallSignalingTimeoutMs: 30_000,
      audioConstraints: { shouldNotReachTheSdk: true },
    });
    render(<Harness onChange={(voice) => (current = voice)} />);

    await act(async () => {
      await current!.init('pn1');
      await Promise.resolve();
    });

    const device = voiceSdkMock.instances[0];
    expect(device).toBeDefined();
    if (!device) throw new Error('Mock Twilio Device was not created');
    expect(device.options).toEqual({
      codecPreferences: ['opus', 'pcmu'],
      edge: ['frankfurt', 'dublin', 'ashburn'],
      dscp: true,
      closeProtection: true,
      enableImprovedSignalingErrorPrecision: true,
      tokenRefreshMs: 60_000,
      maxCallSignalingTimeoutMs: 30_000,
    });
  });

  it('does not push a token into a down socket after 31009 and accepts an SDK recovery event', async () => {
    render(<Harness onChange={(voice) => (current = voice)} />);

    await act(async () => {
      await current!.init('pn1');
      await Promise.resolve();
    });

    const device = voiceSdkMock.instances[0];
    expect(device).toBeDefined();
    if (!device) throw new Error('Mock Twilio Device was not created');

    act(() => {
      device.emit('error', Object.assign(new Error('transport unavailable'), { code: 31009 }));
    });
    expect(current!.error).toContain('31009');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(api.voice.token).toHaveBeenCalledTimes(1);
    expect(device.updateToken).not.toHaveBeenCalled();
    expect(device.register).toHaveBeenCalledTimes(1);

    act(() => {
      device.emit('registered');
    });

    expect(current!.registered).toBe(true);
    expect(current!.error).toBeNull();
  });

  it('fetches a fresh token when Twilio rejects the current one', async () => {
    render(<Harness onChange={(voice) => (current = voice)} />);

    await act(async () => {
      await current!.init('pn1');
      await Promise.resolve();
    });

    const device = voiceSdkMock.instances[0];
    if (!device) throw new Error('Mock Twilio Device was not created');

    act(() => {
      device.emit('error', Object.assign(new Error('invalid token'), { code: 31204 }));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(api.voice.token).toHaveBeenCalledTimes(2);
    expect(device.updateToken).toHaveBeenCalledWith('voice.jwt');
  });

  it('replaces an idle stale device after eight seconds and rotates the edge order', async () => {
    vi.mocked(api.voice.deviceConfig).mockResolvedValue({
      edge: ['frankfurt', 'dublin', 'ashburn'],
    });
    render(<Harness onChange={(voice) => (current = voice)} />);

    await act(async () => {
      await current!.init('pn1');
      await Promise.resolve();
    });

    const stalledDevice = voiceSdkMock.instances[0];
    expect(stalledDevice).toBeDefined();
    if (!stalledDevice) throw new Error('Mock Twilio Device was not created');

    act(() => {
      stalledDevice.emit(
        'error',
        Object.assign(new Error('transport unavailable'), { code: 31009 }),
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_999);
    });

    expect(stalledDevice.destroy).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(stalledDevice.destroy).toHaveBeenCalledTimes(1);
    expect(voiceSdkMock.instances).toHaveLength(2);
    expect(voiceSdkMock.instances[1]?.register).toHaveBeenCalledTimes(1);
    expect(voiceSdkMock.instances[1]?.options.edge).toEqual(['dublin', 'ashburn', 'frankfurt']);
    expect(current!.registered).toBe(true);
    expect(current!.error).toBeNull();
  });

  it('recreates an idle device that remains registering after eight seconds', async () => {
    render(<Harness onChange={(voice) => (current = voice)} />);

    await act(async () => {
      await current!.init('pn1');
      await Promise.resolve();
    });

    const stalledDevice = voiceSdkMock.instances[0];
    expect(stalledDevice).toBeDefined();
    if (!stalledDevice) throw new Error('Mock Twilio Device was not created');
    stalledDevice.state = 'registering';

    act(() => {
      stalledDevice.emit(
        'error',
        Object.assign(new Error('signaling disconnected'), { code: 31005 }),
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });

    expect(stalledDevice.destroy).toHaveBeenCalledTimes(1);
    expect(voiceSdkMock.instances).toHaveLength(2);
    expect(voiceSdkMock.instances[1]?.register).toHaveBeenCalledTimes(1);
    expect(current!.registered).toBe(true);
    expect(current!.error).toBeNull();
  });

  it('keeps an active call usable through a transient 31005 until the SDK reconnects it', async () => {
    render(<Harness onChange={(voice) => (current = voice)} />);

    await act(async () => {
      await current!.init('pn1');
      await Promise.resolve();
    });

    const device = voiceSdkMock.instances[0];
    if (!device) throw new Error('Mock Twilio Device was not created');
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const call = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) =>
        handlers.set(event, handler),
      ),
      isMuted: vi.fn().mockReturnValue(false),
      disconnect: vi.fn(),
      sendDigits: vi.fn(),
    };
    device.connect.mockReturnValue(call);

    await act(async () => {
      await current!.makeCall('pn1', '+1 555-111-1111');
    });
    act(() => handlers.get('accept')?.());

    act(() => {
      handlers.get('error')?.(Object.assign(new Error('signaling dropped'), { code: 31005 }));
    });
    expect(current!.active).toBe(true);
    expect(current!.connectionState).toBe('open');
    expect(current!.error).toContain('31005');

    act(() => handlers.get('reconnected')?.());
    expect(current!.error).toBeNull();

    act(() => current!.hangup());
    expect(call.disconnect).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the device when the SDK destroys it unexpectedly', async () => {
    render(<Harness onChange={(voice) => (current = voice)} />);

    await act(async () => {
      await current!.init('pn1');
      await Promise.resolve();
    });

    const device = voiceSdkMock.instances[0];
    if (!device) throw new Error('Mock Twilio Device was not created');

    await act(async () => {
      device.state = 'destroyed';
      device.emit('destroyed');
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(voiceSdkMock.instances).toHaveLength(2);
    expect(voiceSdkMock.instances[1]?.register).toHaveBeenCalledTimes(1);
    expect(current!.registered).toBe(true);
  });

  it('absorbs unhandled Twilio signaling rejections instead of surfacing them', async () => {
    render(<Harness onChange={(voice) => (current = voice)} />);

    await act(async () => {
      await current!.init('pn1');
      await Promise.resolve();
    });

    const event = Object.assign(new Event('unhandledrejection', { cancelable: true }), {
      reason: Object.assign(new Error('re-register failed'), { code: 31005 }),
    });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
  });

  it('stops a continuous outage after thirty seconds and supports a manual retry', async () => {
    render(<Harness onChange={(voice) => (current = voice)} />);
    await act(async () => {
      await current!.init('pn1');
    });
    const original = voiceSdkMock.instances[0]!;
    voiceSdkMock.autoRegister = false;
    act(() => original.emit('error', { code: 31009, message: 'Transport unavailable' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(current!.recoveryFailed).toBe(true);
    expect(current!.reconnecting).toBe(false);
    expect(current!.error).toContain('within 30 seconds');
    const attempts = voiceSdkMock.instances.length;
    await act(async () => {
      await current!.init('pn1');
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(voiceSdkMock.instances).toHaveLength(attempts);
    expect(api.voice.prepareOutbound).not.toHaveBeenCalled();
    voiceSdkMock.autoRegister = true;
    await act(async () => {
      current!.retryConnection();
    });
    expect(current!.registered).toBe(true);
    expect(current!.recoveryFailed).toBe(false);
    expect(current!.error).toBeNull();
  });

  it('recovers initial registration even when register never settles or emits an error', async () => {
    voiceSdkMock.autoRegister = false;
    render(<Harness onChange={(voice) => (current = voice)} />);
    await act(async () => {
      await current!.init('pn1');
    });
    expect(current!.registered).toBe(false);
    voiceSdkMock.autoRegister = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(voiceSdkMock.instances).toHaveLength(2);
    expect(current!.registered).toBe(true);
  });

  it('does not mistake stale registered state for recovery when trying to call', async () => {
    render(<Harness onChange={(voice) => (current = voice)} />);
    await act(async () => {
      await current!.init('pn1');
    });
    const device = voiceSdkMock.instances[0]!;
    act(() => device.emit('error', { code: 31005, message: 'Connection lost' }));
    await act(async () => {
      await current!.init('pn1');
      await current!.makeCall('pn1', '+442079460018');
    });
    expect(current!.registered).toBe(false);
    expect(current!.error).toContain('31005');
    expect(device.connect).not.toHaveBeenCalled();
    expect(api.voice.prepareOutbound).not.toHaveBeenCalled();
  });

  it('keeps a live call and its controls even when registration recovery times out', async () => {
    render(<Harness onChange={(voice) => (current = voice)} />);
    await act(async () => {
      await current!.init('pn1');
    });
    const device = voiceSdkMock.instances[0]!;
    const disconnect = vi.fn();
    device.connect.mockResolvedValue({ on: vi.fn(), disconnect, sendDigits: vi.fn() });
    await act(async () => {
      await current!.makeCall('pn1', '+442079460018');
    });
    act(() => device.emit('error', { code: 31005 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(current!.recoveryFailed).toBe(true);
    expect(current!.active).toBe(true);
    expect(current!.canSendDigits).toBe(true);
    expect(disconnect).not.toHaveBeenCalled();
    expect(device.destroy).not.toHaveBeenCalled();
    act(() => current!.retryConnection());
    expect(device.destroy).not.toHaveBeenCalled();
    act(() => current!.hangup());
    await act(async () => {
      current!.retryConnection();
    });
    expect(current!.registered).toBe(true);
    expect(api.voice.prepareOutbound).toHaveBeenCalledTimes(1);
  });

  it('classifies a 31005 HANGUP wrapper as a terminal call error and confirms no answer', async () => {
    render(<Harness onChange={(voice) => (current = voice)} />);
    await act(async () => {
      await current!.init('pn1');
    });
    const device = voiceSdkMock.instances[0]!;
    const handlers = new Map<string, (...args: unknown[]) => void>();
    device.connect.mockResolvedValue({
      on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler),
      disconnect: vi.fn(),
    });
    vi.mocked(api.calls.byOutboundIntent).mockResolvedValue({ status: 'NO_ANSWER' } as never);
    await act(async () => {
      await current!.makeCall('pn1', '+442079460018');
    });
    await act(async () => {
      handlers.get('error')?.(
        Object.assign(new Error('Error sent from gateway in HANGUP'), {
          code: 31005,
          originalError: { code: 31000, message: 'Call ended' },
        }),
      );
    });
    expect(current!.active).toBe(false);
    expect(current!.registered).toBe(true);
    expect(current!.reconnecting).toBe(false);
    expect(current!.callNotice).toContain('No answer');
    expect(current!.error).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(device.destroy).not.toHaveBeenCalled();
    expect(api.voice.token).toHaveBeenCalledTimes(1);
  });

  it('shows the original destination error without blaming TwiML configuration', async () => {
    render(<Harness onChange={(voice) => (current = voice)} />);
    await act(async () => {
      await current!.init('pn1');
    });
    const device = voiceSdkMock.instances[0]!;
    act(() =>
      device.emit('error', {
        code: 31000,
        originalError: { code: 13224, message: 'invalid phone number' },
      }),
    );
    expect(current!.error).toContain('13224');
    expect(current!.error).not.toContain('TwiML');
    expect(current!.registered).toBe(true);
    act(() => device.emit('error', { code: 31000, message: 'A call ended unexpectedly' }));
    expect(current!.error).toContain('A call ended unexpectedly');
    expect(current!.error).not.toContain('setup');
  });

  it('closes a pending call when transportClose changes SDK status without disconnect', async () => {
    render(<Harness onChange={(voice) => (current = voice)} />);
    await act(async () => {
      await current!.init('pn1');
    });
    const device = voiceSdkMock.instances[0]!;
    const handlers = new Map<string, (...args: unknown[]) => void>();
    let status = 'pending';
    device.connect.mockResolvedValue({
      on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler),
      status: () => status,
    });
    await act(async () => {
      await current!.makeCall('pn1', '+442079460018');
    });
    await act(async () => {
      handlers.get('transportClose')?.();
      status = 'closed';
      device.emit('error', { code: 31005 });
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(current!.active).toBe(false);
    expect(current!.registered).toBe(true);
    expect(device.destroy).toHaveBeenCalledOnce();
  });

  it('ignores a late previous-call outcome after starting another call', async () => {
    render(<Harness onChange={(voice) => (current = voice)} />);
    await act(async () => {
      await current!.init('pn1');
    });
    const device = voiceSdkMock.instances[0]!;
    const handlers = new Map<string, (...args: unknown[]) => void>();
    device.connect.mockResolvedValue({
      on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler),
    });
    let resolveOutcome!: (value: never) => void;
    vi.mocked(api.calls.byOutboundIntent).mockReturnValue(
      new Promise((resolve) => {
        resolveOutcome = resolve;
      }),
    );
    await act(async () => {
      await current!.makeCall('pn1', '+442079460018');
    });
    act(() => handlers.get('disconnect')?.());
    await act(async () => {
      await current!.makeCall('pn1', '+441614960123');
    });
    await act(async () => {
      resolveOutcome({ status: 'NO_ANSWER' } as never);
    });
    expect(current!.active).toBe(true);
    expect(current!.callNotice).toBeNull();
  });

  it('ignores a late initial token response after switching numbers', async () => {
    let resolveToken!: (value: Awaited<ReturnType<typeof api.voice.token>>) => void;
    vi.mocked(api.voice.token).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveToken = resolve;
      }),
    );
    render(<Harness onChange={(voice) => (current = voice)} />);
    let firstInit: Promise<unknown>;
    act(() => {
      firstInit = current!.init('old-number');
    });
    let initialized: unknown;
    await act(async () => {
      initialized = await current!.init('pn1');
    });
    expect(initialized, current!.error ?? undefined).not.toBeNull();
    await act(async () => {
      resolveToken({
        token: 'old.jwt',
        identity: 'old_identity',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      await firstInit;
    });
    expect(voiceSdkMock.instances).toHaveLength(1);
    expect(current!.identity).toBe('user_u1_number_pn1');
    expect(current!.registered).toBe(true);
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
    const onPrepared = vi.fn();

    await act(async () => {
      await current!.makeCall('pn1', '+1 555-111-1111', { recordCall: false, onPrepared });
      await Promise.resolve();
    });

    expect(api.voice.prepareOutbound).toHaveBeenCalledWith('pn1', '+1 555-111-1111', false);
    expect(onPrepared).toHaveBeenCalledWith(
      expect.objectContaining({ outboundIntentId: 'intent1', selectedNumberId: 'pn1' }),
    );
    expect(device.connect).toHaveBeenCalledWith({
      params: {
        selectedNumberId: 'pn1',
        destinationNumber: '+15551111111',
        outboundIntentId: 'intent1',
      },
      audioConstraints: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      rtcConstraints: {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      },
    });
    expect(mediaMock.getUserMedia).not.toHaveBeenCalled();
  });

  it('cleans up 31603, stays registered, and ignores the declined call after a new call starts', async () => {
    render(<Harness onChange={(voice) => (current = voice)} />);
    await act(async () => {
      await current!.init('pn1');
    });
    const device = voiceSdkMock.instances[0]!;
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const call = {
      on: vi.fn((event, handler) => handlers.set(event, handler)),
      disconnect: vi.fn(),
    };
    device.connect.mockReturnValue(call);
    await act(async () => {
      await current!.makeCall('pn1', '+15304419961');
    });
    act(() => handlers.get('error')?.(Object.assign(new Error('Decline'), { code: 31603 })));
    expect(current!.active).toBe(false);
    expect(current!.error).toBeNull();
    expect(current!.callNotice).toContain('declined');
    expect(current!.registered).toBe(true);
    expect(device.audio.unsetInputDevice).toHaveBeenCalled();
    expect(call.disconnect).toHaveBeenCalled();
    const next = { on: vi.fn(), sendDigits: vi.fn() };
    device.connect.mockReturnValue(next);
    await act(async () => {
      await current!.makeCall('pn1', '+15304419961');
    });
    device.audio.unsetInputDevice.mockClear();
    act(() => {
      handlers.get('disconnect')?.();
      handlers.get('error')?.(Object.assign(new Error('Late decline'), { code: 31603 }));
      current!.sendDigits('5');
    });
    expect(current!.active).toBe(true);
    expect(current!.error).toBeNull();
    expect(current!.callNotice).toBeNull();
    expect(next.sendDigits).toHaveBeenCalledWith('5');
    expect(device.audio.unsetInputDevice).not.toHaveBeenCalled();
    expect(device.register).toHaveBeenCalledTimes(1);
  });

  it('releases selected audio when connect rejects with a nested 31603 error', async () => {
    render(<Harness onChange={(voice) => (current = voice)} />);
    await act(async () => {
      await current!.init('pn1');
    });
    const device = voiceSdkMock.instances[0]!;
    device.connect.mockRejectedValue({ code: 31005, twilioError: { code: 31603 } });
    await act(async () => {
      await current!.makeCall('pn1', '+15304419961');
    });
    expect(current!.error).toBeNull();
    expect(current!.callNotice).toContain('31603');
    expect(current!.registered).toBe(true);
    expect(device.audio.unsetInputDevice).toHaveBeenCalled();
  });

  it('reports Twilio media failures from outbound connect without a duplicate mic preflight', async () => {
    render(<Harness onChange={(voice) => (current = voice)} />);

    await act(async () => {
      await current!.init('pn1');
      await Promise.resolve();
    });

    const device = voiceSdkMock.instances[0];
    expect(device).toBeDefined();
    if (!device) throw new Error('Mock Twilio Device was not created');
    device.connect.mockRejectedValue(
      Object.assign(new Error('getting the media failed'), { code: 31402 }),
    );

    await act(async () => {
      await current!.makeCall('pn1', '+1 555-111-1111');
      await Promise.resolve();
    });

    expect(api.voice.prepareOutbound).toHaveBeenCalledWith('pn1', '+1 555-111-1111', undefined);
    expect(device.connect).toHaveBeenCalledWith({
      params: {
        selectedNumberId: 'pn1',
        destinationNumber: '+15551111111',
        outboundIntentId: 'intent1',
      },
      audioConstraints: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      rtcConstraints: {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      },
    });
    expect(mediaMock.getUserMedia).not.toHaveBeenCalled();
    expect(current!.error).toContain('31402');
  });

  it('accepts an inbound call with default microphone constraints', async () => {
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
      accept: vi.fn(),
      parameters: { From: '+15552223333' },
    };

    act(() => {
      device.emit('incoming', call);
    });

    await act(async () => {
      await current!.accept();
    });

    expect(call.accept).toHaveBeenCalledWith({
      audioConstraints: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      rtcConstraints: {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      },
    });
    expect(current!.incoming).toBeNull();
  });

  describe('on an Android phone', () => {
    function androidInputs(...labels: string[]) {
      const devices = ['default', ...labels].map((label, i) => ({
        kind: 'audioinput',
        label: label === 'default' ? '' : label,
        deviceId: label === 'default' ? 'default' : `id-${i}`,
        groupId: '',
      }));
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: mediaMock.getUserMedia,
          enumerateDevices: vi.fn().mockResolvedValue(devices),
        },
      });
    }

    async function initDevice() {
      render(<Harness onChange={(voice) => (current = voice)} />);
      await act(async () => {
        await current!.init('pn1');
        await Promise.resolve();
      });
      const device = voiceSdkMock.instances[0];
      if (!device) throw new Error('Mock Twilio Device was not created');
      return device;
    }

    it('plays outbound call audio through the earpiece instead of the loudspeaker', async () => {
      androidInputs('Speakerphone', 'Headset earpiece');
      const device = await initDevice();
      device.connect.mockReturnValue({ on: vi.fn(), isMuted: vi.fn().mockReturnValue(false) });

      await act(async () => {
        await current!.makeCall('pn1', '+1 555-111-1111');
      });

      expect(device.audio.setInputDevice).toHaveBeenCalledWith('id-2');
      expect(device.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          audioConstraints: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          rtcConstraints: {
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          },
        }),
      );
    });

    it('uses the chosen route for outgoing and incoming calls and remembers it', async () => {
      androidInputs('Speakerphone', 'Headset earpiece');
      const device = await initDevice();
      device.connect.mockReturnValue({ on: vi.fn(), isMuted: vi.fn().mockReturnValue(false) });
      await act(async () => {
        await current!.selectMicrophone('id-1');
      });
      expect(current!.selectedMicrophoneId).toBe('id-1');
      expect(window.localStorage.getItem('pstn-twilio.microphone')).toBe('id-1');
      await act(async () => {
        await current!.makeCall('pn1', '+15551111111');
      });
      expect(device.audio.setInputDevice).toHaveBeenCalledWith('id-1');
      expect(device.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          audioConstraints: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        }),
      );
      act(() => current!.hangup());
      const call = { on: vi.fn(), accept: vi.fn() };
      act(() => device.emit('incoming', call));
      await act(async () => {
        await current!.accept();
      });
      expect(device.audio.setInputDevice).toHaveBeenCalledWith('id-1');
      expect(call.accept).toHaveBeenCalledWith(
        expect.objectContaining({
          audioConstraints: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        }),
      );
    });

    it('switches an active call, retains the old selection on failure, and releases capture on hangup', async () => {
      androidInputs('Speakerphone', 'Headset earpiece');
      const device = await initDevice();
      device.connect.mockReturnValue({ on: vi.fn(), isMuted: vi.fn().mockReturnValue(false) });
      await act(async () => {
        await current!.makeCall('pn1', '+15551111111');
      });
      await act(async () => {
        await current!.selectMicrophone('id-1');
      });
      expect(device.audio.setInputDevice).toHaveBeenCalledWith('id-1');
      device.audio.setInputDevice.mockRejectedValueOnce(new Error('Microphone is busy'));
      await act(async () => {
        await current!.selectMicrophone('id-2');
      });
      expect(current!.selectedMicrophoneId).toBe('id-1');
      expect(current!.microphoneError).toBe('Microphone is busy');
      act(() => current!.hangup());
      expect(device.audio.unsetInputDevice).toHaveBeenCalled();
    });

    it('uses setInputDevice for Automatic with a headset during a live call', async () => {
      androidInputs('Speakerphone', 'Headset earpiece', 'Bluetooth headset');
      const device = await initDevice();
      device.connect.mockReturnValue({ on: vi.fn() });
      await act(async () => {
        await current!.makeCall('pn1', '+15304419961');
        await current!.selectMicrophone('id-1');
        await current!.selectMicrophone('');
      });
      expect(current!.microphoneError).toBeNull();
      expect(device.audio.setInputDevice).toHaveBeenLastCalledWith('default');
      expect(device.audio.unsetInputDevice).not.toHaveBeenCalled();
    });

    it('does not silently substitute a missing microphone', async () => {
      androidInputs('Speakerphone', 'Headset earpiece');
      const device = await initDevice();
      await act(async () => {
        await current!.selectMicrophone('id-1');
      });
      androidInputs('Headset earpiece');
      // The remaining device gets a different id in a real device-change event.
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: mediaMock.getUserMedia,
          enumerateDevices: vi.fn().mockResolvedValue([]),
        },
      });
      await act(async () => {
        await current!.makeCall('pn1', '+15551111111');
      });
      expect(device.connect).not.toHaveBeenCalled();
      expect(current!.error).toContain('selected microphone is unavailable');
    });

    it('answers inbound calls on the earpiece too', async () => {
      androidInputs('Speakerphone', 'Headset earpiece');
      const device = await initDevice();
      const call = { on: vi.fn(), isMuted: vi.fn().mockReturnValue(false), accept: vi.fn() };
      act(() => device.emit('incoming', call));

      await act(async () => {
        await current!.accept();
      });

      expect(device.audio.setInputDevice).toHaveBeenCalledWith('id-2');
      expect(call.accept).toHaveBeenCalledWith(
        expect.objectContaining({
          rtcConstraints: {
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          },
        }),
      );
    });

    it('leaves a connected headset in charge of call audio', async () => {
      androidInputs('Speakerphone', 'Headset earpiece', 'Bluetooth headset');
      const device = await initDevice();
      device.connect.mockReturnValue({ on: vi.fn(), isMuted: vi.fn().mockReturnValue(false) });

      await act(async () => {
        await current!.makeCall('pn1', '+1 555-111-1111');
      });

      const { rtcConstraints } = device.connect.mock.calls[0]![0] as {
        rtcConstraints: { audio: MediaTrackConstraints };
      };
      expect(rtcConstraints.audio).not.toHaveProperty('deviceId');
    });

    it('does not answer a call the caller abandoned while choosing the earpiece', async () => {
      androidInputs('Speakerphone', 'Headset earpiece');
      const device = await initDevice();
      const handlers = new Map<string, () => void>();
      const call = {
        on: vi.fn((event: string, handler: () => void) => handlers.set(event, handler)),
        isMuted: vi.fn().mockReturnValue(false),
        accept: vi.fn(),
      };
      act(() => device.emit('incoming', call));

      await act(async () => {
        const accepting = current!.accept();
        handlers.get('cancel')?.();
        await accepting;
      });

      expect(call.accept).not.toHaveBeenCalled();
      expect(device.audio.unsetInputDevice).toHaveBeenCalled();
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

  it('tracks live call quality samples and warnings until the call ends', async () => {
    render(<Harness onChange={(voice) => (current = voice)} />);

    await act(async () => {
      await current!.init('pn1');
      await Promise.resolve();
    });

    const device = voiceSdkMock.instances[0];
    if (!device) throw new Error('Mock Twilio Device was not created');
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const call = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
      }),
      isMuted: vi.fn().mockReturnValue(false),
    };
    device.connect.mockReturnValue(call);

    await act(async () => {
      await current!.makeCall('pn1', '+1 555-111-1111');
    });

    act(() => {
      handlers.get('sample')?.({
        rtt: 412,
        jitter: 18.4,
        packetsLostFraction: 2.5,
        mos: 3.4,
        codecName: 'opus',
      });
      handlers.get('warning')?.('high-rtt', null);
      handlers.get('warning')?.('high-packet-loss', null);
      handlers.get('warning')?.('high-rtt', null);
    });

    expect(current!.callQuality).toEqual({
      rttMs: 412,
      jitterMs: 18.4,
      packetLossPct: 2.5,
      mos: 3.4,
      codec: 'opus',
    });
    expect(current!.qualityWarnings).toEqual(['high-rtt', 'high-packet-loss']);

    act(() => handlers.get('warning-cleared')?.('high-rtt'));
    expect(current!.qualityWarnings).toEqual(['high-packet-loss']);

    act(() => handlers.get('disconnect')?.());
    expect(current!.callQuality).toBeNull();
    expect(current!.qualityWarnings).toEqual([]);
  });

  it('handles Twilio 31401 user media denied error and marks micPermission as denied', async () => {
    render(<Harness onChange={(voice) => (current = voice)} />);

    await act(async () => {
      await current!.init('pn1');
      await Promise.resolve();
    });

    const device = voiceSdkMock.instances[0];
    expect(device).toBeDefined();
    if (!device) throw new Error('Mock Twilio Device was not created');
    device.connect.mockRejectedValue(
      Object.assign(new Error('The browser or end-user denied permissions to user media.'), {
        code: 31401,
      }),
    );

    await act(async () => {
      await current!.makeCall('pn1', '+1 555-111-1111');
      await Promise.resolve();
    });

    expect(current!.error).toContain('31401');
    expect(current!.error).toContain('Microphone permission was denied');
    expect(current!.micPermission).toBe('denied');

    // Subsequent makeCall should be guarded immediately without creating another outbound intent
    vi.mocked(api.voice.prepareOutbound).mockClear();
    await act(async () => {
      await current!.makeCall('pn1', '+1 555-111-1111');
      await Promise.resolve();
    });
    expect(api.voice.prepareOutbound).not.toHaveBeenCalled();
    expect(current!.error).toContain('31401');
  });

  it('requests microphone permission successfully via requestMicPermission', async () => {
    render(<Harness onChange={(voice) => (current = voice)} />);

    await act(async () => {
      const granted = await current!.requestMicPermission();
      expect(granted).toBe(true);
    });

    expect(mediaMock.getUserMedia).toHaveBeenCalled();
    expect(mediaMock.stopTrack).toHaveBeenCalled();
    expect(current!.micPermission).toBe('granted');
  });

  it('marks micPermission as denied when requestMicPermission fails', async () => {
    mediaMock.getUserMedia.mockRejectedValueOnce(
      Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }),
    );
    render(<Harness onChange={(voice) => (current = voice)} />);

    await act(async () => {
      const granted = await current!.requestMicPermission();
      expect(granted).toBe(false);
    });

    expect(current!.micPermission).toBe('denied');
    expect(current!.error).toContain('31401');
  });

  it('shows reconnecting and swaps in a fresh device when signaling stalls after returning to the tab', async () => {
    render(<Harness onChange={(voice) => (current = voice)} />);

    await act(async () => {
      await current!.init('pn1');
      await Promise.resolve();
    });

    const device = voiceSdkMock.instances[0];
    if (!device) throw new Error('Mock Twilio Device was not created');
    expect(current!.reconnecting).toBe(false);

    act(() => {
      device.state = 'registering';
      device.emit('registering');
    });
    expect(current!.registered).toBe(false);
    expect(current!.reconnecting).toBe(true);

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(3_999);
    });
    expect(voiceSdkMock.instances).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(device.destroy).toHaveBeenCalledTimes(1);
    expect(voiceSdkMock.instances).toHaveLength(2);
    expect(voiceSdkMock.instances[1]!.register).toHaveBeenCalledTimes(1);
    expect(current!.registered).toBe(true);
    expect(current!.reconnecting).toBe(false);
  });

  it('leaves a device alone when the SDK recovers within the resume grace period', async () => {
    render(<Harness onChange={(voice) => (current = voice)} />);

    await act(async () => {
      await current!.init('pn1');
      await Promise.resolve();
    });

    const device = voiceSdkMock.instances[0];
    if (!device) throw new Error('Mock Twilio Device was not created');

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      device.emit('registering');
      await vi.advanceTimersByTimeAsync(1_500);
      device.emit('registered');
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(device.destroy).not.toHaveBeenCalled();
    expect(voiceSdkMock.instances).toHaveLength(1);
    expect(current!.registered).toBe(true);
  });

  it('retries device creation after a failed token request, immediately once the network is back', async () => {
    vi.mocked(api.voice.token).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<Harness onChange={(voice) => (current = voice)} />);

    await act(async () => {
      await current!.init('pn1');
    });
    expect(voiceSdkMock.instances).toHaveLength(0);
    expect(current!.error).toContain('Failed to fetch');

    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(api.voice.token).toHaveBeenCalledTimes(2);
    expect(voiceSdkMock.instances).toHaveLength(1);
    expect(current!.registered).toBe(true);
  });
});
