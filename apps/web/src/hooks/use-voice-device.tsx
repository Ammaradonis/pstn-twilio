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
  accept?: () => void;
  reject?: () => void;
  disconnect?: () => void;
};

type VoiceDevice = {
  on: {
    (event: 'incoming', handler: VoiceEventHandler<[VoiceCall]>): void;
    (event: string, handler: VoiceEventHandler): void;
  };
  register?: () => Promise<void> | void;
  destroy?: () => void;
  disconnectAll?: () => void;
  updateToken?: (token: string) => void;
  connect: (options: {
    params: { selectedNumberId: string; destinationNumber: string };
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
};

const RECONNECTABLE_ERROR_CODES = new Set([20101, 31005, 31203, 31204, 31205, 31207]);

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

  const details = [typeof code === 'number' ? `Twilio ${code}` : null, explanation].filter(Boolean);
  return details.length > 0 ? details.join(': ') : voiceError.message;
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
  setRuntimeState({ ready: false, registered: false });

  runtime.reconnectTimer = setTimeout(async () => {
    runtime.reconnectTimer = null;
    if (runtime.intentionallyDestroyed || !runtime.device) return;

    try {
      await refreshVoiceToken(numberId);
    } catch (err) {
      setRuntimeState({ error: formatVoiceError(err) });
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

  runtime.registering = true;
  setRuntimeState({ ready: false });
  try {
    await device.register?.();
  } catch (err) {
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

async function ensureDeviceForOutbound(numberId: string): Promise<VoiceDevice | null> {
  if (!runtime.device || runtime.lastNumberId !== numberId) {
    await initVoiceDevice(numberId, isBrowserSupported());
  }
  return runtime.device;
}

function attachCallListeners(conn: VoiceCall): void {
  runtime.call = conn;
  setRuntimeState({
    active: true,
    connectionState: 'pending',
    isMuted: Boolean(conn?.isMuted?.()),
  });

  conn.on?.('ringing', () => setRuntimeState({ connectionState: 'ringing' }));
  conn.on?.('accept', () =>
    setRuntimeState({
      connectionState: 'open',
      active: true,
      error: null,
    }),
  );
  conn.on?.('disconnect', () => {
    runtime.call = null;
    setRuntimeState({
      connectionState: 'closed',
      active: false,
      isMuted: false,
    });
  });
  conn.on?.('cancel', () => {
    runtime.call = null;
    setRuntimeState({
      connectionState: 'closed',
      active: false,
    });
  });
  conn.on?.('reject', () => {
    runtime.call = null;
    setRuntimeState({
      connectionState: 'closed',
      active: false,
    });
  });
  conn.on?.('error', (err) => {
    runtime.call = null;
    setRuntimeState({
      error: formatVoiceError(err),
      active: false,
      connectionState: 'closed',
    });
    if (RECONNECTABLE_ERROR_CODES.has(getVoiceErrorCode(err) ?? 0)) {
      scheduleReconnect(runtime.lastNumberId);
    }
  });
}

function attachDeviceListeners(device: VoiceDevice, numberId: string | undefined): void {
  device.on('registered', () => {
    if (runtime.device !== device) return;
    clearTimer(runtime.reconnectTimer);
    runtime.reconnectTimer = null;
    runtime.reconnectAttempt = 0;
    setRuntimeState({
      ready: true,
      registered: true,
      error: null,
    });
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
    if (!runtime.state.registered) void registerCurrentDevice(numberId);
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

      const device = new Device(tokenResp.token, config);
      runtime.device = device;
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
  const device = await ensureDeviceForOutbound(selectedNumberId);
  if (!device) {
    setRuntimeState({
      error: 'Voice device could not initialize with Twilio. It will keep retrying automatically.',
    });
    scheduleReconnect(selectedNumberId);
    return null;
  }

  try {
    const result = device.connect({
      params: { selectedNumberId, destinationNumber },
    });
    const conn = isPromiseLike(result) ? await result : result;
    attachCallListeners(conn);
    return conn;
  } catch (err) {
    setRuntimeState({ error: formatVoiceError(err) });
    if (RECONNECTABLE_ERROR_CODES.has(getVoiceErrorCode(err) ?? 0)) {
      scheduleReconnect(selectedNumberId);
    }
    return null;
  }
}

function acceptIncomingCall(): void {
  const conn = runtime.state.incoming?.connection;
  if (!conn) return;
  try {
    attachCallListeners(conn);
    conn.accept?.();
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
    makeCall: makeVoiceCall,
  };
}
