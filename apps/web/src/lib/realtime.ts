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
  installResumeListeners();
  return socketInstance;
}

let resumeListenersInstalled = false;

// Back in the tab or back online: reconnect now instead of waiting out the
// reconnection backoff, which grows while a hidden tab keeps failing.
function reconnectNow(): void {
  if (!socketInstance || socketInstance.connected) return;
  if (document.visibilityState === 'hidden') return;
  socketInstance.disconnect();
  socketInstance.connect();
}

function installResumeListeners(): void {
  if (resumeListenersInstalled || typeof window === 'undefined') return;
  resumeListenersInstalled = true;
  window.addEventListener('online', reconnectNow);
  window.addEventListener('pageshow', reconnectNow);
  document.addEventListener('visibilitychange', reconnectNow);
}

export function closeSocket(): void {
  if (socketInstance) {
    socketInstance.disconnect();
    socketInstance = null;
  }
}

// Call when the auth token changes (login / logout / refresh). Cycles the live
// socket so the next handshake picks up the new token via the lazy auth callback.
export function refreshSocketAuth(): void {
  if (!socketInstance) return;
  socketInstance.disconnect();
  socketInstance.connect();
}
