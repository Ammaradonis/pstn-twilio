import { useEffect, useState } from 'react';

import { useAuthStore } from '../lib/auth-store';
import { getSocket } from '../lib/realtime';

export type SocketStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

// A socket that drops and comes straight back (tab switch, brief network blip)
// shows as reconnecting; it is only reported down if it stays down this long.
const DISCONNECTED_GRACE_MS = 8_000;

export function useSocketStatus(): SocketStatus {
  const { token } = useAuthStore();
  const [status, setStatus] = useState<SocketStatus>('idle');

  useEffect(() => {
    if (!token) {
      setStatus('idle');
      return;
    }
    const socket = getSocket();
    setStatus(socket.connected ? 'connected' : 'connecting');

    let downTimer: ReturnType<typeof setTimeout> | null = null;
    const clearDownTimer = () => {
      if (downTimer) clearTimeout(downTimer);
      downTimer = null;
    };

    const onConnect = () => {
      clearDownTimer();
      setStatus('connected');
    };
    const onDrop = (reason?: unknown) => {
      // `active` is false once the client has given up reconnecting, e.g. after
      // the server rejected its auth. A client-side disconnect is the app
      // cycling the socket, which reconnects immediately.
      if (!socket.active && reason !== 'io client disconnect') {
        clearDownTimer();
        setStatus('disconnected');
        return;
      }
      setStatus((prev) => (prev === 'disconnected' ? prev : 'connecting'));
      if (downTimer) return;
      downTimer = setTimeout(() => {
        downTimer = null;
        if (!socket.connected) setStatus('disconnected');
      }, DISCONNECTED_GRACE_MS);
    };
    socket.on('connect', onConnect);
    socket.on('disconnect', onDrop);
    socket.on('connect_error', onDrop);
    return () => {
      clearDownTimer();
      socket.off('connect', onConnect);
      socket.off('disconnect', onDrop);
      socket.off('connect_error', onDrop);
    };
  }, [token]);

  return status;
}
