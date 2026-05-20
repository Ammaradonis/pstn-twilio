import { io, type Socket } from 'socket.io-client';

import { getToken } from './api-client';
import { env } from './env';

let socketInstance: Socket | null = null;

export function getSocket(): Socket {
  if (socketInstance) return socketInstance;
  socketInstance = io(env.VITE_WS_URL, {
    transports: ['websocket', 'polling'],
    autoConnect: true,
    // Lazy auth: re-read the token on every connection attempt, so reconnects
    // pick up a token that was set after the socket was first created.
    auth: (cb) => {
      const token = getToken();
      cb(token ? { token } : {});
    },
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
