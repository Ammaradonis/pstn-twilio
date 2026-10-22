import type { MetaAdFilterResultDto, MetaAdsStatusDto } from '@pstn-twilio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../lib/api-client';

import { MetaAdFilterButton } from './meta-ad-filter-button';

vi.mock('../lib/api-client', () => ({
  api: { metaAds: { status: vi.fn(), filter: vi.fn() } },
}));

const STATUS: MetaAdsStatusDto = {
  spreadsheetId: 'sheet-1',
  sheetTitle: 'Texas',
  active: 23,
  past: 31,
  both: 8,
  matched: 46,
  evidence: 60,
  lastObservedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
  freshDays: 30,
};

const RESULT: MetaAdFilterResultDto = {
  spreadsheetId: 'sheet-1',
  sourceSheetTitle: 'Texas',
  tabTitle: 'Meta ads - running now - Texas',
  reused: false,
  mode: 'ACTIVE',
  rows: 23,
  sourceRows: 340,
  staleRows: 2,
  orphaned: 0,
  createdAt: new Date().toISOString(),
};

function renderButton() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MetaAdFilterButton spreadsheetId="sheet-1" sheetTitle="Texas" />
    </QueryClientProvider>,
  );
}

describe('the Meta ad filter button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.metaAds.status).mockResolvedValue(STATUS);
    vi.mocked(api.metaAds.filter).mockResolvedValue(RESULT);
  });

  it('shows what it knows and filters for "still advertising now" by default', async () => {
    renderButton();
    expect(await screen.findByText(/23 advertising now/)).toBeInTheDocument();
    expect(screen.getByText(/31 have advertised/)).toBeInTheDocument();
    expect(screen.getByLabelText('Meta ad filter')).toHaveValue('ACTIVE');

    fireEvent.click(screen.getByRole('button', { name: 'Meta ad filter' }));

    await waitFor(() =>
      expect(api.metaAds.filter).toHaveBeenCalledWith('sheet-1', 'Texas', 'ACTIVE'),
    );
    expect(
      await screen.findByText(/Added “Meta ads - running now - Texas” with 23 of 340 rows/),
    ).toBeInTheDocument();
    // Matches that only an older check supports are never claimed as running now.
    expect(screen.getByText(/2 more matched only an older check/)).toBeInTheDocument();
  });

  it('offers the past filter as a separate choice', async () => {
    renderButton();
    await screen.findByText(/23 advertising now/);
    fireEvent.change(screen.getByLabelText('Meta ad filter'), { target: { value: 'PAST' } });
    vi.mocked(api.metaAds.filter).mockResolvedValue({
      ...RESULT,
      mode: 'PAST',
      tabTitle: 'Meta ads - ran in the past - Texas',
      rows: 31,
      staleRows: 0,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Meta ad filter' }));

    await waitFor(() =>
      expect(api.metaAds.filter).toHaveBeenCalledWith('sheet-1', 'Texas', 'PAST'),
    );
    expect(await screen.findByText(/Meta ads - ran in the past - Texas/)).toBeInTheDocument();
  });

  it('says the worker has not reported anything yet instead of offering a guess', async () => {
    vi.mocked(api.metaAds.status).mockResolvedValue({
      ...STATUS,
      active: 0,
      past: 0,
      both: 0,
      matched: 0,
      evidence: 0,
      lastObservedAt: null,
    });
    renderButton();
    expect(
      await screen.findByText(/No Meta matches reported for this tab yet/),
    ).toBeInTheDocument();
    // No counts line, because there is nothing verified to count.
    expect(screen.queryByText(/last checked/)).not.toBeInTheDocument();
  });

  it('surfaces the API explanation when the filter cannot run', async () => {
    vi.mocked(api.metaAds.filter).mockRejectedValue(
      new Error('The Meta ads worker has not reported any matches for "Texas" yet.'),
    );
    renderButton();
    await screen.findByText(/23 advertising now/);
    fireEvent.click(screen.getByRole('button', { name: 'Meta ad filter' }));
    expect(await screen.findByText(/has not reported any matches/)).toBeInTheDocument();
  });
});
