import type { SheetsSequenceWorkbookDto } from '@pstn-twilio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../lib/api-client';

import { SettingsSheets } from './settings-sheets';

vi.mock('../lib/api-client', () => ({
  api: {
    sheets: {
      status: vi.fn(),
      sequences: vi.fn(),
      followUps: vi.fn().mockResolvedValue([]),
      connectUrl: vi.fn(),
      disconnect: vi.fn(),
      cancelFollowUp: vi.fn(),
      timezoneCheck: vi.fn(),
      followUpMessage: vi.fn(),
      markFollowUpSent: vi.fn(),
    },
  },
}));

const connected = {
  connected: true,
  email: 'ammar.webalchemist@gmail.com',
  configured: true,
  missing: [],
  needsReconnect: false,
  problem: null,
};

const workbook = (overrides: Partial<SheetsSequenceWorkbookDto>): SheetsSequenceWorkbookDto => ({
  region: 'US',
  expectedName: 'U.S. Conquest',
  spreadsheetId: 'us-id',
  googleName: 'U.S. Conquest',
  matches: true,
  suggestedId: null,
  demoNumber: '(667) 220-6726',
  error: null,
  ...overrides,
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SettingsSheets />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SettingsSheets', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows which workbook each sequence is tied to, and a wrong ID', async () => {
    vi.mocked(api.sheets.status).mockResolvedValue(connected);
    vi.mocked(api.sheets.sequences).mockResolvedValue([
      workbook({}),
      workbook({
        region: 'UK',
        expectedName: 'The Official UK',
        spreadsheetId: 'old-id',
        googleName: 'Old UK leads',
        matches: false,
        suggestedId: 'real-uk-id',
        demoNumber: '02045726501',
      }),
    ]);
    renderPage();
    expect(
      await screen.findByText('U.S. Conquest → US emails, demo line (667) 220-6726'),
    ).toBeInTheDocument();
    expect(screen.getByText(/which Google names “U.S. Conquest”/)).toBeInTheDocument();
    expect(
      screen.getByText('The Official UK → UK emails, demo line 02045726501'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/is "Old UK leads" in Google, not "The Official UK"/),
    ).toBeInTheDocument();
    expect(screen.getByText('real-uk-id')).toBeInTheDocument();
    expect(screen.getByText('UK_OFFICIAL_SHEET_ID')).toBeInTheDocument();
  });

  it('asks to reconnect when Google no longer accepts the saved access', async () => {
    vi.mocked(api.sheets.status).mockResolvedValue({
      ...connected,
      needsReconnect: true,
      problem: 'Google access was revoked or expired.',
    });
    renderPage();
    expect(await screen.findByRole('button', { name: 'Reconnect Google' })).toBeInTheDocument();
    expect(screen.getByText('Google access was revoked or expired.')).toBeInTheDocument();
    expect(api.sheets.sequences).not.toHaveBeenCalled();
  });
});
