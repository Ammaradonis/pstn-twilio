import { afterEach, describe, expect, it } from 'vitest';

import { AUTH_EXPIRED_EVENT, getToken } from './api-client';
import { useAuthStore } from './auth-store';

const sampleUser = {
  id: 'u1',
  email: 'owner@example.com',
  role: 'OWNER' as const,
  createdAt: new Date().toISOString(),
  lastLoginAt: null,
};

afterEach(() => {
  useAuthStore.setState({
    user: null,
    token: null,
    status: 'unauthenticated',
    error: null,
  });
  window.localStorage.clear();
});

describe('useAuthStore', () => {
  it('starts unauthenticated with no token or user', () => {
    const state = useAuthStore.getState();
    expect(state.token).toBeNull();
    expect(state.user).toBeNull();
    expect(state.status).toBe('unauthenticated');
  });

  it('setSession persists the token via api-client setToken and flips status', () => {
    useAuthStore.getState().setSession('jwt-abc', sampleUser);
    const state = useAuthStore.getState();
    expect(state.token).toBe('jwt-abc');
    expect(state.user).toEqual(sampleUser);
    expect(state.status).toBe('authenticated');
    expect(getToken()).toBe('jwt-abc');
  });

  it('logout clears the token from localStorage and resets the store', () => {
    useAuthStore.getState().setSession('jwt-abc', sampleUser);
    useAuthStore.getState().logout();
    const state = useAuthStore.getState();
    expect(state.token).toBeNull();
    expect(state.user).toBeNull();
    expect(state.status).toBe('unauthenticated');
    expect(getToken()).toBeNull();
  });

  it('clears the session when the API client reports an expired auth token', () => {
    useAuthStore.getState().setSession('jwt-abc', sampleUser);

    window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));

    const state = useAuthStore.getState();
    expect(state.token).toBeNull();
    expect(state.user).toBeNull();
    expect(state.status).toBe('unauthenticated');
    expect(getToken()).toBeNull();
  });
});
