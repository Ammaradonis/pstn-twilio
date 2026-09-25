import type { OutboundCallPreparationDto } from '@pstn-twilio/shared';
import { useCallback, useEffect, useState } from 'react';

import { api } from '../lib/api-client';

type ConnectionState = 'idle' | 'pending' | 'ringing' | 'open' | 'closed';

type VoiceEventHandler<TArgs extends unknown[] = unknown[]> = (
  ...args: TArgs
) => void | Promise<void>;

type VoiceCall = {
  parameters?: Record<string, string | undefined>;
  status?: () => string;
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
    setInputDevice?: (deviceId: string) => Promise<void>;
    unsetInputDevice?: () => Promise<void>;
    on?: (event: string, handler: (...args: unknown[]) => void) => void;
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
  originalError?: VoiceSdkError;
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
  recoveryFailed: boolean;
  incoming: IncomingCall | null;
  active: boolean;
  connectionState: ConnectionState;
  identity: string | null;
  error: string | null;
  callNotice: string | null;
  isMuted: boolean;
  canSendDigits: boolean;
  micPermission: MicPermission;
  callQuality: CallQuality | null;
  // Active SDK call-quality warnings, e.g. 'high-rtt' or 'high-packet-loss'.
  qualityWarnings: string[];
  microphoneInputs: Array<{ deviceId: string; label: string }>;
  selectedMicrophoneId: string;
  microphoneBusy: boolean;
  microphoneError: string | null;
  wakeLockHeld: boolean;
};

interface UseVoiceDevice extends VoiceRuntimeState {
  init: (numberId?: string) => Promise<{ identity: string; expiresAt: string } | null>;
  destroy: () => void;
  retryConnection: () => void;
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
  refreshMicrophones: () => Promise<void>;
  selectMicrophone: (deviceId: string) => Promise<void>;
  wakeLockSupported: boolean;
}

const INITIAL_RUNTIME_STATE: VoiceRuntimeState = {
  ready: false,
  registered: false,
  reconnecting: false,
  recoveryFailed: false,
  incoming: null,
  active: false,
  connectionState: 'idle',
  identity: null,
  error: null,
  callNotice: null,
  isMuted: false,
  canSendDigits: false,
  micPermission: 'unknown',
  callQuality: null,
  qualityWarnings: [],
  microphoneInputs: [],
  selectedMicrophoneId: '',
  microphoneBusy: false,
  microphoneError: null,
  wakeLockHeld: false,
};

const NO_CALL_QUALITY = { callQuality: null, qualityWarnings: [] as string[] };

const RECONNECTABLE_ERROR_CODES = new Set([
  20101, 20104, 31005, 31009, 31203, 31204, 31205, 31207, 53001,
]);
// Codes meaning Twilio rejected the current access token, so recovery needs a
// fresh one. Transport errors (31005/31009) do not: the SDK re-sends its stored
// token when the signaling socket reopens.
const TOKEN_ERROR_CODES = new Set([20101, 20104, 31202, 31204, 31205]);
// Signaling drops the SDK can recover from on its own. Preserve active-call
// controls until the SDK confirms closure or the user hangs up.
const TRANSIENT_SIGNALING_CODES = new Set([31005, 31009, 53001]);
const TOKEN_REFRESH_WINDOW_MS = 2 * 60_000;
// An idle device can safely fail over sooner than an established call. Rotate
// the edge order when replacing it, instead of repeatedly retrying edge one.
const IDLE_RECOVERY_WINDOW_MS = 8_000;
const MAX_RECOVERY_WINDOW_MS = 30_000;
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
const MICROPHONE_STORAGE_KEY = 'pstn-twilio.microphone';

type WakeLockSentinelLike = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: 'release', listener: () => void) => void;
};

type WakeLockApiLike = {
  request: (type: 'screen') => Promise<WakeLockSentinelLike>;
};

const subscribers = new Set<() => void>();
let voiceSdkPromise: Promise<unknown> | null = null;

const runtime: {
  state: VoiceRuntimeState;
  device: VoiceDevice | null;
  call: VoiceCall | null;
  lastNumberId: string | undefined;
  expiresAt: string | null;
  tokenRefreshTimer: ReturnType<typeof setTimeout> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  resumeTimer: ReturnType<typeof setTimeout> | null;
  recoveryTimer: ReturnType<typeof setTimeout> | null;
  recoveryStartedAt: number | null;
  deviceStartedAt: number;
  edgeOffset: number;
  generation: number;
  callSequence: number;
  outcomeTimer: ReturnType<typeof setTimeout> | null;
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
  wakeLock: WakeLockSentinelLike | null;
  wakeLockWanted: boolean;
  wakeLockRequest: Promise<void> | null;
} = {
  state: INITIAL_RUNTIME_STATE,
  device: null,
  call: null,
  lastNumberId: undefined,
  expiresAt: null,
  tokenRefreshTimer: null,
  reconnectTimer: null,
  resumeTimer: null,
  recoveryTimer: null,
  recoveryStartedAt: null,
  deviceStartedAt: 0,
  edgeOffset: 0,
  generation: 0,
  callSequence: 0,
  outcomeTimer: null,
  initRetry: null,
  hasRegistered: false,
  currentInit: null,
  currentInitNumberId: undefined,
  intentionallyDestroyed: false,
  registering: false,
  reconnectAttempt: 0,
  signalingRecoveryPending: false,
  tokenRejected: false,
  wakeLock: null,
  wakeLockWanted: false,
  wakeLockRequest: null,
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

function wakeLockApi(): WakeLockApiLike | null {
  if (typeof navigator === 'undefined') return null;
  return (navigator as Navigator & { wakeLock?: WakeLockApiLike }).wakeLock ?? null;
}

function releaseScreenWakeLock(): void {
  const sentinel = runtime.wakeLock;
  runtime.wakeLock = null;
  setRuntimeState({ wakeLockHeld: false });
  if (sentinel && !sentinel.released) void sentinel.release().catch(() => undefined);
}

async function syncScreenWakeLock(wanted: boolean): Promise<void> {
  runtime.wakeLockWanted = wanted;
  if (!wanted || document.visibilityState !== 'visible') {
    releaseScreenWakeLock();
    return;
  }
  const api = wakeLockApi();
  if (!api || runtime.wakeLock?.released === false) return;
  if (runtime.wakeLockRequest) return runtime.wakeLockRequest;

  runtime.wakeLockRequest = (async () => {
    try {
      const sentinel = await api.request('screen');
      if (!runtime.wakeLockWanted || document.visibilityState !== 'visible') {
        await sentinel.release().catch(() => undefined);
        return;
      }
      runtime.wakeLock = sentinel;
      setRuntimeState({ wakeLockHeld: true });
      sentinel.addEventListener?.('release', () => {
        if (runtime.wakeLock !== sentinel) return;
        runtime.wakeLock = null;
        setRuntimeState({ wakeLockHeld: false });
        if (runtime.wakeLockWanted && document.visibilityState === 'visible') {
          void syncScreenWakeLock(true);
        }
      });
    } catch {
      // Chrome can refuse a wake lock when the battery is low or the page is
      // not visible. Calls remain usable; the UI simply does not claim a lock.
      setRuntimeState({ wakeLockHeld: false });
    }
  })().finally(() => {
    runtime.wakeLockRequest = null;
  });
  return runtime.wakeLockRequest;
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
  next.reconnecting = !next.registered && !next.recoveryFailed && runtime.hasRegistered;
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

function getVoiceErrorCode(err: unknown, depth = 0): number | undefined {
  if (!err || typeof err !== 'object' || depth > 4) return undefined;
  const voiceError = err as VoiceSdkError;
  const nested = getVoiceErrorCode(voiceError.twilioError, depth + 1);
  if (nested !== undefined) return nested;
  // SDK Call._onHangup wraps unknown gateway errors in ConnectionError
  // (31005). Those are terminal call errors, not a lost signaling socket.
  if ([31000, 31005, 53000].includes(voiceError.code ?? 0)) {
    const original = getVoiceErrorCode(voiceError.originalError, depth + 1);
    if (original !== undefined) return original;
  }
  return voiceError.code;
}

function isCallHangupError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const error = err as VoiceSdkError;
  return (
    error.code === 31005 &&
    Boolean(error.originalError) &&
    error.message?.includes('Error sent from gateway in HANGUP')
  );
}

function callErrorState(err: unknown): Pick<VoiceRuntimeState, 'error' | 'callNotice'> {
  if (getVoiceErrorCode(err) === 31603) {
    return {
      error: null,
      callNotice:
        'Call declined by the destination or its carrier (31603). You can place another call.',
    };
  }
  return { error: formatVoiceError(err), callNotice: null };
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
  if (!err || typeof err !== 'object') return String(err);
  const voiceError = err as VoiceSdkError;
  const code = getVoiceErrorCode(err);
  const explanation =
    voiceError.originalError?.message ??
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
    return `Twilio reported a call error (31000). ${explanation || 'No further details were supplied.'}`;
  }
  if (code === 13224) {
    return 'Twilio could not route this destination number (13224). Check the number before trying again.';
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
  return details.length > 0 ? details.join(': ') : 'The voice SDK reported an unspecified error.';
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
  clearTimer(runtime.recoveryTimer);
  runtime.recoveryTimer = null;
  runtime.recoveryStartedAt = null;
  runtime.hasRegistered = true;
  setRuntimeState({
    ready: true,
    registered: true,
    recoveryFailed: false,
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
  runtime.generation += 1;
  runtime.callSequence += 1;
  runtime.intentionallyDestroyed = true;
  runtime.wakeLockWanted = false;
  releaseScreenWakeLock();
  clearTimer(runtime.tokenRefreshTimer);
  clearTimer(runtime.reconnectTimer);
  clearTimer(runtime.resumeTimer);
  clearTimer(runtime.recoveryTimer);
  clearTimer(runtime.outcomeTimer);
  runtime.tokenRefreshTimer = null;
  runtime.reconnectTimer = null;
  runtime.resumeTimer = null;
  runtime.recoveryTimer = null;
  runtime.outcomeTimer = null;
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
    runtime.recoveryStartedAt = null;
    runtime.edgeOffset = 0;
    runtime.hasRegistered = false;
    runtime.state = {
      ...INITIAL_RUNTIME_STATE,
      micPermission: runtime.state.micPermission,
      microphoneInputs: runtime.state.microphoneInputs,
      selectedMicrophoneId: runtime.state.selectedMicrophoneId,
    };
    emit();
  }
}

// Microphone constraints for a call. On an Android phone with no headset this
// requests the earpiece, so the other party is heard through the top speaker
// held to the ear. Everywhere else the browser's default device is kept.
async function callAudioConstraints(
  selectedId = runtime.state.selectedMicrophoneId,
): Promise<MediaTrackConstraints> {
  let inputs: MediaDeviceInfo[] = [];
  try {
    const devices = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
    inputs = devices.filter((device) => device.kind === 'audioinput');
  } catch {
    if (selectedId)
      throw new Error(
        'Could not check the selected microphone. Refresh microphones or choose Automatic.',
      );
    return DEFAULT_AUDIO_CONSTRAINTS;
  }
  if (selectedId) {
    if (!inputs.some((device) => device.deviceId === selectedId)) {
      throw new Error(
        'The selected microphone is unavailable. Choose another microphone or Automatic.',
      );
    }
    return { ...DEFAULT_AUDIO_CONSTRAINTS, deviceId: { exact: selectedId } };
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

async function refreshMicrophones(): Promise<void> {
  try {
    const devices = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
    setRuntimeState({
      microphoneInputs: devices
        .filter((device) => device.kind === 'audioinput' && device.deviceId)
        .map((device, i) => ({
          deviceId: device.deviceId,
          label: device.label || `Microphone ${i + 1}`,
        })),
    });
  } catch {
    setRuntimeState({
      microphoneError: 'Could not list microphones. Check browser permissions and try again.',
    });
  }
}

function requestedInputDevice(constraints: MediaTrackConstraints): string | undefined {
  const selected = constraints.deviceId as { exact?: string; ideal?: string } | undefined;
  return selected?.exact ?? selected?.ideal;
}

async function selectMicrophone(deviceId: string): Promise<void> {
  if (runtime.state.microphoneBusy) return;
  setRuntimeState({ microphoneBusy: true, microphoneError: null });
  try {
    const constraints = await callAudioConstraints(deviceId);
    if (runtime.state.active) {
      const audio = runtime.device?.audio;
      if (!audio?.setInputDevice)
        throw new Error(
          'This browser cannot switch microphones during a call. Try again after hanging up.',
        );
      const requestedDeviceId = requestedInputDevice(constraints);
      if (requestedDeviceId) {
        // Automatic keeps the Android earpiece policy when Chrome exposes it;
        // an attached headset is left to Chrome's default route.
        await audio.setInputDevice(requestedDeviceId);
      } else {
        // unsetInputDevice is forbidden during a live Twilio call.
        await audio.setInputDevice('default');
      }
    }
    setRuntimeState({ selectedMicrophoneId: deviceId });
    try {
      window.localStorage.setItem(MICROPHONE_STORAGE_KEY, deviceId);
    } catch {
      /* session only */
    }
  } catch (err) {
    setRuntimeState({ microphoneError: err instanceof Error ? err.message : String(err) });
  } finally {
    setRuntimeState({ microphoneBusy: false });
  }
}

function releaseMicrophone(): void {
  void runtime.device?.audio?.unsetInputDevice?.().catch(() => undefined);
}

async function prepareCallAudio(device: VoiceDevice): Promise<MediaTrackConstraints> {
  const constraints = await callAudioConstraints();
  const requestedDeviceId = requestedInputDevice(constraints);
  if (requestedDeviceId) {
    if (!device.audio?.setInputDevice) {
      if (runtime.state.selectedMicrophoneId) {
        throw new Error(
          'Chrome could not select the requested microphone. Choose Automatic and try again.',
        );
      }
      return constraints;
    }
    // Twilio recommends selecting the device before connect/accept. Passing a
    // deviceId inside rtcConstraints can race the SDK's own media acquisition.
    await device.audio.setInputDevice(requestedDeviceId);
  }
  return DEFAULT_AUDIO_CONSTRAINTS;
}

async function refreshVoiceToken(numberId: string | undefined): Promise<void> {
  const device = runtime.device;
  if (!device) return;

  const next = await api.voice.token(numberId);
  if (runtime.device !== device || runtime.intentionallyDestroyed) return;
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
    const device = runtime.device;
    try {
      await refreshVoiceToken(numberId);
    } catch (err) {
      if (runtime.device !== device) return;
      setRuntimeState({ error: formatVoiceError(err) });
      scheduleReconnect(numberId);
    }
  }, delay);
}

function replaceForRecovery(numberId: string | undefined): void {
  // Never destroy a live or waiting incoming call just to refresh registration.
  if (runtime.state.active || runtime.state.incoming) return;
  runtime.edgeOffset += 1;
  disposeCurrentDevice(false);
  void initVoiceDevice(numberId, isBrowserSupported());
}

function watchRecovery(numberId: string | undefined): void {
  if (runtime.recoveryTimer || runtime.state.recoveryFailed) return;
  if (runtime.recoveryStartedAt === null) {
    runtime.recoveryStartedAt = Date.now();
    runtime.deviceStartedAt = Date.now();
  }
  runtime.recoveryTimer = setTimeout(() => {
    runtime.recoveryTimer = null;
    if (runtime.intentionallyDestroyed || runtime.state.registered) return;
    if (Date.now() - runtime.recoveryStartedAt! >= MAX_RECOVERY_WINDOW_MS) {
      clearTimer(runtime.reconnectTimer);
      clearTimer(runtime.resumeTimer);
      runtime.reconnectTimer = null;
      runtime.resumeTimer = null;
      if (!runtime.state.active && !runtime.state.incoming) {
        disposeCurrentDevice(false);
        runtime.lastNumberId = numberId;
      }
      setRuntimeState({
        ready: false,
        registered: false,
        recoveryFailed: true,
        error:
          'Voice connection could not recover within 30 seconds. Check Wi-Fi/mobile data or VPN, then tap Reconnect voice. An existing call is not redialed automatically.',
      });
      return;
    }
    if (
      runtime.device &&
      !runtime.currentInit &&
      Date.now() - runtime.deviceStartedAt >= IDLE_RECOVERY_WINDOW_MS &&
      !runtime.state.active &&
      !runtime.state.incoming
    ) {
      replaceForRecovery(numberId);
      return;
    }
    watchRecovery(numberId);
  }, 1_000);
}

function retryVoiceConnection(): void {
  if (runtime.state.active || runtime.state.incoming) return;
  const numberId =
    runtime.lastNumberId ?? runtime.currentInitNumberId ?? runtime.initRetry?.numberId;
  runtime.recoveryStartedAt = null;
  setRuntimeState({ recoveryFailed: false, error: null });
  replaceForRecovery(numberId);
}

function scheduleReconnect(numberId: string | undefined): void {
  if (runtime.intentionallyDestroyed || runtime.state.recoveryFailed || !runtime.device) return;
  watchRecovery(numberId);
  if (runtime.reconnectTimer) return;

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
        if (runtime.device !== device) return;
        setRuntimeState({ error: formatVoiceError(err) });
        scheduleReconnect(numberId);
        return;
      }
    }
    if (runtime.device !== device) return;

    const refreshedState = getDeviceRegistrationState(device);
    if (refreshedState === 'registered' && !runtime.signalingRecoveryPending) {
      markDeviceRegistered();
      return;
    }
    if (refreshedState === 'registering' || runtime.signalingRecoveryPending) {
      scheduleReconnect(numberId);
      return;
    }

    await registerCurrentDevice(numberId);
  }, delay);
}

// scheduleReconnect() needs a Device to recover. When creating one failed
// (e.g. the token request ran before the network was back), retry creation.
function scheduleInitRetry(numberId: string | undefined): void {
  if (
    runtime.intentionallyDestroyed ||
    runtime.state.recoveryFailed ||
    runtime.device ||
    runtime.reconnectTimer
  )
    return;
  watchRecovery(numberId);

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
  if (state === 'registered' && !runtime.signalingRecoveryPending) {
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
  watchRecovery(numberId);
  try {
    await device.register?.();
  } catch (err) {
    if (runtime.device !== device) return;
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
    if (runtime.device === device) runtime.registering = false;
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

async function reconcileCallOutcome(
  prepared: OutboundCallPreparationDto,
  sequence: number,
  attempt = 0,
): Promise<void> {
  const isCurrent = () =>
    runtime.callSequence === sequence && !runtime.state.active && !runtime.state.incoming;
  if (!isCurrent()) return;
  try {
    const call = await api.calls.byOutboundIntent(
      prepared.selectedNumberId,
      prepared.outboundIntentId,
    );
    if (!isCurrent()) return;
    const notices: Record<string, string> = {
      NO_ANSWER: 'No answer. The destination did not answer the call. You can place another call.',
      BUSY: 'The destination is busy or declined the call. You can place another call.',
      CANCELED: 'Call canceled. You can place another call.',
      FAILED:
        'The call failed at the destination or carrier. Check the number before trying again.',
    };
    if (call && notices[call.status]) {
      setRuntimeState({
        callNotice: notices[call.status],
        // A call outcome must not hide a simultaneous network failure.
        ...(call.status === 'FAILED' ||
        runtime.signalingRecoveryPending ||
        runtime.state.recoveryFailed
          ? {}
          : { error: null }),
      });
      return;
    }
    if (call?.status === 'COMPLETED') return;
  } catch {
    // Keep the SDK error if the callback/API cannot confirm the outcome.
  }
  if (isCurrent() && attempt < 3) {
    runtime.outcomeTimer = setTimeout(() => {
      runtime.outcomeTimer = null;
      void reconcileCallOutcome(prepared, sequence, attempt + 1);
    }, 1_500);
  }
}

function attachCallListeners(conn: VoiceCall, prepared?: OutboundCallPreparationDto): void {
  clearTimer(runtime.outcomeTimer);
  runtime.outcomeTimer = null;
  const sequence = ++runtime.callSequence;
  runtime.call = conn;
  void syncScreenWakeLock(true);
  setRuntimeState({
    active: true,
    error: null,
    callNotice: null,
    connectionState: 'pending',
    isMuted: Boolean(conn?.isMuted?.()),
    canSendDigits: callCanSendDigits(conn),
    ...NO_CALL_QUALITY,
  });

  conn.on?.('ringing', () => {
    if (runtime.call === conn) setRuntimeState({ connectionState: 'ringing' });
  });
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
  conn.on?.('accept', () => {
    if (runtime.call !== conn) return;
    setRuntimeState({
      connectionState: 'open',
      active: true,
      error: null,
      canSendDigits: callCanSendDigits(conn),
    });
  });
  const finish = () => {
    if (runtime.call !== conn) return;
    releaseMicrophone();
    void syncScreenWakeLock(false);
    runtime.call = null;
    setRuntimeState({
      connectionState: 'closed',
      active: false,
      isMuted: false,
      canSendDigits: false,
      ...NO_CALL_QUALITY,
    });
    if (prepared) void reconcileCallOutcome(prepared, sequence);
  };
  conn.on?.('disconnect', finish);
  conn.on?.('cancel', finish);
  conn.on?.('reject', finish);
  conn.on?.('transportClose', () => {
    // The SDK can close a not-yet-connected call without emitting disconnect.
    // It updates status just after transportClose; inspect it on the next tick.
    queueMicrotask(() => {
      if (runtime.call === conn && conn.status?.() === 'closed') finish();
    });
  });
  conn.on?.('reconnecting', (err) => {
    if (runtime.call !== conn) return;
    setRuntimeState({
      error: err ? formatVoiceError(err) : 'Call connection lost. Reconnecting…',
    });
  });
  conn.on?.('reconnected', () => {
    if (runtime.call === conn) setRuntimeState({ error: null });
  });
  conn.on?.('error', (err) => {
    if (runtime.call !== conn) return;
    const code = getVoiceErrorCode(err) ?? 0;
    const isDenied = isMicDeniedError(err);
    if (TRANSIENT_SIGNALING_CODES.has(code) && !isCallHangupError(err)) {
      // Keep the call usable (hangup, mute, DTMF) while the SDK restores
      // signaling; the 'disconnect' handler cleans up if recovery fails.
      setRuntimeState({ error: formatVoiceError(err) });
    } else {
      // The SDK can emit error before disconnect. Close it before releasing
      // its input stream, and ignore any later events from this old call.
      try {
        conn.disconnect?.();
      } catch {
        /* already closing */
      }
      finish();
      setRuntimeState({
        ...callErrorState(err),
        active: false,
        connectionState: 'closed',
        canSendDigits: false,
        ...NO_CALL_QUALITY,
        ...(isDenied ? { micPermission: 'denied' as const } : {}),
      });
    }
    if (TOKEN_ERROR_CODES.has(code)) runtime.tokenRejected = true;
    if (RECONNECTABLE_ERROR_CODES.has(code) && !isCallHangupError(err)) {
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

  // Device emits registering/registered. reconnecting/reconnected belong to
  // Call, not Device; tests must follow the SDK's actual event contract.
  device.on('registering', () => {
    if (runtime.device !== device) return;
    markDeviceRegistering();
    watchRecovery(numberId);
  });

  // The SDK can destroy itself (e.g. on page lifecycle events). Only an
  // intentional dispose should leave the softphone without a Device.
  device.on('destroyed', () => {
    if (runtime.device !== device || runtime.intentionallyDestroyed) return;
    disposeCurrentDevice(false);
    void initVoiceDevice(numberId, isBrowserSupported());
  });

  // Twilio's AudioHelper observes Android route changes (for example a
  // Bluetooth headset being connected) more reliably than the browser event.
  device.audio?.on?.('deviceChange', () => void refreshMicrophones());

  device.on('tokenWillExpire', async () => {
    if (runtime.device !== device) return;
    try {
      await refreshVoiceToken(numberId);
    } catch (err) {
      if (runtime.device !== device) return;
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
    const clearIncoming = () => {
      if (runtime.state.incoming?.connection === conn) setRuntimeState({ incoming: null });
    };
    conn.on?.('cancel', clearIncoming);
    conn.on?.('disconnect', clearIncoming);
    conn.on?.('error', (err) => {
      if (runtime.state.incoming?.connection !== conn) return;
      setRuntimeState({ incoming: null, ...callErrorState(err) });
    });
  });

  device.on('error', (err, associatedCall) => {
    if (runtime.device !== device) return;
    if (
      associatedCall &&
      associatedCall !== runtime.call &&
      associatedCall !== runtime.state.incoming?.connection
    )
      return;
    const code = getVoiceErrorCode(err);
    const isDenied = isMicDeniedError(err);
    setRuntimeState({
      ...callErrorState(err),
      ...(isDenied ? { micPermission: 'denied' as const } : {}),
    });
    if (TOKEN_ERROR_CODES.has(code ?? 0)) runtime.tokenRejected = true;
    if (RECONNECTABLE_ERROR_CODES.has(code ?? 0) && !isCallHangupError(err)) {
      runtime.signalingRecoveryPending = true;
      scheduleReconnect(numberId);
    }
  });
}

async function initVoiceDevice(
  numberId: string | undefined,
  browserSupported: boolean,
): Promise<{ identity: string; expiresAt: string } | null> {
  if (runtime.state.recoveryFailed && runtime.lastNumberId === numberId) return null;
  if (!browserSupported) {
    setRuntimeState({
      error: 'This browser does not support WebRTC. Use the latest Chrome, Edge, or Firefox.',
    });
    return null;
  }

  if (runtime.device && runtime.lastNumberId === numberId) {
    const state = getDeviceRegistrationState(runtime.device);
    if (state === 'registered' && !runtime.signalingRecoveryPending) {
      markDeviceRegistered();
    } else if (state !== 'registering' && !runtime.signalingRecoveryPending) {
      void registerCurrentDevice(numberId);
    }
    return runtime.state.identity && runtime.expiresAt
      ? { identity: runtime.state.identity, expiresAt: runtime.expiresAt }
      : null;
  }

  if (runtime.currentInit && runtime.currentInitNumberId === numberId) {
    return runtime.currentInit;
  }

  if (runtime.device || runtime.currentInit || runtime.state.recoveryFailed)
    disposeCurrentDevice(true);
  runtime.currentInitNumberId = numberId;
  const generation = ++runtime.generation;
  runtime.currentInit = (async () => {
    if (runtime.initRetry) {
      clearTimer(runtime.reconnectTimer);
      runtime.reconnectTimer = null;
      runtime.initRetry = null;
    }
    runtime.intentionallyDestroyed = false;
    runtime.deviceStartedAt = Date.now();
    setRuntimeState({
      ready: false,
      registered: false,
      incoming: null,
      active: false,
      connectionState: 'idle',
      error: null,
    });
    watchRecovery(numberId);

    try {
      const tokenPromise = api.voice.token(numberId);
      const sdkPromise = (voiceSdkPromise ??= import('@twilio/voice-sdk').catch((err: unknown) => {
        voiceSdkPromise = null;
        throw err;
      }));
      const configPromise = api.voice.deviceConfig();
      const [tokenResp, sdk, config] = await Promise.all([tokenPromise, sdkPromise, configPromise]);
      if (runtime.generation !== generation) return null;
      const typedSdk = sdk as {
        Device?: VoiceDeviceConstructor;
        default?: VoiceDeviceConstructor;
      };
      const Device = typedSdk.Device ?? typedSdk.default;
      if (!Device) throw new Error('Twilio Voice SDK Device export was not found');

      const options = sanitizeDeviceConfig(config);
      if (Array.isArray(options.edge)) {
        const edges = options.edge as string[];
        const offset = runtime.edgeOffset % edges.length;
        options.edge = [...edges.slice(offset), ...edges.slice(0, offset)];
      }
      const device = new Device(tokenResp.token, options);
      runtime.device = device;
      if (device.audio && typeof device.audio.setAudioConstraints === 'function') {
        try {
          await device.audio.setAudioConstraints(DEFAULT_AUDIO_CONSTRAINTS);
        } catch {
          // ignore
        }
      }
      if (runtime.generation !== generation) return null;
      runtime.lastNumberId = numberId;
      runtime.expiresAt = tokenResp.expiresAt;
      runtime.intentionallyDestroyed = false;
      attachDeviceListeners(device, numberId);
      setRuntimeState({ identity: tokenResp.identity });
      scheduleTokenRefresh(tokenResp.expiresAt, numberId);
      void registerCurrentDevice(numberId);
      return { identity: tokenResp.identity, expiresAt: tokenResp.expiresAt };
    } catch (err) {
      if (runtime.generation !== generation) return null;
      setRuntimeState({ error: formatVoiceError(err) });
      if (runtime.device) scheduleReconnect(numberId);
      else scheduleInitRetry(numberId);
      return null;
    } finally {
      if (runtime.generation === generation) {
        runtime.currentInit = null;
        runtime.currentInitNumberId = undefined;
      }
    }
  })();

  return runtime.currentInit;
}

async function makeVoiceCall(
  selectedNumberId: string,
  destinationNumber: string,
  options: MakeCallOptions = {},
): Promise<VoiceCall | null> {
  if (runtime.call || runtime.state.active || runtime.state.incoming) return null;
  if (runtime.signalingRecoveryPending || runtime.state.recoveryFailed) return null;
  clearTimer(runtime.outcomeTimer);
  runtime.outcomeTimer = null;
  runtime.callSequence += 1;
  setRuntimeState({ error: null, callNotice: null });
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
        'Voice device could not initialize with Twilio. Check the connection status and retry.',
    });
    scheduleReconnect(selectedNumberId);
    return null;
  }
  if (!runtime.state.registered || runtime.signalingRecoveryPending) {
    setRuntimeState({
      error: 'The voice connection is not ready. Wait for Registered or tap Reconnect voice.',
    });
    return null;
  }
  const generation = runtime.generation;

  let prepared;
  try {
    prepared = await api.voice.prepareOutbound(
      selectedNumberId,
      destinationNumber,
      options.recordCall,
    );
  } catch (err) {
    if (runtime.generation !== generation) return null;
    setRuntimeState({ error: err instanceof Error ? err.message : String(err) });
    return null;
  }
  if (runtime.generation !== generation || runtime.signalingRecoveryPending) return null;
  options.onPrepared?.(prepared);

  const device = await ensureDeviceForOutbound(prepared.selectedNumberId, prepared.identity);
  if (!device) {
    setRuntimeState({
      error:
        'Voice device could not initialize with Twilio. Check the connection status and retry.',
    });
    scheduleReconnect(prepared.selectedNumberId);
    return null;
  }

  try {
    const audio = await prepareCallAudio(device);
    if (runtime.device !== device) return null;
    if (runtime.signalingRecoveryPending) {
      releaseMicrophone();
      return null;
    }
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
    if (runtime.device !== device) {
      conn.disconnect?.();
      return null;
    }
    attachCallListeners(conn, prepared);
    return conn;
  } catch (err) {
    if (runtime.device !== device) return null;
    const isDenied = isMicDeniedError(err);
    releaseMicrophone();
    setRuntimeState({
      ...callErrorState(err),
      ...(isDenied ? { micPermission: 'denied' as const } : {}),
    });
    if (RECONNECTABLE_ERROR_CODES.has(getVoiceErrorCode(err) ?? 0) && !isCallHangupError(err)) {
      runtime.signalingRecoveryPending = true;
      scheduleReconnect(prepared.selectedNumberId);
    }
    return null;
  }
}

async function acceptIncomingCall(): Promise<void> {
  const conn = runtime.state.incoming?.connection;
  const device = runtime.device;
  if (!conn) return;
  if (!device) {
    setRuntimeState({
      error: 'The Chrome voice device is no longer available. Refresh the page and try again.',
    });
    return;
  }
  if (runtime.state.micPermission === 'denied') {
    setRuntimeState({
      error:
        'Microphone permission was denied (31401). The browser or user blocked microphone access. Please allow microphone permissions in your browser settings (click the lock or tune icon next to the address bar) and try again.',
    });
    return;
  }
  try {
    const audio = await prepareCallAudio(device);
    // The caller may have hung up while the devices were being listed.
    if (runtime.state.incoming?.connection !== conn) {
      if (!runtime.call) releaseMicrophone();
      return;
    }
    attachCallListeners(conn);
    conn.accept?.({ audioConstraints: audio, rtcConstraints: { audio } });
    setRuntimeState({ incoming: null });
  } catch (err) {
    const isDenied = isMicDeniedError(err);
    if (runtime.call === conn) hangupCall();
    else releaseMicrophone();
    setRuntimeState({
      ...callErrorState(err),
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
    void syncScreenWakeLock(false);
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
    releaseMicrophone();
    void syncScreenWakeLock(false);
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
    try {
      await refreshMicrophones();
    } finally {
      stream.getTracks().forEach((track) => track.stop());
    }
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
  replaceForRecovery(runtime.lastNumberId);
}

function recoverNow(): void {
  if (runtime.state.recoveryFailed && document.visibilityState !== 'hidden') {
    retryVoiceConnection();
    return;
  }
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
  // General safety net: if the Voice SDK ever emits an unhandled rejection with
  // a reconnectable error code, recover gracefully instead of surfacing it to
  // the user. SDK 2.18.5 fixes a false token error after signaling drops, but
  // retain the handler as a safety net for other reconnectable SDK failures.
  window.addEventListener('unhandledrejection', (event) => {
    const code = getVoiceErrorCode(event.reason);
    if (
      !code ||
      !RECONNECTABLE_ERROR_CODES.has(code) ||
      !runtime.device ||
      isCallHangupError(event.reason)
    )
      return;
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
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && runtime.wakeLockWanted) {
        void syncScreenWakeLock(true);
      } else if (document.visibilityState !== 'visible') {
        releaseScreenWakeLock();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  useEffect(() => {
    try {
      setRuntimeState({
        selectedMicrophoneId: window.localStorage.getItem(MICROPHONE_STORAGE_KEY) ?? '',
      });
    } catch {
      /* session only */
    }
    void refreshMicrophones();
    const onChange = () => {
      void refreshMicrophones();
    };
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', onChange);
  }, []);

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
    retryConnection: retryVoiceConnection,
    browserSupported,
    accept: acceptIncomingCall,
    reject: rejectIncomingCall,
    hangup: hangupCall,
    toggleMute,
    sendDigits: sendDtmfDigits,
    makeCall: makeVoiceCall,
    requestMicPermission: requestMicrophonePermission,
    refreshMicrophones,
    selectMicrophone,
    wakeLockHeld: snapshot.wakeLockHeld,
    wakeLockSupported: Boolean(wakeLockApi()),
  };
}
