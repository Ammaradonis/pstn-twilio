import type { UserDto } from '@pstn-twilio/shared';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import { AUTH_EXPIRED_EVENT, setToken } from './api-client';
import { closeSocket, refreshSocketAuth } from './realtime';

interface AuthState {
  user: UserDto | null;
  token: string | null;
  status: 'unauthenticated' | 'loading' | 'authenticated';
  error: string | null;
  setSession: (token: string, user: UserDto) => void;
  setUser: (user: UserDto | null) => void;
  setStatus: (status: AuthState['status']) => void;
  setError: (error: string | null) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      status: 'unauthenticated',
      error: null,
      setSession: (token, user) => {
        setToken(token);
        set({ token, user, status: 'authenticated', error: null });
        refreshSocketAuth();
      },
      setUser: (user) => set({ user }),
      setStatus: (status) => set({ status }),
      setError: (error) => set({ error }),
      logout: () => {
        setToken(null);
        set({ token: null, user: null, status: 'unauthenticated', error: null });
        closeSocket();
      },
    }),
    {
      name: 'pstn-twilio.auth',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ token: s.token, user: s.user }),
      onRehydrateStorage: () => (state) => {
        if (state?.token) {
          setToken(state.token);
          state.status = 'authenticated';
          refreshSocketAuth();
        }
      },
    },
  ),
);

if (typeof window !== 'undefined') {
  window.addEventListener(AUTH_EXPIRED_EVENT, () => {
    const { token, logout } = useAuthStore.getState();
    if (token) logout();
  });
}
