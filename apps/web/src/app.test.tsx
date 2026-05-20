import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './app';
import type * as ApiClientModule from './lib/api-client';
import { useAuthStore } from './lib/auth-store';
import { ToastProvider } from './lib/toast';

vi.mock('./lib/realtime', () => ({
  getSocket: () => ({
    on: vi.fn(),
    off: vi.fn(),
    connected: false,
  }),
  closeSocket: vi.fn(),
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
        me: () =>
          Promise.resolve({
            id: 'u1',
            email: 'owner@example.com',
            role: 'OWNER' as const,
            createdAt: new Date().toISOString(),
            lastLoginAt: null,
          }),
      },
      numbers: {
        ...actual.api.numbers,
        list: () => Promise.resolve([]),
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
  });

  it('renders the not-found page for unknown routes', () => {
    renderWith('/this-does-not-exist');
    expect(screen.getByRole('heading', { name: /not found/i })).toBeInTheDocument();
  });
});
