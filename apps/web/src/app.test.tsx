import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './app';
import { api, ApiError } from './lib/api-client';
import type * as ApiClientModule from './lib/api-client';
import { useAuthStore } from './lib/auth-store';
import { ToastProvider } from './lib/toast';

const apiMocks = vi.hoisted(() => ({
  authMe: vi.fn(),
  numbersList: vi.fn(),
}));

vi.mock('./lib/realtime', () => ({
  getSocket: () => ({
    on: vi.fn(),
    off: vi.fn(),
    connected: false,
  }),
  closeSocket: vi.fn(),
  refreshSocketAuth: vi.fn(),
}));

vi.mock('./lib/api-client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('./lib/api-client');
  return {
    ...actual,
    api: {
      ...actual.api,
      health: Object.assign(
        () => Promise.resolve({ status: 'ok', checks: {}, uptimeSeconds: 0, timestamp: '' }),
        {
          db: () => Promise.resolve({ status: 'ok', checks: {}, uptimeSeconds: 0, timestamp: '' }),
          redis: () =>
            Promise.resolve({ status: 'ok', checks: {}, uptimeSeconds: 0, timestamp: '' }),
          twilio: () =>
            Promise.resolve({ status: 'ok', checks: {}, uptimeSeconds: 0, timestamp: '' }),
        },
      ),
      auth: {
        ...actual.api.auth,
        me: apiMocks.authMe,
      },
      numbers: {
        ...actual.api.numbers,
        list: apiMocks.numbersList,
      },
      messages: {
        ...actual.api.messages,
        search: () => Promise.resolve([]),
      },
    },
  };
});

function renderWith(initialPath: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <App />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiMocks.authMe.mockReset();
  apiMocks.authMe.mockResolvedValue({
    id: 'u1',
    email: 'owner@example.com',
    role: 'OWNER' as const,
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
  });
  apiMocks.numbersList.mockReset();
  apiMocks.numbersList.mockResolvedValue([]);
  useAuthStore.setState({
    user: null,
    token: null,
    status: 'unauthenticated',
    error: null,
  });
});

afterEach(() => {
  useAuthStore.setState({
    user: null,
    token: null,
    status: 'unauthenticated',
    error: null,
  });
});

describe('App routing', () => {
  it('renders the login page when no auth token is present and the user hits /dashboard', () => {
    renderWith('/dashboard');
    expect(screen.getByRole('heading', { name: /sign in/i })).toBeInTheDocument();
  });

  it('renders the dashboard for an authenticated session', async () => {
    useAuthStore.setState({
      token: 'fake-token',
      user: {
        id: 'u1',
        email: 'owner@example.com',
        role: 'OWNER',
        createdAt: new Date().toISOString(),
        lastLoginAt: null,
      },
      status: 'authenticated',
    });
    renderWith('/dashboard');
    expect(await screen.findByRole('heading', { name: /dashboard/i })).toBeInTheDocument();
    expect(api.auth.me).toHaveBeenCalledTimes(1);
  });

  it('logs out stale restored sessions before protected number queries run', async () => {
    apiMocks.authMe.mockRejectedValueOnce(new ApiError(401, 'Unauthorized'));
    useAuthStore.setState({
      token: 'expired-token',
      user: {
        id: 'u1',
        email: 'owner@example.com',
        role: 'OWNER',
        createdAt: new Date().toISOString(),
        lastLoginAt: null,
      },
      status: 'authenticated',
    });

    renderWith('/dashboard');

    expect(await screen.findByRole('heading', { name: /sign in/i })).toBeInTheDocument();
    expect(api.auth.me).toHaveBeenCalledTimes(1);
    expect(api.numbers.list).not.toHaveBeenCalled();
    expect(useAuthStore.getState().token).toBeNull();
  });

  it('renders the not-found page for unknown routes', () => {
    renderWith('/this-does-not-exist');
    expect(screen.getByRole('heading', { name: /not found/i })).toBeInTheDocument();
  });
});
