import { io, type Socket } from 'socket.io-client';

import { getToken } from './api-client';
import { env } from './env';

let socketInstance: Socket | null = null;

export function getSocket(): Socket {
  if (socketInstance && socketInstance.connected) return socketInstance;
  const token = getToken();
  socketInstance = io(env.VITE_WS_URL, {
    transports: ['websocket', 'polling'],
    autoConnect: true,
    auth: token ? { token } : undefined,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
  });
  return socketInstance;
}

export function closeSocket(): void {
  if (socketInstance) {
    socketInstance.disconnect();
    socketInstance = null;
  }
}
