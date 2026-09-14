import type { OutboundCallPreparationDto } from '@pstn-twilio/shared';
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

type MicPermission = 'unknown' | 'granted' | 'denied' | 'prompt';

// Network quality of the live call, from the SDK's once-a-second WebRTC sample.
export interface CallQuality {
  rttMs: number | null;
  jitterMs: number | null;
  // Share of inbound packets lost over the last sample, 0-100.
  packetLossPct: number | null;
  mos: number | null;
  codec: string | null;
}

type RtcSample = {
  rtt?: unknown;
  jitter?: unknown;
  packetsLostFraction?: unknown;
  mos?: unknown;
  codecName?: unknown;
};

export interface MakeCallOptions {
  // Whether Twilio records the call. Left unset, the API records it.
  recordCall?: boolean;
  // Called once the API has authorized the call, before the Device connects.
  onPrepared?: (prepared: OutboundCallPreparationDto) => void;
}

type VoiceRuntimeState = {
  ready: boolean;
  registered: boolean;
  // Not registered right now, but this Device was before: signaling is being
  // restored rather than set up for the first time.
  reconnecting: boolean;
  incoming: IncomingCall | null;
  active: boolean;
  connectionState: ConnectionState;
  identity: string | null;
  error: string | null;
  isMuted: boolean;
  canSendDigits: boolean;
  micPermission: MicPermission;
  callQuality: CallQuality | null;
  // Active SDK call-quality warnings, e.g. 'high-rtt' or 'high-packet-loss'.
  qualityWarnings: string[];
};

interface UseVoiceDevice extends VoiceRuntimeState {
  init: (numberId?: string) => Promise<{ identity: string; expiresAt: string } | null>;
  destroy: () => void;
  micPermission: MicPermission;
  browserSupported: boolean;
  accept: () => void;
  reject: () => void;
  hangup: () => void;
  toggleMute: () => void;
  sendDigits: (digits: string) => void;
  makeCall: (
    selectedNumberId: string,
    destinationNumber: string,
    options?: MakeCallOptions,
  ) => Promise<VoiceCall | null>;
  requestMicPermission: () => Promise<boolean>;
}

const INITIAL_RUNTIME_STATE: VoiceRuntimeState = {
  ready: false,
  registered: false,
  reconnecting: false,
  incoming: null,
  active: false,
  connectionState: 'idle',
  identity: null,
  error: null,
  isMuted: false,
  canSendDigits: false,
  micPermission: 'unknown',
  callQuality: null,
  qualityWarnings: [],
};

const NO_CALL_QUALITY = { callQuality: null, qualityWarnings: [] as string[] };

const RECONNECTABLE_ERROR_CODES = new Set([
  20101, 20104, 31005, 31009, 31203, 31204, 31205, 31207, 53001,
]);
// Codes meaning Twilio rejected the current access token, so recovery needs a
// fresh one. Transport errors (31005/31009) do not: the SDK re-sends its stored
// token when the signaling socket reopens.
const TOKEN_ERROR_CODES = new Set([20101, 20104, 31202, 31204, 31205]);
// Signaling drops the SDK recovers from on its own. An active call survives
// them for up to maxCallSignalingTimeoutMs; 'disconnect' fires if it cannot.
const TRANSIENT_SIGNALING_CODES = new Set([31005, 31009, 53001]);
const TOKEN_REFRESH_WINDOW_MS = 2 * 60_000;
// The Voice SDK keeps a lost signaling connection on its current edge for up
// to 30 seconds before it begins the configured edge fallback. Do not recreate
// the Device at that boundary: doing so resets the edge list and repeatedly
// sends the browser back to the failing first edge. Eight retries reaches 75
// seconds (1 + 2 + 4 + 8 + 15 + 15 + 15 + 15), leaving room for that fallback
// and its backoff before the app uses a last-resort fresh Device.
const MAX_STALLED_REGISTRATION_RECONNECT_ATTEMPTS = 8;
// On returning to the tab or the network, the SDK normally restores signaling
// within a second or two. If it has not by then, replace the Device instead of
// waiting out the stalled-registration schedule above.
const RESUME_RECOVERY_GRACE_MS = 4_000;
const DTMF_DIGITS_PATTERN = /^[0-9*#w]+$/;
// The browser's full voice processing. Echo cancellation stops the callee
// hearing themselves through the user's speakers; automatic gain keeps a
// quiet microphone audible; noise suppression removes background hiss.
const DEFAULT_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};
// Chrome on Android lists these synthetic microphones, and choosing one routes
// the whole call (microphone and playback) to that Android communication
// device. Without a request it picks a connected headset, else the
// loudspeaker, whose sound the phone's microphone picks back up as echo.
const ANDROID_EARPIECE_INPUT_LABEL = 'Headset earpiece';
const ANDROID_HEADSET_INPUT_LABELS = new Set(['Wired headset', 'Bluetooth headset', 'USB audio']);

const subscribers = new Set<() => void>();

const runtime: {
  state: VoiceRuntimeState;
  device: VoiceDevice | null;
  call: VoiceCall | null;
  lastNumberId: string | undefined;
  expiresAt: string | null;
  tokenRefreshTimer: ReturnType<typeof setTimeout> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  resumeTimer: ReturnType<typeof setTimeout> | null;
  // Set while a failed Device creation is waiting to be retried.
  initRetry: { numberId: string | undefined } | null;
  hasRegistered: boolean;
  currentInit: Promise<{ identity: string; expiresAt: string } | null> | null;
  currentInitNumberId: string | undefined;
  intentionallyDestroyed: boolean;
  registering: boolean;
  reconnectAttempt: number;
  signalingRecoveryPending: boolean;
  tokenRejected: boolean;
} = {
  state: INITIAL_RUNTIME_STATE,
  device: null,
  call: null,
  lastNumberId: undefined,
  expiresAt: null,
  tokenRefreshTimer: null,
  reconnectTimer: null,
  resumeTimer: null,
  initRetry: null,
  hasRegistered: false,
  currentInit: null,
  currentInitNumberId: undefined,
  intentionallyDestroyed: false,
  registering: false,
  reconnectAttempt: 0,
  signalingRecoveryPending: false,
  tokenRejected: false,
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
  const next = { ...runtime.state, ...patch };
  next.reconnecting = !next.registered && runtime.hasRegistered;
  runtime.state = next;
  emit();
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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

function isMicDeniedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = getVoiceErrorCode(err);
  if (code === 31401) return true;
  if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') return true;
  const msg = (err.message ?? '').toLowerCase();
  return (
    msg.includes('31401') ||
    msg.includes('denied permissions to user media') ||
    msg.includes('permission denied')
  );
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
  if (code === 31009) {
    return 'Twilio transport is unavailable (31009). The device is reconnecting through its configured signaling edges.';
  }
  if (code === 31000) {
    return 'Twilio reported a generic Voice SDK setup error (31000). Run Twilio sync/diagnostics; this usually means the TwiML App Voice URL or outbound webhook response is wrong.';
  }
  if (code === 31401 || isMicDeniedError(err)) {
    return 'Microphone permission was denied (31401). The browser or user blocked microphone access. Please allow microphone permissions in your browser settings (click the lock or tune icon next to the address bar) and try again.';
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
  const safeConfig: Record<string, unknown> = {};
  const codecPreferences = config.codecPreferences;
  const edge = config.edge;

  if (
    Array.isArray(codecPreferences) &&
    codecPreferences.every((codec) => codec === 'opus' || codec === 'pcmu')
  ) {
    safeConfig.codecPreferences = [...codecPreferences];
  }
  if (
    typeof edge === 'string' ||
    (Array.isArray(edge) &&
      edge.length > 0 &&
      edge.every((candidate) => typeof candidate === 'string'))
  ) {
    safeConfig.edge = Array.isArray(edge) ? [...edge] : edge;
  }

  for (const option of ['dscp', 'closeProtection', 'enableImprovedSignalingErrorPrecision']) {
    if (typeof config[option] === 'boolean') safeConfig[option] = config[option];
  }
  if (typeof config.logLevel === 'number' && Number.isInteger(config.logLevel)) {
    safeConfig.logLevel = config.logLevel;
  }
  if (
    typeof config.tokenRefreshMs === 'number' &&
    Number.isInteger(config.tokenRefreshMs) &&
    config.tokenRefreshMs >= 1_000
  ) {
    safeConfig.tokenRefreshMs = config.tokenRefreshMs;
  }
  if (
    typeof config.maxCallSignalingTimeoutMs === 'number' &&
    Number.isInteger(config.maxCallSignalingTimeoutMs) &&
    config.maxCallSignalingTimeoutMs >= 0 &&
    config.maxCallSignalingTimeoutMs <= 30_000
  ) {
    safeConfig.maxCallSignalingTimeoutMs = config.maxCallSignalingTimeoutMs;
  }

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
  runtime.signalingRecoveryPending = false;
  runtime.hasRegistered = true;
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
  clearTimer(runtime.resumeTimer);
  runtime.tokenRefreshTimer = null;
  runtime.reconnectTimer = null;
  runtime.resumeTimer = null;
  runtime.initRetry = null;
  runtime.registering = false;
  runtime.reconnectAttempt = 0;
  runtime.signalingRecoveryPending = false;
  runtime.tokenRejected = false;
  runtime.call = null;

  // Detach first so the old Device's teardown events (unregistered, error)
  // fail the `runtime.device !== device` guard and cannot leak into the next
  // Device, e.g. when switching to another phone number.
  const device = runtime.device;
  runtime.device = null;
  try {
    device?.destroy?.();
  } catch {
    /* noop */
  }

  runtime.lastNumberId = undefined;
  runtime.expiresAt = null;
  runtime.currentInit = null;
  runtime.currentInitNumberId = undefined;

  if (resetState) {
    runtime.hasRegistered = false;
    runtime.state = {
      ...INITIAL_RUNTIME_STATE,
      micPermission: runtime.state.micPermission,
    };
    emit();
  }
}

// Microphone constraints for a call. On an Android phone with no headset this
// requests the earpiece, so the other party is heard through the top speaker
// held to the ear. Everywhere else the browser's default device is kept.
async function callAudioConstraints(): Promise<MediaTrackConstraints> {
  let inputs: MediaDeviceInfo[] = [];
  try {
    const devices = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
    inputs = devices.filter((device) => device.kind === 'audioinput');
  } catch {
    return DEFAULT_AUDIO_CONSTRAINTS;
  }
  if (inputs.some((device) => ANDROID_HEADSET_INPUT_LABELS.has(device.label))) {
    return DEFAULT_AUDIO_CONSTRAINTS;
  }
  const earpiece = inputs.find((device) => device.label === ANDROID_EARPIECE_INPUT_LABEL);
  if (!earpiece?.deviceId) return DEFAULT_AUDIO_CONSTRAINTS;
  // `ideal` rather than `exact`: if the earpiece disappears, fall back to
  // another microphone instead of failing the call.
  return { ...DEFAULT_AUDIO_CONSTRAINTS, deviceId: { ideal: earpiece.deviceId } };
}

async function refreshVoiceToken(numberId: string | undefined): Promise<void> {
  const device = runtime.device;
  if (!device) return;

  const next = await api.voice.token(numberId);
  device.updateToken?.(next.token);
  runtime.expiresAt = next.expiresAt;
  runtime.tokenRejected = false;
  setRuntimeState({ identity: next.identity });
  scheduleTokenRefresh(next.expiresAt, numberId);
}

function tokenNeedsRefresh(): boolean {
  if (runtime.tokenRejected || !runtime.expiresAt) return true;
  return new Date(runtime.expiresAt).getTime() - Date.now() < TOKEN_REFRESH_WINDOW_MS;
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

    // Only push a new token when the current one is expiring or was rejected.
    // Device.updateToken() publishes on the signaling socket; while that socket
    // is down the SDK emits 31009, which would re-trigger this reconnect loop.
    if (tokenNeedsRefresh()) {
      try {
        await refreshVoiceToken(numberId);
      } catch (err) {
        setRuntimeState({ error: formatVoiceError(err) });
        scheduleReconnect(numberId);
        return;
      }
    }

    const refreshedState = getDeviceRegistrationState(device);
    if (refreshedState === 'registered' && !runtime.signalingRecoveryPending) {
      markDeviceRegistered();
      return;
    }
    if (refreshedState === 'registering' || runtime.signalingRecoveryPending) {
      if (runtime.reconnectAttempt >= MAX_STALLED_REGISTRATION_RECONNECT_ATTEMPTS) {
        // The SDK did not emit a real signaling recovery event during its
        // 30-second recovery window. Device.state can remain "registered" while
        // its WebSocket is unusable, so it is not evidence that recovery worked.
        // A new Device creates a fresh signaling stream without interrupting an
        // active call.
        if (!runtime.state.active) {
          disposeCurrentDevice(false);
          await initVoiceDevice(numberId, isBrowserSupported());
          return;
        }
      }
      scheduleReconnect(numberId);
      return;
    }

    await registerCurrentDevice(numberId);
  }, delay);
}

// scheduleReconnect() needs a Device to recover. When creating one failed
// (e.g. the token request ran before the network was back), retry creation.
function scheduleInitRetry(numberId: string | undefined): void {
  if (runtime.intentionallyDestroyed || runtime.device || runtime.reconnectTimer) return;

  const delay = Math.min(15_000, 1_000 * 2 ** Math.min(runtime.reconnectAttempt, 4));
  runtime.reconnectAttempt += 1;
  runtime.initRetry = { numberId };

  runtime.reconnectTimer = setTimeout(() => {
    runtime.reconnectTimer = null;
    runtime.initRetry = null;
    if (runtime.intentionallyDestroyed || runtime.device) return;
    void initVoiceDevice(numberId, isBrowserSupported());
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
    ...NO_CALL_QUALITY,
  });

  conn.on?.('ringing', () => setRuntimeState({ connectionState: 'ringing' }));
  conn.on?.('sample', (sample) => {
    if (runtime.call !== conn) return;
    const s = (sample ?? {}) as RtcSample;
    setRuntimeState({
      callQuality: {
        rttMs: finiteOrNull(s.rtt),
        jitterMs: finiteOrNull(s.jitter),
        packetLossPct: finiteOrNull(s.packetsLostFraction),
        mos: finiteOrNull(s.mos),
        codec: typeof s.codecName === 'string' ? s.codecName : null,
      },
    });
  });
  conn.on?.('warning', (name) => {
    if (runtime.call !== conn || typeof name !== 'string') return;
    if (runtime.state.qualityWarnings.includes(name)) return;
    setRuntimeState({ qualityWarnings: [...runtime.state.qualityWarnings, name] });
  });
  conn.on?.('warning-cleared', (name) => {
    if (runtime.call !== conn || typeof name !== 'string') return;
    setRuntimeState({
      qualityWarnings: runtime.state.qualityWarnings.filter((warning) => warning !== name),
    });
  });
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
      ...NO_CALL_QUALITY,
    });
  });
  conn.on?.('cancel', () => {
    runtime.call = null;
    setRuntimeState({
      connectionState: 'closed',
      active: false,
      canSendDigits: false,
      ...NO_CALL_QUALITY,
    });
  });
  conn.on?.('reject', () => {
    runtime.call = null;
    setRuntimeState({
      connectionState: 'closed',
      active: false,
      canSendDigits: false,
      ...NO_CALL_QUALITY,
    });
  });
  conn.on?.('reconnecting', (err) =>
    setRuntimeState({
      error: err ? formatVoiceError(err) : 'Call connection lost. Reconnecting…',
    }),
  );
  conn.on?.('reconnected', () => setRuntimeState({ error: null }));
  conn.on?.('error', (err) => {
    const code = getVoiceErrorCode(err) ?? 0;
    const isDenied = isMicDeniedError(err);
    if (TRANSIENT_SIGNALING_CODES.has(code)) {
      // Keep the call usable (hangup, mute, DTMF) while the SDK restores
      // signaling; the 'disconnect' handler cleans up if recovery fails.
      setRuntimeState({ error: formatVoiceError(err) });
    } else {
      runtime.call = null;
      setRuntimeState({
        error: formatVoiceError(err),
        active: false,
        connectionState: 'closed',
        canSendDigits: false,
        ...NO_CALL_QUALITY,
        ...(isDenied ? { micPermission: 'denied' as const } : {}),
      });
    }
    if (TOKEN_ERROR_CODES.has(code)) runtime.tokenRejected = true;
    if (RECONNECTABLE_ERROR_CODES.has(code)) {
      runtime.signalingRecoveryPending = true;
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
    runtime.signalingRecoveryPending = true;
    setRuntimeState({ ready: false, registered: false });
    scheduleReconnect(numberId);
  });

  // These are emitted by the Voice SDK while it restores a dropped signaling
  // connection. They are the only positive confirmation that a transport error
  // has recovered; `device.state` may still say "registered" while its
  // WebSocket is unavailable.
  device.on('reconnecting', () => {
    if (runtime.device !== device) return;
    runtime.signalingRecoveryPending = true;
    markDeviceRegistering();
    scheduleReconnect(numberId);
  });

  device.on('reconnected', () => {
    if (runtime.device !== device) return;
    markDeviceRegistered();
  });

  // The SDK can destroy itself (e.g. on page lifecycle events). Only an
  // intentional dispose should leave the softphone without a Device.
  device.on('destroyed', () => {
    if (runtime.device !== device || runtime.intentionallyDestroyed) return;
    disposeCurrentDevice(false);
    void initVoiceDevice(numberId, isBrowserSupported());
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
    const isDenied = isMicDeniedError(err);
    setRuntimeState({
      error: formatVoiceError(err),
      ...(isDenied ? { micPermission: 'denied' as const } : {}),
    });
    if (TOKEN_ERROR_CODES.has(code ?? 0)) runtime.tokenRejected = true;
    if (RECONNECTABLE_ERROR_CODES.has(code ?? 0)) {
      runtime.signalingRecoveryPending = true;
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
    if (runtime.initRetry) {
      clearTimer(runtime.reconnectTimer);
      runtime.reconnectTimer = null;
      runtime.initRetry = null;
    }
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
      if (runtime.device) scheduleReconnect(numberId);
      else scheduleInitRetry(numberId);
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
  options: MakeCallOptions = {},
): Promise<VoiceCall | null> {
  if (runtime.state.micPermission === 'denied') {
    setRuntimeState({
      error:
        'Microphone permission was denied (31401). The browser or user blocked microphone access. Please allow microphone permissions in your browser settings (click the lock or tune icon next to the address bar) and try again.',
    });
    return null;
  }

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
    prepared = await api.voice.prepareOutbound(
      selectedNumberId,
      destinationNumber,
      options.recordCall,
    );
  } catch (err) {
    setRuntimeState({ error: err instanceof Error ? err.message : String(err) });
    return null;
  }
  options.onPrepared?.(prepared);

  const device = await ensureDeviceForOutbound(prepared.selectedNumberId, prepared.identity);
  if (!device) {
    setRuntimeState({
      error: 'Voice device could not initialize with Twilio. It will keep retrying automatically.',
    });
    scheduleReconnect(prepared.selectedNumberId);
    return null;
  }

  try {
    const audio = await callAudioConstraints();
    const result = device.connect({
      params: {
        selectedNumberId: prepared.selectedNumberId,
        destinationNumber: prepared.destinationNumber,
        outboundIntentId: prepared.outboundIntentId,
      },
      audioConstraints: audio,
      rtcConstraints: { audio },
    });
    const conn = isPromiseLike(result) ? await result : result;
    attachCallListeners(conn);
    return conn;
  } catch (err) {
    const isDenied = isMicDeniedError(err);
    setRuntimeState({
      error: formatVoiceError(err),
      ...(isDenied ? { micPermission: 'denied' as const } : {}),
    });
    if (RECONNECTABLE_ERROR_CODES.has(getVoiceErrorCode(err) ?? 0)) {
      scheduleReconnect(prepared.selectedNumberId);
    }
    return null;
  }
}

async function acceptIncomingCall(): Promise<void> {
  const conn = runtime.state.incoming?.connection;
  if (!conn) return;
  if (runtime.state.micPermission === 'denied') {
    setRuntimeState({
      error:
        'Microphone permission was denied (31401). The browser or user blocked microphone access. Please allow microphone permissions in your browser settings (click the lock or tune icon next to the address bar) and try again.',
    });
    return;
  }
  try {
    const audio = await callAudioConstraints();
    // The caller may have hung up while the devices were being listed.
    if (runtime.state.incoming?.connection !== conn) return;
    attachCallListeners(conn);
    conn.accept?.({ audioConstraints: audio, rtcConstraints: { audio } });
    setRuntimeState({ incoming: null });
  } catch (err) {
    const isDenied = isMicDeniedError(err);
    setRuntimeState({
      error: formatVoiceError(err),
      ...(isDenied ? { micPermission: 'denied' as const } : {}),
    });
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
      ...NO_CALL_QUALITY,
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

async function requestMicrophonePermission(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    setRuntimeState({
      micPermission: 'denied',
      error: 'This browser cannot start microphone media for WebRTC calls.',
    });
    return false;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: DEFAULT_AUDIO_CONSTRAINTS });
    stream.getTracks().forEach((track) => track.stop());
    setRuntimeState({
      micPermission: 'granted',
      error:
        runtime.state.error?.includes('31401') || runtime.state.error?.includes('Microphone')
          ? null
          : runtime.state.error,
    });
    return true;
  } catch (err) {
    setRuntimeState({
      micPermission: 'denied',
      error: formatVoiceError(
        Object.assign(err instanceof Error ? err : new Error(String(err)), { code: 31401 }),
      ),
    });
    return false;
  }
}

let recoveryListenersInstalled = false;

function replaceStalledDevice(): void {
  runtime.resumeTimer = null;
  if (runtime.intentionallyDestroyed || !runtime.device || runtime.state.registered) return;
  if (runtime.state.active || runtime.currentInit) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  const numberId = runtime.lastNumberId;
  disposeCurrentDevice(false);
  void initVoiceDevice(numberId, isBrowserSupported());
}

function recoverNow(): void {
  if (runtime.intentionallyDestroyed) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  // A signaling socket that died while the tab was in the background can still
  // read as registered for a moment after it returns, so check again shortly.
  if (runtime.device && !runtime.resumeTimer) {
    runtime.resumeTimer = setTimeout(replaceStalledDevice, RESUME_RECOVERY_GRACE_MS);
  }
  if (runtime.state.registered) return;
  // Back online or visible again: retry now instead of waiting out the backoff.
  if (runtime.initRetry) {
    const { numberId } = runtime.initRetry;
    clearTimer(runtime.reconnectTimer);
    runtime.reconnectTimer = null;
    runtime.initRetry = null;
    runtime.reconnectAttempt = 0;
    void initVoiceDevice(numberId, isBrowserSupported());
    return;
  }
  if (!runtime.device) return;
  clearTimer(runtime.reconnectTimer);
  runtime.reconnectTimer = null;
  runtime.reconnectAttempt = 0;
  scheduleReconnect(runtime.lastNumberId);
}

function installRecoveryListeners(): void {
  if (recoveryListenersInstalled || typeof window === 'undefined') return;
  recoveryListenersInstalled = true;
  window.addEventListener('online', recoverNow);
  window.addEventListener('pageshow', recoverNow);
  document.addEventListener('visibilitychange', recoverNow);
  // voice-sdk 2.18.4 can reject an internal re-register after a signaling drop
  // (fixed upstream in 2.18.5, not yet on npm). Recover instead of surfacing
  // an unhandled rejection.
  window.addEventListener('unhandledrejection', (event) => {
    const code = getVoiceErrorCode(event.reason);
    if (!code || !RECONNECTABLE_ERROR_CODES.has(code) || !runtime.device) return;
    event.preventDefault();
    runtime.signalingRecoveryPending = true;
    scheduleReconnect(runtime.lastNumberId);
  });
}

export function useVoiceDevice(): UseVoiceDevice {
  const [snapshot, setSnapshot] = useState<VoiceRuntimeState>(runtime.state);
  const [browserSupported] = useState<boolean>(isBrowserSupported);

  useEffect(() => subscribe(() => setSnapshot(runtime.state)), []);
  useEffect(() => installRecoveryListeners(), []);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return;
    let cancelled = false;
    navigator.permissions
      .query({ name: 'microphone' as PermissionName })
      .then((status) => {
        if (cancelled) return;
        setRuntimeState({ micPermission: status.state as MicPermission });
        status.onchange = () => {
          if (!cancelled) setRuntimeState({ micPermission: status.state as MicPermission });
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
    browserSupported,
    accept: acceptIncomingCall,
    reject: rejectIncomingCall,
    hangup: hangupCall,
    toggleMute,
    sendDigits: sendDtmfDigits,
    makeCall: makeVoiceCall,
    requestMicPermission: requestMicrophonePermission,
  };
}
