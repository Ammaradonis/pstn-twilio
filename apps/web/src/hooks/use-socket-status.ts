import { useEffect, useState } from 'react';

import { useAuthStore } from '../lib/auth-store';
import { getSocket } from '../lib/realtime';

export type SocketStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

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

    const onConnect = () => setStatus('connected');
    const onDisconnect = () => setStatus('disconnected');
    const onError = () => setStatus('disconnected');
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onError);
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onError);
    };
  }, [token]);

  return status;
}
