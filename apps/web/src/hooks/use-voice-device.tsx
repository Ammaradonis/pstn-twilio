import { useCallback, useEffect, useState } from 'react';

import { api } from '../lib/api-client';

type ConnectionState = 'idle' | 'pending' | 'ringing' | 'open' | 'closed';

type VoiceEventHandler<TArgs extends unknown[] = unknown[]> = (
  ...args: TArgs
) => void | Promise<void>;

type VoiceCall = {
  parameters?: Record<string, string | undefined>;
  on?: (event: string, handler: VoiceEventHandler) => void;
  isMuted?: () => boolean;
  mute?: (shouldMute: boolean) => void;
  accept?: (options?: {
    audioConstraints?: MediaTrackConstraints | boolean;
    rtcConstraints?: MediaStreamConstraints;
    rtcConfiguration?: RTCConfiguration;
  }) => void;
  reject?: () => void;
  disconnect?: () => void;
  sendDigits?: (digits: string) => void;
};

type VoiceDeviceRegistrationState = 'destroyed' | 'unregistered' | 'registering' | 'registered';

type VoiceDevice = {
  on: {
    (event: 'incoming', handler: VoiceEventHandler<[VoiceCall]>): void;
    (event: string, handler: VoiceEventHandler): void;
  };
  state?: VoiceDeviceRegistrationState;
  register?: () => Promise<void> | void;
  destroy?: () => void;
  disconnectAll?: () => void;
  updateToken?: (token: string) => void;
  audio?: {
    setAudioConstraints: (constraints: MediaTrackConstraints) => Promise<void>;
  };
  connect: (options: {
    params: { selectedNumberId: string; destinationNumber: string; outboundIntentId: string };
    audioConstraints?: MediaTrackConstraints | boolean;
    rtcConstraints?: MediaStreamConstraints;
    rtcConfiguration?: RTCConfiguration;
  }) => VoiceCall | Promise<VoiceCall>;
};

type VoiceDeviceConstructor = new (token: string, options: unknown) => VoiceDevice;

type VoiceSdkError = Error & {
  code?: number;
  description?: string;
  explanation?: string;
  twilioError?: {
    code?: number;
    description?: string;
    explanation?: string;
    message?: string;
  };
};

type IncomingCall = {
  connection: VoiceCall;
  from?: string;
};

type VoiceRuntimeState = {
  ready: boolean;
  registered: boolean;
  incoming: IncomingCall | null;
  active: boolean;
  connectionState: ConnectionState;
  identity: string | null;
  error: string | null;
  isMuted: boolean;
  canSendDigits: boolean;
};

interface UseVoiceDevice extends VoiceRuntimeState {
  init: (numberId?: string) => Promise<{ identity: string; expiresAt: string } | null>;
  destroy: () => void;
  micPermission: 'unknown' | 'granted' | 'denied' | 'prompt';
  browserSupported: boolean;
  accept: () => void;
  reject: () => void;
  hangup: () => void;
  toggleMute: () => void;
  sendDigits: (digits: string) => void;
  makeCall: (selectedNumberId: string, destinationNumber: string) => Promise<VoiceCall | null>;
}

const INITIAL_RUNTIME_STATE: VoiceRuntimeState = {
  ready: false,
  registered: false,
  incoming: null,
  active: false,
  connectionState: 'idle',
  identity: null,
  error: null,
  isMuted: false,
  canSendDigits: false,
};

const RECONNECTABLE_ERROR_CODES = new Set([20101, 31005, 31203, 31204, 31205, 31207, 53001]);
const DTMF_DIGITS_PATTERN = /^[0-9*#w]+$/;
const DEFAULT_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: false,
  autoGainControl: false,
};

const subscribers = new Set<() => void>();

const runtime: {
  state: VoiceRuntimeState;
  device: VoiceDevice | null;
  call: VoiceCall | null;
  lastNumberId: string | undefined;
  expiresAt: string | null;
  tokenRefreshTimer: ReturnType<typeof setTimeout> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  currentInit: Promise<{ identity: string; expiresAt: string } | null> | null;
  currentInitNumberId: string | undefined;
  intentionallyDestroyed: boolean;
  registering: boolean;
  reconnectAttempt: number;
} = {
  state: INITIAL_RUNTIME_STATE,
  device: null,
  call: null,
  lastNumberId: undefined,
  expiresAt: null,
  tokenRefreshTimer: null,
  reconnectTimer: null,
  currentInit: null,
  currentInitNumberId: undefined,
  intentionallyDestroyed: false,
  registering: false,
  reconnectAttempt: 0,
};

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>).then === 'function';
}

function isBrowserSupported(): boolean {
  if (typeof window === 'undefined') return false;
  if (!window.RTCPeerConnection) return false;
  if (!navigator.mediaDevices?.getUserMedia) return false;
  return true;
}

function subscribe(listener: () => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

function emit(): void {
  for (const subscriber of subscribers) subscriber();
}

function setRuntimeState(patch: Partial<VoiceRuntimeState>): void {
  runtime.state = { ...runtime.state, ...patch };
  emit();
}

function callCanSendDigits(call: VoiceCall | null): boolean {
  return typeof call?.sendDigits === 'function';
}

function clearTimer(timer: ReturnType<typeof setTimeout> | null): void {
  if (timer) clearTimeout(timer);
}

function getVoiceErrorCode(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;
  const voiceError = err as VoiceSdkError;
  return voiceError.twilioError?.code ?? voiceError.code;
}

function formatVoiceError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const voiceError = err as VoiceSdkError;
  const code = getVoiceErrorCode(err);
  const explanation =
    voiceError.twilioError?.explanation ??
    voiceError.twilioError?.description ??
    voiceError.twilioError?.message ??
    voiceError.explanation ??
    voiceError.description ??
    voiceError.message;

  if (code === 20101) {
    return 'Twilio rejected the Voice access token (20101). Refresh the page to request a new token; if it persists, run the Twilio diagnostics check.';
  }
  if (code === 31005) {
    return 'Twilio signaling disconnected (31005). The device is reconnecting automatically.';
  }
  if (code === 31000) {
    return 'Twilio reported a generic Voice SDK setup error (31000). Run Twilio sync/diagnostics; this usually means the TwiML App Voice URL or outbound webhook response is wrong.';
  }
  if (code === 31402) {
    return 'Twilio could not start microphone media (31402). The app is using default audio constraints; close other apps using the microphone, select the OS default microphone, and try again.';
  }
  if (code === 53001) {
    return 'Twilio signaling disconnected (53001). The device is reconnecting automatically.';
  }

  const details = [typeof code === 'number' ? `Twilio ${code}` : null, explanation].filter(Boolean);
  return details.length > 0 ? details.join(': ') : voiceError.message;
}

function sanitizeDeviceConfig(config: Record<string, unknown>): Record<string, unknown> {
  const safeConfig = { ...config };
  delete safeConfig.audioConstraints;
  delete safeConfig.rtcConstraints;
  return safeConfig;
}

function isRegisterStateError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.includes('Attempt to register when device is in state') &&
    err.message.includes('Must be "unregistered"')
  );
}

function getDeviceRegistrationState(
  device: VoiceDevice | null,
): VoiceDeviceRegistrationState | undefined {
  return device?.state;
}

function markDeviceRegistered(): void {
  clearTimer(runtime.reconnectTimer);
  runtime.reconnectTimer = null;
  runtime.reconnectAttempt = 0;
  setRuntimeState({
    ready: true,
    registered: true,
    error: null,
  });
}

function markDeviceRegistering(): void {
  setRuntimeState({
    ready: false,
    registered: false,
  });
}

function disposeCurrentDevice(resetState: boolean): void {
  runtime.intentionallyDestroyed = true;
  clearTimer(runtime.tokenRefreshTimer);
  clearTimer(runtime.reconnectTimer);
  runtime.tokenRefreshTimer = null;
  runtime.reconnectTimer = null;
  runtime.registering = false;
  runtime.reconnectAttempt = 0;
  runtime.call = null;

  try {
    runtime.device?.destroy?.();
  } catch {
    /* noop */
  }

  runtime.device = null;
  runtime.lastNumberId = undefined;
  runtime.expiresAt = null;
  runtime.currentInit = null;
  runtime.currentInitNumberId = undefined;

  if (resetState) {
    runtime.state = INITIAL_RUNTIME_STATE;
    emit();
  }
}

async function refreshVoiceToken(numberId: string | undefined): Promise<void> {
  const device = runtime.device;
  if (!device) return;

  const next = await api.voice.token(numberId);
  device.updateToken?.(next.token);
  runtime.expiresAt = next.expiresAt;
  setRuntimeState({ identity: next.identity });
  scheduleTokenRefresh(next.expiresAt, numberId);
}

function scheduleTokenRefresh(expiresAt: string, numberId: string | undefined): void {
  clearTimer(runtime.tokenRefreshTimer);
  const expiresMs = new Date(expiresAt).getTime() - Date.now();
  const delay = Math.max(5_000, Math.min(expiresMs - 60_000, 50 * 60_000));

  runtime.tokenRefreshTimer = setTimeout(async () => {
    try {
      await refreshVoiceToken(numberId);
    } catch (err) {
      setRuntimeState({ error: formatVoiceError(err) });
      scheduleReconnect(numberId);
    }
  }, delay);
}

function scheduleReconnect(numberId: string | undefined): void {
  if (runtime.intentionallyDestroyed || !runtime.device || runtime.reconnectTimer) return;

  const delay = Math.min(15_000, 1_000 * 2 ** Math.min(runtime.reconnectAttempt, 4));
  runtime.reconnectAttempt += 1;
  markDeviceRegistering();

  runtime.reconnectTimer = setTimeout(async () => {
    runtime.reconnectTimer = null;
    const device = runtime.device;
    if (runtime.intentionallyDestroyed || !device) return;

    try {
      await refreshVoiceToken(numberId);
    } catch (err) {
      setRuntimeState({ error: formatVoiceError(err) });
      scheduleReconnect(numberId);
      return;
    }

    const state = getDeviceRegistrationState(device);
    if (state === 'registered') {
      markDeviceRegistered();
      return;
    }
    if (state === 'registering') {
      markDeviceRegistering();
      scheduleReconnect(numberId);
      return;
    }

    await registerCurrentDevice(numberId);
    if (!runtime.state.registered) scheduleReconnect(numberId);
  }, delay);
}

async function registerCurrentDevice(numberId: string | undefined): Promise<void> {
  const device = runtime.device;
  if (!device || runtime.intentionallyDestroyed || runtime.registering) return;

  const state = getDeviceRegistrationState(device);
  if (state === 'registered') {
    markDeviceRegistered();
    return;
  }
  if (state === 'registering') {
    markDeviceRegistering();
    return;
  }
  if (state && state !== 'unregistered') return;

  runtime.registering = true;
  setRuntimeState({ ready: false });
  try {
    await device.register?.();
  } catch (err) {
    if (isRegisterStateError(err)) {
      const nextState = getDeviceRegistrationState(device);
      if (nextState === 'registered') {
        markDeviceRegistered();
        return;
      }
      if (nextState === 'registering') {
        markDeviceRegistering();
        scheduleReconnect(numberId);
        return;
      }
      markDeviceRegistering();
      scheduleReconnect(numberId);
      return;
    }
    setRuntimeState({
      ready: false,
      registered: false,
      error: formatVoiceError(err),
    });
    scheduleReconnect(numberId);
  } finally {
    runtime.registering = false;
  }
}

async function ensureDeviceForOutbound(
  numberId: string,
  expectedIdentity: string,
): Promise<VoiceDevice | null> {
  if (
    runtime.device &&
    runtime.lastNumberId === numberId &&
    runtime.state.identity &&
    runtime.state.identity !== expectedIdentity
  ) {
    disposeCurrentDevice(true);
  }

  if (!runtime.device || runtime.lastNumberId !== numberId) {
    await initVoiceDevice(numberId, isBrowserSupported());
  }
  if (runtime.state.identity !== expectedIdentity) {
    setRuntimeState({
      error:
        'Voice device identity does not match the prepared outbound call. Retrying will request a fresh Twilio token.',
    });
    return null;
  }
  return runtime.device;
}

function attachCallListeners(conn: VoiceCall): void {
  runtime.call = conn;
  setRuntimeState({
    active: true,
    connectionState: 'pending',
    isMuted: Boolean(conn?.isMuted?.()),
    canSendDigits: callCanSendDigits(conn),
  });

  conn.on?.('ringing', () => setRuntimeState({ connectionState: 'ringing' }));
  conn.on?.('accept', () =>
    setRuntimeState({
      connectionState: 'open',
      active: true,
      error: null,
      canSendDigits: callCanSendDigits(conn),
    }),
  );
  conn.on?.('disconnect', () => {
    runtime.call = null;
    setRuntimeState({
      connectionState: 'closed',
      active: false,
      isMuted: false,
      canSendDigits: false,
    });
  });
  conn.on?.('cancel', () => {
    runtime.call = null;
    setRuntimeState({
      connectionState: 'closed',
      active: false,
      canSendDigits: false,
    });
  });
  conn.on?.('reject', () => {
    runtime.call = null;
    setRuntimeState({
      connectionState: 'closed',
      active: false,
      canSendDigits: false,
    });
  });
  conn.on?.('error', (err) => {
    runtime.call = null;
    setRuntimeState({
      error: formatVoiceError(err),
      active: false,
      connectionState: 'closed',
      canSendDigits: false,
    });
    if (RECONNECTABLE_ERROR_CODES.has(getVoiceErrorCode(err) ?? 0)) {
      scheduleReconnect(runtime.lastNumberId);
    }
  });
}

function attachDeviceListeners(device: VoiceDevice, numberId: string | undefined): void {
  device.on('registered', () => {
    if (runtime.device !== device) return;
    markDeviceRegistered();
  });

  device.on('unregistered', () => {
    if (runtime.device !== device) return;
    setRuntimeState({ ready: false, registered: false });
    scheduleReconnect(numberId);
  });

  device.on('tokenWillExpire', async () => {
    if (runtime.device !== device) return;
    try {
      await refreshVoiceToken(numberId);
    } catch (err) {
      setRuntimeState({ error: formatVoiceError(err) });
      scheduleReconnect(numberId);
    }
  });

  device.on('incoming', (conn: VoiceCall) => {
    if (runtime.device !== device) return;
    setRuntimeState({
      incoming: {
        connection: conn,
        from: conn.parameters?.From,
      },
    });
    conn.on?.('cancel', () => setRuntimeState({ incoming: null }));
    conn.on?.('disconnect', () => setRuntimeState({ incoming: null }));
  });

  device.on('error', (err) => {
    if (runtime.device !== device) return;
    const code = getVoiceErrorCode(err);
    setRuntimeState({ error: formatVoiceError(err) });
    if (RECONNECTABLE_ERROR_CODES.has(code ?? 0)) {
      scheduleReconnect(numberId);
    }
  });
}

async function initVoiceDevice(
  numberId: string | undefined,
  browserSupported: boolean,
): Promise<{ identity: string; expiresAt: string } | null> {
  if (!browserSupported) {
    setRuntimeState({
      error: 'This browser does not support WebRTC. Use the latest Chrome, Edge, or Firefox.',
    });
    return null;
  }

  if (runtime.device && runtime.lastNumberId === numberId) {
    const state = getDeviceRegistrationState(runtime.device);
    if (state === 'registered') {
      markDeviceRegistered();
    } else if (state !== 'registering') {
      void registerCurrentDevice(numberId);
    }
    return runtime.state.identity && runtime.expiresAt
      ? { identity: runtime.state.identity, expiresAt: runtime.expiresAt }
      : null;
  }

  if (runtime.currentInit && runtime.currentInitNumberId === numberId) {
    return runtime.currentInit;
  }

  runtime.currentInitNumberId = numberId;
  runtime.currentInit = (async () => {
    if (runtime.device) disposeCurrentDevice(true);
    runtime.intentionallyDestroyed = false;
    setRuntimeState({
      ready: false,
      registered: false,
      incoming: null,
      active: false,
      connectionState: 'idle',
      error: null,
    });

    try {
      const tokenPromise = api.voice.token(numberId);
      const sdkPromise = import('@twilio/voice-sdk') as Promise<unknown>;
      const configPromise = api.voice.deviceConfig();
      const [tokenResp, sdk, config] = await Promise.all([tokenPromise, sdkPromise, configPromise]);
      const typedSdk = sdk as {
        Device?: VoiceDeviceConstructor;
        default?: VoiceDeviceConstructor;
      };
      const Device = typedSdk.Device ?? typedSdk.default;
      if (!Device) throw new Error('Twilio Voice SDK Device export was not found');

      const device = new Device(tokenResp.token, sanitizeDeviceConfig(config));
      runtime.device = device;
      if (device.audio && typeof device.audio.setAudioConstraints === 'function') {
        try {
          await device.audio.setAudioConstraints(DEFAULT_AUDIO_CONSTRAINTS);
        } catch {
          // ignore
        }
      }
      runtime.lastNumberId = numberId;
      runtime.expiresAt = tokenResp.expiresAt;
      runtime.intentionallyDestroyed = false;
      attachDeviceListeners(device, numberId);
      setRuntimeState({ identity: tokenResp.identity });
      scheduleTokenRefresh(tokenResp.expiresAt, numberId);
      void registerCurrentDevice(numberId);
      return { identity: tokenResp.identity, expiresAt: tokenResp.expiresAt };
    } catch (err) {
      setRuntimeState({ error: formatVoiceError(err) });
      scheduleReconnect(numberId);
      return null;
    } finally {
      runtime.currentInit = null;
      runtime.currentInitNumberId = undefined;
    }
  })();

  return runtime.currentInit;
}

async function makeVoiceCall(
  selectedNumberId: string,
  destinationNumber: string,
): Promise<VoiceCall | null> {
  const initialized = await initVoiceDevice(selectedNumberId, isBrowserSupported());
  if (!initialized) {
    setRuntimeState({
      error:
        runtime.state.error ??
        'Voice device could not initialize with Twilio. It will keep retrying automatically.',
    });
    scheduleReconnect(selectedNumberId);
    return null;
  }

  let prepared;
  try {
    prepared = await api.voice.prepareOutbound(selectedNumberId, destinationNumber);
  } catch (err) {
    setRuntimeState({ error: err instanceof Error ? err.message : String(err) });
    return null;
  }

  const device = await ensureDeviceForOutbound(prepared.selectedNumberId, prepared.identity);
  if (!device) {
    setRuntimeState({
      error: 'Voice device could not initialize with Twilio. It will keep retrying automatically.',
    });
    scheduleReconnect(prepared.selectedNumberId);
    return null;
  }

  try {
    const result = device.connect({
      params: {
        selectedNumberId: prepared.selectedNumberId,
        destinationNumber: prepared.destinationNumber,
        outboundIntentId: prepared.outboundIntentId,
      },
      audioConstraints: DEFAULT_AUDIO_CONSTRAINTS,
      rtcConstraints: {
        audio: DEFAULT_AUDIO_CONSTRAINTS,
      },
    });
    const conn = isPromiseLike(result) ? await result : result;
    attachCallListeners(conn);
    return conn;
  } catch (err) {
    setRuntimeState({ error: formatVoiceError(err) });
    if (RECONNECTABLE_ERROR_CODES.has(getVoiceErrorCode(err) ?? 0)) {
      scheduleReconnect(prepared.selectedNumberId);
    }
    return null;
  }
}

async function acceptIncomingCall(): Promise<void> {
  const conn = runtime.state.incoming?.connection;
  if (!conn) return;
  try {
    attachCallListeners(conn);
    conn.accept?.({
      audioConstraints: DEFAULT_AUDIO_CONSTRAINTS,
      rtcConstraints: {
        audio: DEFAULT_AUDIO_CONSTRAINTS,
      },
    });
    setRuntimeState({ incoming: null });
  } catch (err) {
    setRuntimeState({ error: formatVoiceError(err) });
  }
}

function rejectIncomingCall(): void {
  const conn = runtime.state.incoming?.connection;
  if (!conn) return;
  try {
    conn.reject?.();
  } catch (err) {
    setRuntimeState({ error: formatVoiceError(err) });
  } finally {
    setRuntimeState({ incoming: null });
  }
}

function hangupCall(): void {
  try {
    runtime.call?.disconnect?.();
    runtime.device?.disconnectAll?.();
  } catch (err) {
    setRuntimeState({ error: formatVoiceError(err) });
  } finally {
    runtime.call = null;
    setRuntimeState({
      active: false,
      isMuted: false,
      connectionState: 'closed',
      canSendDigits: false,
    });
  }
}

function toggleMute(): void {
  const conn = runtime.call;
  if (!conn) return;
  try {
    const next = !conn.isMuted?.();
    conn.mute?.(next);
    setRuntimeState({ isMuted: next });
  } catch (err) {
    setRuntimeState({ error: formatVoiceError(err) });
  }
}

function sendDtmfDigits(digits: string): void {
  const normalized = digits.trim();
  if (!normalized) return;
  if (!DTMF_DIGITS_PATTERN.test(normalized)) {
    setRuntimeState({ error: 'DTMF digits can only contain 0-9, *, #, or wait pauses.' });
    return;
  }

  const conn = runtime.call;
  if (!conn?.sendDigits) {
    setRuntimeState({
      error: 'No active call is available for DTMF tones.',
      canSendDigits: false,
    });
    return;
  }

  try {
    conn.sendDigits(normalized);
    setRuntimeState({ error: null, canSendDigits: true });
  } catch (err) {
    setRuntimeState({ error: formatVoiceError(err) });
  }
}

export function useVoiceDevice(): UseVoiceDevice {
  const [snapshot, setSnapshot] = useState<VoiceRuntimeState>(runtime.state);
  const [micPermission, setMicPermission] = useState<UseVoiceDevice['micPermission']>('unknown');
  const [browserSupported] = useState<boolean>(isBrowserSupported);

  useEffect(() => subscribe(() => setSnapshot(runtime.state)), []);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return;
    let cancelled = false;
    navigator.permissions
      .query({ name: 'microphone' as PermissionName })
      .then((status) => {
        if (cancelled) return;
        setMicPermission(status.state as UseVoiceDevice['micPermission']);
        status.onchange = () => {
          if (!cancelled) setMicPermission(status.state as UseVoiceDevice['micPermission']);
        };
      })
      .catch(() => {
        // Permissions API not available for "microphone" on this browser; ignore.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const init = useCallback(
    (numberId?: string) => initVoiceDevice(numberId, browserSupported),
    [browserSupported],
  );

  const destroy = useCallback(() => disposeCurrentDevice(true), []);

  return {
    ...snapshot,
    init,
    destroy,
    micPermission,
    browserSupported,
    accept: acceptIncomingCall,
    reject: rejectIncomingCall,
    hangup: hangupCall,
    toggleMute,
    sendDigits: sendDtmfDigits,
    makeCall: makeVoiceCall,
  };
}
