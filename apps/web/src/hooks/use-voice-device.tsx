import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../lib/api-client';

type ConnectionState = 'idle' | 'pending' | 'ringing' | 'open' | 'closed';

type VoiceEventHandler = (...args: never[]) => void | Promise<void>;

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
  on: (event: string, handler: VoiceEventHandler) => void;
  register?: () => Promise<void> | void;
  destroy?: () => void;
  disconnectAll?: () => void;
  updateToken?: (token: string) => void;
  connect: (options: {
    params: { selectedNumberId: string; destinationNumber: string };
  }) => VoiceCall | Promise<VoiceCall>;
};

type VoiceDeviceConstructor = new (token: string, options: unknown) => VoiceDevice;

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>).then === 'function';
}

type IncomingCall = {
  connection: VoiceCall;
  from?: string;
};

interface UseVoiceDevice {
  init: (numberId?: string) => Promise<{ identity: string; expiresAt: string } | null>;
  destroy: () => void;
  ready: boolean;
  registered: boolean;
  incoming: IncomingCall | null;
  active: boolean;
  connectionState: ConnectionState;
  identity: string | null;
  error: string | null;
  isMuted: boolean;
  micPermission: 'unknown' | 'granted' | 'denied' | 'prompt';
  browserSupported: boolean;
  accept: () => void;
  reject: () => void;
  hangup: () => void;
  toggleMute: () => void;
  makeCall: (
    selectedNumberId: string,
    destinationNumber: string,
  ) => VoiceCall | Promise<VoiceCall> | null;
}

function isBrowserSupported(): boolean {
  if (typeof window === 'undefined') return false;
  if (!window.RTCPeerConnection) return false;
  if (!navigator.mediaDevices?.getUserMedia) return false;
  return true;
}

export function useVoiceDevice(): UseVoiceDevice {
  const deviceRef = useRef<VoiceDevice | null>(null);
  const callRef = useRef<VoiceCall | null>(null);
  const tokenRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastNumberIdRef = useRef<string | undefined>(undefined);

  const [ready, setReady] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [incoming, setIncoming] = useState<IncomingCall | null>(null);
  const [active, setActive] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [identity, setIdentity] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [micPermission, setMicPermission] = useState<UseVoiceDevice['micPermission']>('unknown');
  const [browserSupported] = useState<boolean>(isBrowserSupported);

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

  const destroy = useCallback(() => {
    if (tokenRefreshTimerRef.current) {
      clearTimeout(tokenRefreshTimerRef.current);
      tokenRefreshTimerRef.current = null;
    }
    try {
      deviceRef.current?.destroy?.();
    } catch {
      /* noop */
    }
    deviceRef.current = null;
    callRef.current = null;
    setReady(false);
    setRegistered(false);
    setActive(false);
    setIncoming(null);
    setIdentity(null);
    setConnectionState('idle');
    setIsMuted(false);
  }, []);

  useEffect(() => destroy, [destroy]);

  const attachCallListeners = useCallback((conn: VoiceCall) => {
    callRef.current = conn;
    setActive(true);
    setConnectionState('pending');
    setIsMuted(Boolean(conn?.isMuted?.()));

    conn.on?.('ringing', () => setConnectionState('ringing'));
    conn.on?.('accept', () => {
      setConnectionState('open');
      setActive(true);
    });
    conn.on?.('disconnect', () => {
      setConnectionState('closed');
      setActive(false);
      setIsMuted(false);
      callRef.current = null;
    });
    conn.on?.('cancel', () => {
      setConnectionState('closed');
      setActive(false);
      callRef.current = null;
    });
    conn.on?.('reject', () => {
      setConnectionState('closed');
      setActive(false);
      callRef.current = null;
    });
    conn.on?.('error', (e: Error) => setError(e?.message ?? String(e)));
  }, []);

  const scheduleTokenRefresh = useCallback((expiresAt: string, numberId?: string) => {
    if (tokenRefreshTimerRef.current) clearTimeout(tokenRefreshTimerRef.current);
    const expiresMs = new Date(expiresAt).getTime() - Date.now();
    // refresh 60s before expiry, but never less than 5s and never more than 50min
    const delay = Math.max(5_000, Math.min(expiresMs - 60_000, 50 * 60_000));
    tokenRefreshTimerRef.current = setTimeout(async () => {
      try {
        const next = await api.voice.token(numberId);
        deviceRef.current?.updateToken?.(next.token);
        scheduleTokenRefresh(next.expiresAt, numberId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }, delay);
  }, []);

  const init = useCallback(
    async (numberId?: string) => {
      if (!browserSupported) {
        setError('This browser does not support WebRTC. Use the latest Chrome, Edge, or Firefox.');
        return null;
      }
      if (deviceRef.current && lastNumberIdRef.current === numberId) {
        return identity ? { identity, expiresAt: '' } : null;
      }
      try {
        destroy();
        const tokenResp = await api.voice.token(numberId);
        const sdk = (await import('@twilio/voice-sdk')) as unknown as {
          Device?: VoiceDeviceConstructor;
          default?: VoiceDeviceConstructor;
        };
        const Device = sdk.Device ?? sdk.default;
        if (!Device) throw new Error('Twilio Voice SDK Device export was not found');
        const config = await api.voice.deviceConfig();
        const device = new Device(tokenResp.token, config);
        deviceRef.current = device;
        lastNumberIdRef.current = numberId;
        setIdentity(tokenResp.identity);

        device.on('registered', () => {
          setRegistered(true);
          setReady(true);
        });
        device.on('unregistered', () => setRegistered(false));
        device.on('tokenWillExpire', async () => {
          try {
            const next = await api.voice.token(numberId);
            device.updateToken?.(next.token);
            scheduleTokenRefresh(next.expiresAt, numberId);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        });
        device.on('incoming', (conn: VoiceCall) => {
          setIncoming({
            connection: conn,
            from: (conn.parameters?.From as string) ?? undefined,
          });
          conn.on?.('cancel', () => setIncoming(null));
          conn.on?.('disconnect', () => setIncoming(null));
        });
        device.on('error', (e: Error) => setError(e?.message ?? String(e)));

        await device.register?.();
        scheduleTokenRefresh(tokenResp.expiresAt, numberId);
        return { identity: tokenResp.identity, expiresAt: tokenResp.expiresAt };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        return null;
      }
    },
    [browserSupported, destroy, identity, scheduleTokenRefresh],
  );

  const accept = useCallback(() => {
    const conn = incoming?.connection;
    if (!conn) return;
    try {
      attachCallListeners(conn);
      conn.accept?.();
      setIncoming(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [incoming, attachCallListeners]);

  const reject = useCallback(() => {
    const conn = incoming?.connection;
    if (!conn) return;
    try {
      conn.reject?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIncoming(null);
    }
  }, [incoming]);

  const makeCall = useCallback(
    (selectedNumberId: string, destinationNumber: string) => {
      const device = deviceRef.current;
      if (!device) {
        setError('Voice device is not initialized');
        return null;
      }
      try {
        const result = device.connect({
          params: { selectedNumberId, destinationNumber },
        });
        if (isPromiseLike(result)) {
          result
            .then((conn) => attachCallListeners(conn))
            .catch((err) => setError(err instanceof Error ? err.message : String(err)));
        } else if (result) {
          attachCallListeners(result);
        }
        return result;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [attachCallListeners],
  );

  const hangup = useCallback(() => {
    try {
      callRef.current?.disconnect?.();
      deviceRef.current?.disconnectAll?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActive(false);
      setIsMuted(false);
      setConnectionState('closed');
      callRef.current = null;
    }
  }, []);

  const toggleMute = useCallback(() => {
    const conn = callRef.current;
    if (!conn) return;
    try {
      const next = !conn.isMuted?.();
      conn.mute?.(next);
      setIsMuted(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return {
    init,
    destroy,
    ready,
    registered,
    incoming,
    active,
    connectionState,
    identity,
    error,
    isMuted,
    micPermission,
    browserSupported,
    accept,
    reject,
    hangup,
    toggleMute,
    makeCall,
  };
}
